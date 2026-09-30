import { expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { accepted, outcome, registerEndpoint, startEndpoint } from "./support/endpoint.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "server-token-value-aaaaaaaa";

const server = {
  authorization: `Bearer ${APP}`,
  "content-type": "application/json",
};
const hooked = Agent({ id: "hooked", name: "Hooked" })
  .use({ id: "one", before: { step: () => ({}) } })
  .use({ id: "two", before: { step: () => ({}) } })
  .build();

async function start(leaseMs?: number) {
  return startTestTenant({
    applicationKey: APP,
    modelProvider: async () => ({ output: [{ type: "text", text: "done" }] }),
    ...(leaseMs === undefined ? {} : { leaseMs }),
  });
}

async function openTurn(url: string) {
  const put = (path: string, body: unknown) =>
    fetch(`${url}${path}`, { method: "PUT", headers: server, body: JSON.stringify(body) });
  expect(
    (
      await put("/v1/agents/hooked", {
        requestId: "put-1",
        manifest: hooked.manifest,
        implementationVersion: "dev",
      })
    ).ok
  ).toBe(true);
  expect(
    (await put("/v1/sessions/s1", { requestId: "s-1", agentId: "hooked", ownerUserId: "u" })).ok
  ).toBe(true);
  const message = await fetch(`${url}/v1/sessions/s1/commands`, {
    method: "POST",
    headers: server,
    body: JSON.stringify({
      type: "message",
      requestId: "msg-1",
      idempotencyKey: "msg-1",
      content: "hello",
    }),
  });
  expect(message.ok).toBe(true);
}

it("sends one hook action per point and re-delivers it when a 202 delivery's deadline passes", async () => {
  // A 202 delivery's deadline is the lease; the sweep runs at least that often.
  const runtime = await start(300);
  // Never answer the first delivery after its 202: the deadline passes, the hook goes back to
  // pending and is delivered again. The second one is answered inline.
  const endpoint = await startEndpoint({
    runtime,
    answer: (delivery) =>
      delivery.action.generation > 1 ? outcome({ results: { one: {}, two: {} } }) : accepted,
  });
  try {
    await registerEndpoint(runtime, "hooked", endpoint.url);
    await openTurn(runtime.url);
    const first = await endpoint.next();
    expect(first.action).toMatchObject({
      kind: "hook",
      hook: { at: "before", scope: "step", capabilityIds: ["one", "two"] },
    });

    const second = await endpoint.next((delivery) => delivery !== first);
    expect(second.action.actionId).toBe(first.action.actionId);
    expect(second.action.generation).toBeGreaterThan(first.action.generation);
    // The lost delivery's token no longer answers for the Action.
    expect((await first.result({ results: { one: {}, two: {} } })).status).toBe(409);

    let types: string[] = [];
    for (let attempt = 0; attempt < 150 && !types.includes("turn.completed"); attempt += 1) {
      const items = await fetch(`${runtime.url}/v1/sessions/s1/items`, {
        headers: { authorization: server.authorization },
      });
      types = ((await items.json()) as { items: { type: string }[] }).items.map(
        (item) => item.type
      );
      if (!types.includes("turn.completed"))
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(types).toContain("turn.completed");
    expect(types).not.toContain("action.uncertain");
    // Every hook point sent exactly one Action.
    expect(new Set(endpoint.deliveries.map((d) => d.action.actionId)).size).toBe(1);
  } finally {
    await endpoint.close();
    await runtime.close();
  }
});
