import { expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { registerEndpoint, startEndpoint } from "./support/endpoint.js";
import { startTestTenant } from "./support/tenant.js";
import type { ModelProvider } from "../src/core/provider.js";

const APP = "server-token-value-aaaaaaaa";
const serverHeaders = {
  authorization: `Bearer ${APP}`,
  "content-type": "application/json",
};

/** Agents declare no sandbox; sessions are opened with one. */
const sandboxed = (id: string) => Agent({ id, name: id }).instructions("Work.").build();

async function boot(modelProvider?: ModelProvider) {
  return startTestTenant({
    mode: "test",
    applicationKey: APP,
    vaultKek: null,
    modelProvider:
      modelProvider ??
      (async () => ({ output: [{ type: "text", text: "ok" }] })),
    sandbox: { backend: "virtual" },
  });
}

async function putAgent(
  runtime: { url: string },
  agent: { id: string; manifest: unknown }
) {
  const response = await fetch(`${runtime.url}/v1/agents/${agent.id}`, {
    method: "PUT",
    headers: serverHeaders,
    body: JSON.stringify({
      requestId: `put-${agent.id}`,
      manifest: agent.manifest,
      implementationVersion: "dev",
    }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
}

it("attaches PutSession.sandbox and keys the sandbox by the owning session", async () => {
  const runtime = await boot();
  try {
    const owner = sandboxed("owner");
    const child = sandboxed("child");
    await putAgent(runtime, owner);
    await putAgent(runtime, child);

    const ownerSession = await fetch(`${runtime.url}/v1/sessions/wf-1`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({
        requestId: "sess-owner",
        agentId: "owner",
        ownerUserId: "ada",
        sandbox: {},
      }),
    });
    expect(ownerSession.ok).toBe(true);

    const shared = await fetch(`${runtime.url}/v1/sessions/agent-1`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({
        requestId: "sess-child",
        agentId: "child",
        ownerUserId: "ada",
        sandbox: { session: "wf-1" },
      }),
    });
    expect(shared.ok, await shared.clone().text()).toBe(true);
    const view = (await shared.json()) as { sandboxOwnerId: string | null };
    expect(view.sandboxOwnerId).toBe("wf-1");

    const write = await fetch(`${runtime.url}/v1/sessions/wf-1/sandbox/write`, {
      method: "POST",
      headers: serverHeaders,
      body: JSON.stringify({
        path: "shared.txt",
        content: "from-owner",
      }),
    });
    expect(write.ok, await write.clone().text()).toBe(true);

    const read = await fetch(
      `${runtime.url}/v1/sessions/agent-1/sandbox/read`,
      {
        method: "POST",
        headers: serverHeaders,
        body: JSON.stringify({ path: "shared.txt" }),
      }
    );
    expect(read.ok, await read.clone().text()).toBe(true);
    const body = (await read.json()) as {
      kind: string;
      output: string;
    };
    expect(body.kind).toBe("completed");
    expect(body.output).toContain("from-owner");
  } finally {
    await runtime.close();
  }
});

it("refuses session sandbox tools while an agent turn is active", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = await boot(async () => {
    await gate;
    return { output: [{ type: "text", text: "done" }] };
  });
  try {
    const owner = sandboxed("owner");
    await putAgent(runtime, owner);
    await fetch(`${runtime.url}/v1/sessions/s1`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({
        requestId: "s1",
        agentId: "owner",
        ownerUserId: "ada",
        sandbox: {},
      }),
    });
    const message = await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
      method: "POST",
      headers: serverHeaders,
      body: JSON.stringify({
        type: "message",
        requestId: "m1",
        idempotencyKey: "m1",
        content: "go",
      }),
    });
    expect(message.ok).toBe(true);

    for (let i = 0; i < 40; i++) {
      const session = (await (
        await fetch(`${runtime.url}/v1/sessions/s1`, { headers: serverHeaders })
      ).json()) as { activeTurnId: string | null };
      if (session.activeTurnId) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const refused = await fetch(`${runtime.url}/v1/sessions/s1/sandbox/bash`, {
      method: "POST",
      headers: serverHeaders,
      body: JSON.stringify({ command: "echo hi" }),
    });
    expect(refused.status).toBe(409);
    release();
  } finally {
    release();
    await runtime.close();
  }
});

