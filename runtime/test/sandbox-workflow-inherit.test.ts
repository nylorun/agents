/**
 * Sandboxes v3: a flow agent opened with a sandbox passes it to the agents in it, which declare
 * none, with the sandbox tools; the tree shares one sandbox keyed by the flow's session.
 */
import { afterEach, expect, it } from "vitest";
import {
  Agent,
  createClient,
} from "@nylorun/agents";
import { startTestTenant } from "./support/tenant.js";
import type { ModelProvider } from "../src/core/provider.js";

const APP = "sandbox-inherit-app-token-aaaaaaaa";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Writes a file with the sandbox's `write` tool when it has one, then answers. */
const writer: ModelProvider = async (effect) => {
  const input = effect.input as { prompt?: { kind?: string }[]; tools?: { name: string }[] };
  const done = (input.prompt ?? []).some((item) => item.kind === "tool-result");
  const canWrite = (input.tools ?? []).some((item) => item.name === "write");
  if (!canWrite || done) return { output: [{ type: "text", text: canWrite ? "wrote" : "no sandbox" }] };
  return {
    output: [
      {
        type: "tool-call",
        id: `call-${effect.turnId}`,
        name: "write",
        args: { path: "draft.txt", content: "from the writer" },
      },
    ],
  };
};

it("gives the flow's agents the sandbox the flow session was opened with", { timeout: 30_000 }, async () => {
  const tenant = await startTestTenant({ applicationKey: APP, modelProvider: writer });
  cleanups.push(() => tenant.close());
  const client = createClient({ url: tenant.url, key: tenant.applicationKey, tenant: tenant.tenantId });
  const desk = Agent({ id: "desk" })
    .pipe(Agent({ id: "drafter" }).instructions("Write a draft to draft.txt."))
    .build();
  await client.saveAgent(desk, { implementationVersion: "v1" });

  const session = await client.createSession({
    id: "desk-session",
    agentId: "desk",
    ownerUserId: "user-1",
    sandbox: {},
  });
  const events: { type: string; sessionId: string; payload: any }[] = [];
  const done = (async () => {
    for await (const event of session.observe()) {
      events.push({ type: event.type, sessionId: event.sessionId, payload: event.payload });
      if (event.sessionId === session.id && (event.type === "turn.completed" || event.type === "turn.failed"))
        return event.type;
    }
    return "ended";
  })();
  await session.input("go", { idempotencyKey: "msg-1" });
  expect(await done).toBe("turn.completed");

  const leaf = events.find((event) => event.type === "node.agent")!.payload.sessionId as string;
  const leafView = (await (
    await fetch(`${tenant.url}/v1/sessions/${leaf}`, { headers: tenant.headers() })
  ).json()) as { sandboxOwnerId: string; sandboxSource: string };
  expect(leafView).toMatchObject({ sandboxOwnerId: "desk-session", sandboxSource: "shared" });
  expect(
    events.some((event) => event.type === "sandbox.exec" && event.payload.tool === "write")
  ).toBe(true);

  // The file the leaf wrote is in the flow session's sandbox.
  const read = (await (
    await fetch(`${tenant.url}/v1/sessions/desk-session/sandbox/read`, {
      method: "POST",
      headers: { ...tenant.headers(), "content-type": "application/json" },
      body: JSON.stringify({ path: "draft.txt" }),
    })
  ).json()) as { output: string };
  expect(read.output).toContain("from the writer");
});
