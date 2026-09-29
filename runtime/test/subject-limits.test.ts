/**
 * Subject limits: the turn bucket refills continuously and never charges past its capacity;
 * concurrent turns count only sessions with work in flight, never `paused` ones.
 */
import { describe, expect, it } from "vitest";
import { MemorySessionStore } from "../src/store/memory.js";
import { chargeTurn } from "../src/tenant/subject-limits.js";
import { HttpError } from "../src/tenant/http.js";

const HOUR = 3_600_000;

function store() {
  return new MemorySessionStore({ tenantId: "tn_limits" });
}

async function charge(
  s: MemorySessionStore,
  subject: string,
  limits: Parameters<typeof chargeTurn>[2],
  now: number
): Promise<"ok" | HttpError> {
  try {
    await s.tx((t) => chargeTurn(t, subject, limits, now));
    return "ok";
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
}

describe("turns per hour", () => {
  it("allows the capacity at once, then refills one turn per hour / capacity", async () => {
    const s = store();
    const t0 = Date.parse("2026-09-29T10:00:00Z");
    const limits = { turnsPerHour: 4 };
    for (let n = 0; n < 4; n += 1) expect(await charge(s, "app:a", limits, t0)).toBe("ok");
    const refused = await charge(s, "app:a", limits, t0);
    expect(refused).toBeInstanceOf(HttpError);
    const error = refused as HttpError;
    expect(error.status).toBe(429);
    expect(error.rejection).toMatchObject({
      code: "limit_exceeded",
      details: { limit: "turnsPerHour", retryAfterSeconds: 900 },
    });
    expect(error.headers["retry-after"]).toBe("900");
    // A quarter hour later one turn is back, not more.
    expect(await charge(s, "app:a", limits, t0 + HOUR / 4)).toBe("ok");
    expect(await charge(s, "app:a", limits, t0 + HOUR / 4)).toBeInstanceOf(HttpError);
    // Other subjects have their own bucket.
    expect(await charge(s, "app:b", limits, t0)).toBe("ok");
  });

  it("never refills past capacity", async () => {
    const s = store();
    const t0 = Date.parse("2026-09-29T10:00:00Z");
    const limits = { turnsPerHour: 2 };
    expect(await charge(s, "app:a", limits, t0)).toBe("ok");
    const later = t0 + 10 * HOUR;
    expect(await charge(s, "app:a", limits, later)).toBe("ok");
    expect(await charge(s, "app:a", limits, later)).toBe("ok");
    expect(await charge(s, "app:a", limits, later)).toBeInstanceOf(HttpError);
  });
});

describe("concurrent turns", () => {
  async function session(
    s: MemorySessionStore,
    id: string,
    ownerUserId: string,
    status: string
  ) {
    await s.tx((t) =>
      t.put("sessions", id, {
        id,
        agentId: "bot",
        ownerUserId,
        status,
        activeTurnId: status === "idle" ? null : "turn",
      })
    );
  }

  it("counts running, runnable and waiting sessions, not paused or idle ones", async () => {
    const s = store();
    const limits = { concurrentTurns: 2 };
    await session(s, "a1", "app:a", "running");
    await session(s, "a2", "app:a", "paused");
    await session(s, "a3", "app:a", "idle");
    await session(s, "b1", "app:b", "running");
    await session(s, "b2", "app:b", "running");
    expect(await charge(s, "app:a", limits, Date.now())).toBe("ok");
    await session(s, "a4", "app:a", "waiting");
    const refused = await charge(s, "app:a", limits, Date.now());
    expect((refused as HttpError).status).toBe(429);
    expect((refused as HttpError).rejection).toMatchObject({
      details: { limit: "concurrentTurns" },
    });
  });
});
