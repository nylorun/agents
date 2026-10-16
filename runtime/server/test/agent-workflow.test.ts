/**
 * A flow's Agent (protocol 16; an Environment from protocol 11): the agents in a flow saved as an
 * agent manifest run on the flow's Agent, with the sandbox tools; the tree shares the Agent's one
 * sandbox, its leaf sessions name the flow's Agent, and its turns nest in the flow's without
 * being refused as busy.
 */
import { afterEach, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { startTestTenant } from "./support/tenant.js";
import { deploy, openSession } from "./support/agents.js";
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

it("runs the flow's agents on the flow's Agent, in its sandbox", { timeout: 30_000 }, async () => {
  const tenant = await startTestTenant({ applicationKey: APP, modelProvider: writer });
  cleanups.push(() => tenant.close());
  const headers = { ...tenant.headers(), "content-type": "application/json" };
  const get = async (path: string) => (await fetch(`${tenant.url}${path}`, { headers })).json() as Promise<any>;
  const desk = Agent({ id: "desk", name: "desk" })
    .pipe(Agent({ id: "drafter", name: "drafter" }).instructions("Write a draft to draft.txt."))
    .build();
  await deploy(tenant.url, headers, desk, { id: "desks/user-1", runtime: { kind: "virtual" } });

  const opened = await openSession(tenant.url, headers, "desk-session", { agent: "desks/user-1", ownerUserId: "user-1" });
  expect(opened.status, await opened.clone().text()).toBe(200);
  const sent = await fetch(`${tenant.url}/v1/sessions/desk-session/commands`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "message", requestId: "msg-1", idempotencyKey: "msg-1", content: "go" }),
  });
  expect(sent.status).toBe(200);
  let status = "";
  for (let attempt = 0; attempt < 1000 && !["completed", "failed", "cancelled"].includes(status); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    status = (await get("/v1/sessions/desk-session")).status;
  }
  expect(status).toBe("completed");

  // The flow's leaf session runs on the flow's Agent.
  const listed = (await get(`/v1/sessions?agentId=${encodeURIComponent("desks/user-1")}`)).sessions as { id: string }[];
  const leaf = listed.map((session) => session.id).find((id) => id !== "desk-session")!;
  expect(leaf).toBeDefined();
  expect(await get(`/v1/sessions/${leaf}`)).toMatchObject({ agentId: "desks/user-1", status: "completed" });
  // The sandbox's events go to the log of the session that ran the tool: the leaf's.
  const leafItems = (await get(`/v1/sessions/${leaf}/items`)) as { items: { type: string; payload: any }[] };
  expect(
    leafItems.items.some((item) => item.type === "environment.exec" && item.payload.tool === "write")
  ).toBe(true);
  // The leaf's turn ran inside the flow's: neither was refused as busy.
  const items = (await get("/v1/sessions/desk-session/items")) as { items: { type: string }[] };
  expect(items.items.some((item) => item.type === "turn.failed")).toBe(false);

  // The file the leaf wrote is in the Agent's sandbox, the flow session's too.
  const read = (await (
    await fetch(`${tenant.url}/v1/sessions/desk-session/sandbox/read`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "draft.txt" }),
    })
  ).json()) as { output: string };
  expect(read.output).toContain("from the writer");
});
