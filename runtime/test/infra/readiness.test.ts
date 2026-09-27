import { describe, expect, it } from "vitest";
import { AdminStatusSchema, ReadyResponseSchema } from "@nylorun/core/contracts";
import { createReadiness, type Probe } from "../../src/infra/readiness.js";
import { adminHeaders, getJson, startTestHost } from "../host/support.js";

const ok: Probe = async () => {};
const down: Probe = async () => {
  throw new Error("connect ECONNREFUSED");
};
/** Never answers until aborted. */
const hangs: Probe = (signal) =>
  new Promise((_, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
  );

describe("createReadiness", () => {
  it("is ok when every check passes", async () => {
    const report = await createReadiness({ postgres: ok, restate: ok, s2: ok })();
    expect(report).toEqual({
      ok: true,
      checks: { postgres: true, restate: true, s2: true },
      errors: {},
    });
  });

  it("fails on one failing check and keeps its error", async () => {
    const report = await createReadiness({ postgres: ok, restate: ok, s2: down })();
    expect(report).toEqual({
      ok: false,
      checks: { postgres: true, restate: true, s2: false },
      errors: { s2: "connect ECONNREFUSED" },
    });
  });

  it("bounds a check that never answers, and aborts its signal", async () => {
    let aborted = false;
    const started = Date.now();
    const report = await createReadiness(
      {
        postgres: (signal) => {
          signal.addEventListener("abort", () => (aborted = true));
          return hangs(signal);
        },
        s2: ok,
      },
      { timeoutMs: 50 },
    )();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(aborted).toBe(true);
    expect(report).toEqual({
      ok: false,
      checks: { postgres: false, s2: true },
      errors: { postgres: "timed out after 50 ms" },
    });
  });

  it("runs checks in parallel", async () => {
    const slow: Probe = () => new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    await createReadiness({ postgres: slow, restate: slow, s2: slow })();
    expect(Date.now() - started).toBeLessThan(290);
  });

  it("is ok with no checks", async () => {
    expect(await createReadiness({})()).toEqual({ ok: true, checks: {}, errors: {} });
  });
});

describe("host /ready with readiness", () => {
  it("answers 503 with every check when one infrastructure check fails", async () => {
    const readiness = createReadiness({ postgres: ok, restate: ok, s2: down });
    const { url } = await startTestHost({ readiness });
    const response = await getJson(`${url}/ready`);
    expect(response.status).toBe(503);
    ReadyResponseSchema.parse(response.body);
    expect(response.body).toEqual({
      status: "not_ready",
      service: "nylorun-runtime",
      checks: { listener: true, discovery: true, postgres: true, restate: true, s2: false },
    });
    // Errors are for logs, not for an unauthenticated route.
    expect(JSON.stringify(response.body)).not.toContain("ECONNREFUSED");
  });

  it("answers 200 when every check passes", async () => {
    const readiness = createReadiness({ postgres: ok, restate: ok, s2: ok });
    const { url } = await startTestHost({ readiness });
    const response = await getJson(`${url}/ready`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ready",
      service: "nylorun-runtime",
      checks: { listener: true, discovery: true, postgres: true, restate: true, s2: true },
    });
  });

  it("follows the dependency when it recovers", async () => {
    let s2: Probe = down;
    const readiness = createReadiness({ s2: (signal) => s2(signal) });
    const { url } = await startTestHost({ readiness });
    expect((await getJson(`${url}/ready`)).status).toBe(503);
    s2 = ok;
    expect((await getJson(`${url}/ready`)).status).toBe(200);
  });
});

describe("host publicUrl", () => {
  it("reports the public URL in /v1/admin/status instead of the bound address", async () => {
    const { url } = await startTestHost({ publicUrl: "http://localhost:8787" });
    const { status, body } = await getJson(`${url}/v1/admin/status`, {
      headers: adminHeaders(),
    });
    expect(status).toBe(200);
    expect(AdminStatusSchema.parse(body).host?.url).toBe("http://localhost:8787");
    expect(url).not.toBe("http://localhost:8787");
  });

  it("reports the bound address without one", async () => {
    const { url } = await startTestHost();
    const { body } = await getJson(`${url}/v1/admin/status`, { headers: adminHeaders() });
    expect(AdminStatusSchema.parse(body).host?.url).toBe(url);
  });
});
