/**
 * An app that serves with `@hono/node-server`'s defaults replaces the process's `Request` and
 * `Response` with its own classes. A Runtime started in that process afterwards
 * (`startEphemeralRuntime` in the app's tests) must answer as it would anywhere else: answers
 * written straight to the Node response (streams, routes not yet on Hono, `HEAD`) are not
 * written twice. Its own file, since the replaced globals cannot be put back.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { expect, it, vi } from "vitest";
import { Agent } from "@nylorun/core/define";

const native = globalThis.Response;
getRequestListener(() => new Response("the app"));
const { startEphemeralRuntime } = await import("../../src/tenant/ephemeral.js");

it("answers normally in a process whose Request and Response @hono/node-server replaced", async () => {
  expect(globalThis.Response).not.toBe(native);
  // `@hono/node-server` reports an answer it failed to write here, then destroys the response.
  const errors = vi.spyOn(console, "error");
  const root = await mkdtemp(join(tmpdir(), "nylorun-foreign-globals-"));
  const rt = await startEphemeralRuntime({
    hostRoot: root,
    operatorListener: true,
    model: { kind: "fixture" },
  });
  try {
    const headers = {
      "nylorun-protocol": "3",
      "nylorun-tenant": rt.tenantId,
      authorization: `Bearer ${rt.applicationKey}`,
      "content-type": "application/json",
    };
    const put = await fetch(`${rt.url}/v1/agents/bot`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        requestId: "bot",
        manifest: Agent({ id: "bot", name: "Bot" }).build().manifest,
        implementationVersion: "dev",
      }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ agentId: "bot" });

    const head = await fetch(`${rt.url}/v1/agents`, { method: "HEAD", headers });
    expect(head.status).toBe(404);

    expect((await fetch(`${rt.url}/health`)).status).toBe(200);
    const admin = await fetch(`${rt.adminUrl}/v1/admin/status`, {
      headers: { "nylorun-protocol": "3", authorization: `Bearer ${rt.adminKey}` },
    });
    expect(admin.status).toBe(200);
    expect(await admin.json()).toMatchObject({ service: "nylorun-runtime" });

    await fetch(`${rt.url}/v1/sessions/s1`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ requestId: "s1", agentId: "bot", ownerUserId: "app:ann" }),
    });
    const stream = new AbortController();
    const events = await fetch(`${rt.url}/v1/sessions/s1/events`, {
      headers,
      signal: stream.signal,
    });
    expect(events.headers.get("content-type")).toBe("text/event-stream");
    // The stream outlives its headers: an event sent now arrives on it.
    await fetch(`${rt.url}/v1/sessions/s1/commands`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "message", requestId: "m", idempotencyKey: "m", content: "Hi" }),
    });
    const reader = events.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toMatch(/^id: [^\n]+\nevent: /);
    stream.abort();
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await rt.close();
    await rm(root, { recursive: true, force: true });
  }
});