it("rejects PutSession.sandbox when the target has no sandbox or another owner", async () => {
  const runtime = await boot();
  try {
    await putAgent(runtime, sandboxed("owner"));
    await putAgent(runtime, sandboxed("other"));
    const put = (id: string, body: Record<string, unknown>) =>
      fetch(`${runtime.url}/v1/sessions/${id}`, {
        method: "PUT",
        headers: serverHeaders,
        body: JSON.stringify({ requestId: id, ...body }),
      });
    await put("wf-1", { agentId: "owner", ownerUserId: "ada", sandbox: {} });
    await put("bare", { agentId: "owner", ownerUserId: "ada" });

    const inherits = await put("joins", { agentId: "other", ownerUserId: "ada", sandbox: { session: "wf-1" } });
    expect(inherits.ok, await inherits.clone().text()).toBe(true);

    const none = await put("no-box", { agentId: "other", ownerUserId: "ada", sandbox: { session: "bare" } });
    expect(none.status).toBe(400);
    expect(await none.text()).toContain("Target session has no sandbox to share");

    const foreign = await put("bad-owner", { agentId: "owner", ownerUserId: "bob", sandbox: { session: "wf-1" } });
    expect(foreign.status).toBe(403);
  } finally {
    await runtime.close();
  }
});

it("authorizes delivery-token-scoped POST /v1/actions/:id/sandbox/:tool", async () => {
  const { tool } = await import("@nylorun/core/define");
  const { z } = await import("zod");
  const agent = Agent({ id: "coder", name: "Coder" })
    .use({
      id: "work",
      tools: [
        tool({
          name: "note",
          input: z.object({ text: z.string() }),
          async run() {
            return { ok: true };
          },
        }),
      ],
    })
    .build();

  const runtime = await boot(async () => ({
    output: [
      {
        type: "tool-call",
        id: "call-1",
        name: "note",
        args: { text: "hi" },
      },
    ],
  }));
  const endpoint = await startEndpoint({ runtime });
  try {
    await putAgent(runtime, agent);
    await registerEndpoint(runtime, "coder", endpoint.url);
    await fetch(`${runtime.url}/v1/sessions/s1`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({
        requestId: "s1",
        agentId: "coder",
        ownerUserId: "ada",
        sandbox: {},
      }),
    });
    await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
      method: "POST",
      headers: serverHeaders,
      body: JSON.stringify({
        type: "message",
        requestId: "m1",
        idempotencyKey: "m1",
        content: "note",
      }),
    });

    const delivery = await endpoint.next();
    // The delivery tells the endpoint that ctx.sandbox is available.
    expect(delivery.sandbox).toBe(true);

    const write = await delivery.sandboxTool("write", { path: "delivered.txt", content: "ok" });
    expect(write.status, JSON.stringify(write.body)).toBe(200);
    expect(write.body.kind).toBe("completed");

    // Only the delivery token opens the route.
    const application = await fetch(
      `${runtime.url}/v1/actions/${encodeURIComponent(delivery.action.actionId)}/sandbox/bash`,
      {
        method: "POST",
        headers: serverHeaders,
        body: JSON.stringify({ command: "echo no" }),
      }
    );
    expect(application.ok).toBe(false);

    // Once the Action has its result, the delivery's token no longer runs sandbox tools.
    expect((await delivery.result({ kind: "completed", output: { ok: true } })).status).toBe(200);
    const stale = await delivery.sandboxTool("bash", { command: "echo no" });
    expect(stale.status).toBe(409);
  } finally {
    await endpoint.close();
    await runtime.close();
  }
});
