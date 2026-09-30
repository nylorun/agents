/**
 * What serving through Hono (`@hono/node-server`) must not change for the process around the
 * Runtime, and what it answers that the Host never sees.
 */
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

// Captured before the Runtime's modules load.
const globals = { Request: globalThis.Request, Response: globalThis.Response };
const { startEphemeralRuntime } = await import("../../src/tenant/ephemeral.js");

it("leaves the process's Request and Response alone: an embedding app keeps its own", async () => {
  const root = await mkdtemp(join(tmpdir(), "nylorun-hono-shell-"));
  const rt = await startEphemeralRuntime({ hostRoot: root, model: { kind: "fixture" } });
  try {
    expect((await fetch(`${rt.url}/health`)).status).toBe(200);
    expect(globalThis.Request).toBe(globals.Request);
    expect(globalThis.Response).toBe(globals.Response);
  } finally {
    await rt.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("answers a request target that is not a path with a JSON 400", async () => {
  const root = await mkdtemp(join(tmpdir(), "nylorun-hono-shell-"));
  const rt = await startEphemeralRuntime({ hostRoot: root, model: { kind: "fixture" } });
  try {
    const { host } = new URL(rt.url);
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(rt.url, { method: "OPTIONS", path: "*", headers: { host } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body)).toEqual({
      status: "rejected",
      code: "invalid_request",
      message: "Invalid request target",
    });
  } finally {
    await rt.close();
    await rm(root, { recursive: true, force: true });
  }
});
