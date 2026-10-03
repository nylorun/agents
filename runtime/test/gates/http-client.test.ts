/**
 * The loop's HTTP client of the gates service (`gates/http-client.ts`): what it sends, and the
 * failure outcome each kind of hop failure becomes. Never a throw, except when the caller
 * aborts: `resolveEffect` would mark a throw `uncertain`. The credential is the session's run
 * token (F5); the body names no session, turn or agent.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { httpModelGate } from "../../src/gates/http-client.js";
import type { ModelGateRequest } from "../../src/gates/model-gate.js";
import type { RunTokens } from "../../src/tenant/run-grants.js";

/** Stands in for session-1's run token. */
const token = "run.token.session-1";
const runTokens: RunTokens = { token: (sessionId) => (sessionId === "session-1" ? token : undefined) };
const request: ModelGateRequest = {
  tenantId: newTenantId(),
  sessionId: "session-1",
  turnId: "turn-1",
  agentId: "bot",
  effectId: "turn-1:0:model:1",
  invocationId: "1",
  call: {
    executionId: "exec-1",
    tools: [],
    prompt: [{ kind: "message", role: "user", content: [{ type: "text", text: "hi" }] }],
  },
};

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A stand-in gate on 127.0.0.1 that answers with `handler`. */
async function gate(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const call = (url: string, signal = new AbortController().signal, timeoutMs?: number) =>
  httpModelGate({ url, runTokens, ...(timeoutMs ? { timeoutMs } : {}) }).call(request, signal);

describe("httpModelGate", () => {
  it("sends the call with the session's run token, the Tenant and the effect id, and returns the outcome", async () => {
    let seen: { headers: IncomingMessage["headers"]; url?: string; body: unknown } | undefined;
    const outcome = { output: [{ type: "text", text: "ok" }], finishReason: "stop" };
    const url = await gate((req, res, body) => {
      seen = { headers: req.headers, url: req.url, body: JSON.parse(body) };
      json(res, 200, { outcome });
    });
    expect(await call(url)).toEqual(outcome);
    expect(seen?.url).toBe("/nylorun/v1/model-calls");
    expect(seen?.headers).toMatchObject({
      authorization: `Bearer ${token}`,
      "nylorun-tenant": request.tenantId,
      "idempotency-key": request.effectId,
    });
    // Session, turn and agent travel in the token, not the body.
    expect(seen?.body).toEqual({
      effectId: request.effectId,
      invocationId: request.invocationId,
      call: request.call,
    });
  });

  it("fails at once, sending nothing and never core's credential, for a session with no run token", async () => {
    let sent = false;
    const url = await gate((_req, res) => {
      sent = true;
      json(res, 200, {});
    });
    const outcome = await httpModelGate({ url, runTokens }).call(
      { ...request, sessionId: "session-2" },
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ code: "transient", message: expect.stringMatching(/No run token/) });
    expect(sent).toBe(false);
  });

  it("returns a gate's failure outcome as it is", async () => {
    const outcome = { kind: "failed", code: "rate_limited", message: "slow down", retryable: true };
    const url = await gate((_req, res) => json(res, 200, { outcome }));
    expect(await call(url)).toEqual(outcome);
  });

  it("is a transient, retryable failure when the gate is unreachable", async () => {
    const url = await gate(() => {});
    const port = new URL(url).port;
    await afterEachClose();
    expect(await call(`http://127.0.0.1:${port}`)).toMatchObject({
      kind: "failed",
      code: "transient",
      retryable: true,
      message: expect.stringMatching(/unreachable/),
    });
  });

  it("is an auth failure when the gate refuses the run token", async () => {
    const url = await gate((_req, res) =>
      json(res, 401, { error: { code: "gate_unauthorized", message: "nope" } }),
    );
    expect(await call(url)).toMatchObject({
      code: "auth",
      retryable: false,
      message: expect.stringMatching(/refused the run token: nope/),
    });
  });

  it("is a non-retryable failure when the gate finds the run stale (409 run_stale)", async () => {
    const url = await gate((_req, res) =>
      json(res, 409, { error: { code: "run_stale", message: "the turn has ended" } }),
    );
    expect(await call(url)).toMatchObject({
      code: "invalid_request",
      retryable: false,
      message: expect.stringMatching(/stale run: .*the turn has ended/),
    });
  });

  it("is invalid_request with the gate's message for a 400", async () => {
    const url = await gate((_req, res) =>
      json(res, 400, { error: { code: "invalid_request", message: "too big" } }),
    );
    expect(await call(url)).toMatchObject({ code: "invalid_request", retryable: false, message: "too big" });
  });

  it("is transient and retryable for any other status", async () => {
    const url = await gate((_req, res) => json(res, 503, {}));
    expect(await call(url)).toMatchObject({ code: "transient", retryable: true });
  });

  it("is transient, saying the provider may have billed, when the connection is lost mid-call", async () => {
    const url = await gate((req) => req.socket.destroy());
    expect(await call(url)).toMatchObject({
      code: "transient",
      retryable: true,
      message: expect.stringMatching(/lost mid-call.*may have billed/),
    });
  });

  it("is transient when the gate sends nothing for the timeout", async () => {
    const url = await gate(() => {});
    expect(await call(url, undefined, 150)).toMatchObject({
      code: "transient",
      retryable: true,
      message: expect.stringMatching(/sent nothing/),
    });
  });

  it("is a transient, non-retryable failure when the answer has no outcome", async () => {
    const url = await gate((_req, res) => json(res, 200, {}));
    expect(await call(url)).toMatchObject({ code: "transient", retryable: false });
  });

  it("is a non-retryable invalid_request when the request changed under its effect id (409)", async () => {
    const url = await gate((_req, res) =>
      json(res, 409, { error: { code: "gate_conflict", message: "different request" } }),
    );
    expect(await call(url)).toMatchObject({
      code: "invalid_request",
      retryable: false,
      message: expect.stringMatching(/changed under the same effect id/),
    });
  });

  it("declares that its calls outlive the caller, and cancels one by effect id", async () => {
    let seen: { url?: string; headers: IncomingMessage["headers"] } | undefined;
    const url = await gate((req, res) => {
      seen = { url: req.url, headers: req.headers };
      res.writeHead(204);
      res.end();
    });
    const gateClient = httpModelGate({ url, runTokens });
    expect(gateClient.recovers).toBe(true);
    await gateClient.cancel!(request);
    expect(seen?.url).toBe(`/nylorun/v1/model-calls/${encodeURIComponent(request.effectId)}/cancel`);
    expect(seen?.headers).toMatchObject({
      authorization: `Bearer ${token}`,
      "nylorun-tenant": request.tenantId,
    });
  });

  it("never rejects a cancel, even when the gate is unreachable", async () => {
    const url = await gate(() => {});
    const port = new URL(url).port;
    await afterEachClose();
    await expect(
      httpModelGate({ url: `http://127.0.0.1:${port}`, runTokens }).cancel!(request),
    ).resolves.toBeUndefined();
  });

  it("sends no cancel for a session with no run token", async () => {
    let sent = false;
    const url = await gate((_req, res) => {
      sent = true;
      res.writeHead(204);
      res.end();
    });
    await httpModelGate({ url, runTokens }).cancel!({ ...request, sessionId: "session-2" });
    expect(sent).toBe(false);
  });

  it("throws when the caller aborts, and closes the connection", async () => {
    let closed = false;
    const url = await gate((req) => req.socket.on("close", () => (closed = true)));
    const caller = new AbortController();
    const pending = call(url, caller.signal);
    setTimeout(() => caller.abort(new Error("cancelled")), 50);
    await expect(pending).rejects.toThrow("cancelled");
    await expect.poll(() => closed).toBe(true);
  });
});

/** Closes the stand-in gates started so far, freeing their ports. */
async function afterEachClose() {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
