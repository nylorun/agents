/**
 * Protocol 11: a flow agent opened on an Environment passes it to the agents in it, which
 * declare none, with the sandbox tools; the tree shares the Environment's one sandbox, and its
 * turns nest in the flow's without being refused as busy.
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

it("gives the flow's agents the Environment the flow session was opened on", { timeout: 30_000 }, async () => {
  const tenant = await startTestTenant({ applicationKey: APP, modelProvider: writer });
  cleanups.push(() => tenant.close());
  const client = createClient({ url: tenant.url, key: tenant.applicationKey, tenant: tenant.tenantId });
  const desk = Agent({ id: "desk" })
    .pipe(Agent({ id: "drafter" }).instructions("Write a draft to draft.txt."))
    .build();
  await client.saveAgent(desk, { implementationVersion: "v1" });

  await client.environments.put("desks/user-1", {});
  const session = await client.createSession({
    id: "desk-session",
    agentId: "desk",
    ownerUserId: "user-1",
    environment: "desks/user-1",
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
  ).json()) as { environment: unknown; status: string };
  expect(leafView).toMatchObject({ environment: { id: "desks/user-1", version: 1 }, status: "completed" });
  // The sandbox's events go to the log of the session that ran the tool: the leaf's.
  const leafItems = (await (
    await fetch(`${tenant.url}/v1/sessions/${leaf}/items`, { headers: tenant.headers() })
  ).json()) as { items: { type: string; payload: any }[] };
  expect(
    leafItems.items.some((item) => item.type === "environment.exec" && item.payload.tool === "write")
  ).toBe(true);
  // The leaf's turn ran inside the flow's: neither was refused as busy.
  expect(events.some((event) => event.type === "turn.failed")).toBe(false);

  // The file the leaf wrote is in the Environment's sandbox, the flow session's too.
  const read = (await (
    await fetch(`${tenant.url}/v1/sessions/desk-session/sandbox/read`, {
      method: "POST",
      headers: { ...tenant.headers(), "content-type": "application/json" },
      body: JSON.stringify({ path: "draft.txt" }),
    })
  ).json()) as { output: string };
  expect(read.output).toContain("from the writer");
});
