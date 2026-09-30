/**
 * A tool outcome posted later (`POST /v1/actions/:id/result` after a `202`) is checked like an
 * inline one: a completed output against the tool's output schema, while denied and deferred
 * outcomes pass through as they are.
 */
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { Agent, tool } from "@nylorun/core/define";
import { registerEndpoint, startEndpoint } from "./support/endpoint.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "server-token-value-aaaaaaaa";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close().catch(() => {});
});

const agent = Agent({ id: "issue", name: "Issue" })
  .use({
    id: "notes",
    tools: [
      tool({
        name: "save",
        input: z.object({ note: z.string() }),
        output: z.object({ saved: z.literal(true) }),
        async run() {
          return { saved: true as const };
        },
      }),
    ],
  })
  .build();

/** Starts a turn whose tool call is delivered to an endpoint that answers `202`. */
async function delivered(endpointManifestHash?: string) {
  const runtime = await startTestTenant({
    applicationKey: APP,
    modelProvider: async (effect) => {
      const call = effect.input as { prompt?: { kind?: string }[] };
      if (call.prompt?.at(-1)?.kind === "tool-result") return { output: [{ type: "text", text: "done" }] };
      return { output: [{ type: "tool-call", id: "call-1", name: "save", args: { note: "hi" } }] };
    },
  });
  cleanup.push(() => runtime.close());
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${runtime.url}${path}`, {
      method,
      headers: runtime.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json().catch(() => undefined)) as any };
  };
  const registered = await api("PUT", "/v1/agents/issue", {
    requestId: "put-1",
    manifest: agent.manifest,
    implementationVersion: "dev",
  });
  expect(registered.status).toBe(200);
  const endpoint = await startEndpoint({ runtime });
  cleanup.push(() => endpoint.close());
  await registerEndpoint(runtime, "issue", endpoint.url, {
    ...(endpointManifestHash ? { manifestHash: endpointManifestHash } : {}),
  });
  expect((await api("PUT", "/v1/sessions/s1", { requestId: "session-1", agentId: "issue", ownerUserId: "user" })).status).toBe(200);
  expect(
    (await api("POST", "/v1/sessions/s1/commands", {
      type: "message",
      requestId: "msg-1",
      idempotencyKey: "msg-1",
      content: "save a note",
    })).status,
  ).toBe(200);
  const delivery = await endpoint.next();
  const completed = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const items = (await api("GET", "/v1/sessions/s1/items")).body.items as {
        type: string;
        payload: { result?: unknown };
      }[];
      const found = items.find((item) => item.type === "action.completed");
      if (found) return found.payload.result;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("action.completed was not recorded");
  };
  return { delivery, completed, manifestHash: registered.body.manifestHash as string };
}

it("delivers the registered definition's Action to any endpoint, and fails a schema-breaking result", async () => {
  const { delivery, completed, manifestHash } = await delivered("not-the-registered-digest");
  expect(manifestHash).not.toBe("not-the-registered-digest");
  expect(delivery.action.manifestHash).toBe(manifestHash);
  expect((delivery.action as { outputSchema?: unknown }).outputSchema).toMatchObject({ type: "object" });
  expect((await delivery.result({ saved: false })).status).toBe(200);
  expect(await completed()).toMatchObject({ kind: "failed", code: "tool.invalid-output" });
});

it("accepts a completed tool outcome that matches the output schema", async () => {
  const { delivery, completed } = await delivered();
  expect((await delivery.result({ kind: "completed", output: { saved: true } })).status).toBe(200);
  expect(await completed()).toEqual({ kind: "completed", output: { saved: true } });
});

it.each([
  ["denied", { kind: "denied", reason: "Approval denied" }],
  ["deferred", { kind: "deferred", token: { wait: { kind: "sleep", duration: "1h" } } }],
])("passes a %s tool outcome through without output-schema validation", async (_kind, value) => {
  const { delivery, completed } = await delivered();
  expect((await delivery.result(value)).status).toBe(200);
  expect(await completed()).toEqual(value);
});
