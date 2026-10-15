/**
 * An unexpected error on the gates listener: the caller's answer is unchanged, and the gate's
 * logger gets one entry with the cause, never the request's body.
 */
import { expect, it } from "vitest";
import { RUNTIME_LIMIT_DEFAULTS } from "@nylorun/core/contracts";
import { createGatesApp, type GatesAppOptions } from "../../src/api/gate/routes.js";
import type { Keys } from "../../src/keys/keys.js";

const TOKEN = "gates-token-aaaaaaaaaaaaaaaaaaaaaaaa";
const RUN_TOKEN = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln";

function gates(overrides: Partial<GatesAppOptions>) {
  const entries: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const log =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>): void => {
      entries.push({ level, message, ...(fields ? { fields } : {}) });
    };
  const app = createGatesApp({
    token: TOKEN,
    runs: { verify: async () => ({ ok: false, reason: "unused" }), stale: async () => undefined },
    modelGate: { call: async () => ({ kind: "unused" }) },
    inflight: {},
    ready: async () => true,
    limits: async () => RUNTIME_LIMIT_DEFAULTS,
    logger: { info: log("info"), warn: log("warn"), error: log("error") },
    ...overrides,
  } as GatesAppOptions);
  return { app, errors: () => entries.filter((entry) => entry.level === "error"), entries };
}

it("logs a gate route's unexpected error once", async () => {
  const { app, errors, entries } = gates({
    runs: {
      verify: async () => {
        throw new Error("signing keys unreachable");
      },
      stale: async () => undefined,
    },
  });
  const response = await app.request("/nylorun/v1/model-calls", {
    method: "POST",
    headers: { authorization: `Bearer ${RUN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ secret: "body-secret-value" }),
  });
  expect(response.status).toBe(500);
  expect(await response.text()).toBe("Internal Server Error");
  expect(errors()).toHaveLength(1);
  expect(errors()[0]).toMatchObject({
    message: "request_failed",
    fields: {
      method: "POST",
      route: "/nylorun/v1/model-calls",
      error: "signing keys unreachable",
      stack: expect.stringContaining("signing keys unreachable"),
    },
  });
  expect(JSON.stringify(entries)).not.toContain("body-secret-value");
});

it("logs a keys operation's internal failure once, never its arguments", async () => {
  const { app, errors, entries } = gates({
    keys: async () =>
      ({
        async sign() {
          throw new Error("vault key unreadable");
        },
      }) as unknown as Keys,
  });
  const response = await app.request("/nylorun/v1/keys/sign", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ args: ["arg-secret-value"] }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    error: { kind: "http", status: 500, message: "The keys service failed" },
  });
  expect(errors()).toHaveLength(1);
  expect(errors()[0]).toMatchObject({
    message: "keys_request_failed",
    fields: { operation: "sign", error: "vault key unreadable" },
  });
  expect(JSON.stringify(entries)).not.toContain("arg-secret-value");
});
