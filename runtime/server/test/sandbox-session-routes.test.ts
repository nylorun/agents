import { expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { startTestTenant } from "./support/tenant.js";
import type { ModelProvider } from "../src/core/provider.js";

const APP = "server-token-value-aaaaaaaa";
const serverHeaders = {
  authorization: `Bearer ${APP}`,
  "content-type": "application/json",
};

/** Agents declare no sandbox; sessions are opened on an Environment with one. */
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

async function putEnvironment(
  runtime: { url: string },
  id: string,
  recipe: Record<string, unknown> = {}
) {
  const response = await fetch(`${runtime.url}/v1/environments/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: serverHeaders,
    body: JSON.stringify(recipe),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
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

it("runs session sandbox tools in the workspace of the Environment the sessions name", async () => {
  const runtime = await boot();
  try {
    const owner = sandboxed("owner");
    const child = sandboxed("child");
    await putAgent(runtime, owner);
    await putAgent(runtime, child);
    await putEnvironment(runtime, "work/shared");

    const ownerSession = await fetch(`${runtime.url}/v1/sessions/wf-1`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({
        requestId: "sess-owner",
        agentId: "owner",
        ownerUserId: "ada",
        environment: "work/shared",
      }),
    });
    expect(ownerSession.ok, await ownerSession.clone().text()).toBe(true);

    const shared = await fetch(`${runtime.url}/v1/sessions/agent-1`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({
        requestId: "sess-child",
        agentId: "child",
        ownerUserId: "ada",
        environment: "work/shared",
      }),
    });
    expect(shared.ok, await shared.clone().text()).toBe(true);
    const view = (await shared.json()) as { environment: unknown };
    expect(view.environment).toEqual({ id: "work/shared", version: 1 });

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
    await putEnvironment(runtime, "busy/ws");
    const opened = await fetch(`${runtime.url}/v1/sessions/s1`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({
        requestId: "s1",
        agentId: "owner",
        ownerUserId: "ada",
        environment: "busy/ws",
      }),
    });
    expect(opened.ok, await opened.clone().text()).toBe(true);
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

it("refuses a session on a missing Environment or one guarded for another owner, and tools without a sandbox", async () => {
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
    await putEnvironment(runtime, "ada/ws", { ownerUserId: "ada" });
    await putEnvironment(runtime, "plain/ws", { kind: "none" });

    const joins = await put("joins", { agentId: "other", ownerUserId: "ada", environment: "ada/ws" });
    expect(joins.ok, await joins.clone().text()).toBe(true);

    const missing = await put("no-env", { agentId: "other", ownerUserId: "ada", environment: "nowhere/ws" });
    expect(missing.status).toBe(404);

    const foreign = await put("bad-owner", { agentId: "owner", ownerUserId: "bob", environment: "ada/ws" });
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { code: string }).code).toBe("environment_owner_mismatch");

    // A session with no sandbox has no sandbox tools: none named, or one of kind none.
    await put("bare", { agentId: "owner", ownerUserId: "ada" });
    await put("plain", { agentId: "owner", ownerUserId: "ada", environment: "plain/ws" });
    for (const id of ["bare", "plain"]) {
      const refused = await fetch(`${runtime.url}/v1/sessions/${id}/sandbox/bash`, {
        method: "POST",
        headers: serverHeaders,
        body: JSON.stringify({ command: "echo hi" }),
      });
      expect(refused.status, id).toBe(404);
      expect(await refused.text()).toContain("Session has no sandbox");
    }
  } finally {
    await runtime.close();
  }
});
