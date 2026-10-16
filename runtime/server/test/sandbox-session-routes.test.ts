import { expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { startTestTenant } from "./support/tenant.js";
import { deploy, openSession } from "./support/agents.js";
import type { ModelProvider } from "../src/core/provider.js";

const APP = "server-token-value-aaaaaaaa";
const serverHeaders = {
  authorization: `Bearer ${APP}`,
  "content-type": "application/json",
};

/** Loops declare no sandbox; sessions are opened on an Agent whose runtime section has one. */
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

/** Opens session `id` on Agent `agent` for `ownerUserId`. */
const open = (runtime: { url: string }, id: string, agent: string, ownerUserId = "ada") =>
  openSession(runtime.url, serverHeaders, id, { agent, ownerUserId });

it("runs session sandbox tools in the workspace of the Agent the sessions run on", async () => {
  const runtime = await boot();
  try {
    await deploy(runtime.url, serverHeaders, sandboxed("owner"), { id: "work/shared", runtime: { kind: "virtual" } });

    const ownerSession = await open(runtime, "wf-1", "work/shared");
    expect(ownerSession.ok, await ownerSession.clone().text()).toBe(true);

    const shared = await open(runtime, "agent-1", "work/shared");
    expect(shared.ok, await shared.clone().text()).toBe(true);
    const view = (await shared.json()) as Record<string, unknown>;
    expect(view).toMatchObject({ agentId: "work/shared", manifest: { name: "owner", version: 1 } });

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
    await deploy(runtime.url, serverHeaders, sandboxed("owner"), { id: "busy/ws", runtime: { kind: "virtual" } });
    const opened = await open(runtime, "s1", "busy/ws");
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

it("refuses a session on a missing Agent or one guarded for another owner, and tools without a sandbox", async () => {
  const runtime = await boot();
  try {
    await deploy(runtime.url, serverHeaders, sandboxed("owner"), { id: "ada/ws", runtime: { kind: "virtual" }, owner: "ada" });
    // Kind none: without a runtime section, or one that says so.
    await deploy(runtime.url, serverHeaders, sandboxed("other"), { id: "bare/ws" });
    await deploy(runtime.url, serverHeaders, sandboxed("other"), { name: "plain", id: "plain/ws", runtime: { kind: "none" } });

    const joins = await open(runtime, "joins", "ada/ws");
    expect(joins.ok, await joins.clone().text()).toBe(true);

    const missing = await open(runtime, "no-env", "nowhere/ws");
    expect(missing.status).toBe(404);

    const foreign = await open(runtime, "bad-owner", "ada/ws", "bob");
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { code: string }).code).toBe("agent_owner_mismatch");

    // A session with no sandbox has no sandbox tools: an Agent of kind none.
    expect((await open(runtime, "bare", "bare/ws")).ok).toBe(true);
    expect((await open(runtime, "plain", "plain/ws")).ok).toBe(true);
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
