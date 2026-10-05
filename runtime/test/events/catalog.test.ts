/**
 * The event catalog covers every event the Runtime writes (Durable Streams §9.5, test 7).
 * Writes are also validated at runtime (`record/envelope.ts`), so every test that runs a turn
 * checks its events against the catalog too.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVENT_TYPES, SessionCommandSchema } from "@nylorun/core/contracts";
import { createTestSessionStore } from "../support/store.js";
import { InvalidEventError } from "../../src/record/index.js";

const SRC = join(import.meta.dirname, "../../src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

/** Literal and template types passed to `t.event(…)` or a sandbox `emit(…)`. */
function writtenTypes(): { literals: Set<string>; templates: Set<string> } {
  const literals = new Set<string>();
  const templates = new Set<string>();
  const call = /\.(?:event|emit)\(\s*[^,]+,\s*[^,]+,\s*"([a-z_.]+)"/g;
  // A type chosen inside the call: `settled ? "delegation.completed" : "delegation.started"`.
  const chosen = /\.event\(\s*[^,]+,\s*[^,]+,\s*[\w.]+\s*\?\s*"([a-z_.]+)"\s*:\s*"([a-z_.]+)"/g;
  // A type built from a template in a file that writes events: `turn.${result.status}`.
  const template = /`([a-z]+\.)\$\{/g;
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    if (!/\.(?:event|emit)\(/.test(text)) continue;
    for (const match of text.matchAll(call)) literals.add(match[1]!);
    for (const match of text.matchAll(chosen)) {
      literals.add(match[1]!);
      literals.add(match[2]!);
    }
    for (const match of text.matchAll(template))
      if (["command.", "turn."].includes(match[1]!) || EVENT_TYPES.some((t) => t.startsWith(match[1]!)))
        templates.add(match[1]!);
  }
  return { literals, templates };
}

describe("event catalog coverage", () => {
  const { literals, templates } = writtenTypes();

  it("finds the Runtime's writes", () => {
    expect(literals.size).toBeGreaterThan(15);
    expect([...templates].sort()).toEqual(["command.", "turn."]);
  });

  it("lists every type the Runtime writes", () => {
    const missing = [...literals].filter((type) => !EVENT_TYPES.includes(type as never));
    expect(missing).toEqual([]);
  });

  it("lists every command event and every settled turn", () => {
    const commands = SessionCommandSchema.options
      .flatMap((option) => ("options" in option ? option.options : [option]))
      .map((option) => option.shape.type.value)
      .filter((type) => type !== "cancel");
    for (const type of commands) expect(EVENT_TYPES).toContain(`command.${type}`);
    for (const status of ["completed", "paused", "failed", "cancelled"])
      expect(EVENT_TYPES).toContain(`turn.${status}`);
  });

  it("refuses a write the catalog does not describe, and rolls the transaction back", async () => {
    const store = await createTestSessionStore();
    await store.tx((t) => t.put("sessions", "s1", { id: "s1", status: "idle" }));
    await expect(
      store.tx((t) => t.event("s1", null, "made.up" as never, {} as never)),
    ).rejects.toBeInstanceOf(InvalidEventError);
    await expect(
      store.tx((t) => t.event("s1", null, "loop.verified", { path: "p" } as never)),
    ).rejects.toThrow(/loop\.verified/);
    const event = await store.tx((t) => t.event("s1", null, "turn.completed", { output: 1 }));
    expect(event).toMatchObject({ schema: "nylorun.event/2", seq: 0, source: { kind: "loop" } });
  });
});
