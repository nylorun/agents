/**
 * Sandboxes v3, Phase 1: the sandbox is chosen when a session is opened, resolved against the
 * Tenant's configuration, and pinned. The agent definition declares nothing.
 */
import { expect, it } from "vitest";
import {
  Agent,
  SANDBOX_CAPABILITY_ID,
  hashManifest,
  sandboxCapabilityManifest,
} from "@nylorun/core/define";
import { startTestTenant } from "./support/tenant.js";
import { withTestSessionStore } from "./support/store.js";
import type { ModelProvider } from "../src/core/provider.js";

const APP = "server-token-value-aaaaaaaa";
const serverHeaders = {
  authorization: `Bearer ${APP}`,
  "content-type": "application/json",
};

const plain = (id: string) => Agent({ id, name: id }).instructions("Work in the sandbox.").build();

async function boot(modelProvider?: ModelProvider) {
  return startTestTenant({
    mode: "test",
    applicationKey: APP,
    vaultKek: null,
    modelProvider: modelProvider ?? (async () => ({ output: [{ type: "text", text: "ok" }] })),
    sandbox: { backend: "virtual" },
  });
}

async function register(runtime: { url: string }, agent: { id: string; manifest: unknown }) {
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

function open(
  runtime: { url: string },
  id: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = serverHeaders
) {
  return fetch(`${runtime.url}/v1/sessions/${id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ requestId: `open-${id}`, ownerUserId: "ada", ...body }),
  });
}

function tool(runtime: { url: string }, id: string, name: string, args: Record<string, unknown>) {
  return fetch(`${runtime.url}/v1/sessions/${id}/sandbox/${name}`, {
    method: "POST",
    headers: serverHeaders,
    body: JSON.stringify(args),
  });
}

/** A model that calls one tool, then answers with the tool's result. */
function oneCall(name: string, args: Record<string, unknown>, seen: unknown[]): ModelProvider {
  return async (effect) => {
    const prompt = (effect.input as { prompt?: { kind?: string }[] }).prompt ?? [];
    const results = prompt.filter((item) => item.kind === "tool-result");
    const tools = (effect.input as { tools?: { name: string }[] }).tools ?? [];
    seen.push(tools.map((item) => item.name));
    if (results.length > 0) return { output: [{ type: "text", text: JSON.stringify(results.at(-1)) }] };
    return { output: [{ type: "tool-call", id: `call-${effect.turnId}`, name, args }] };
  };
}

it("gives no sandbox when the request omits it and the Tenant has no default", async () => {
  const runtime = await boot();
  try {
    await register(runtime, plain("bot"));
    const opened = await open(runtime, "s1", { agentId: "bot" });
    expect(opened.ok, await opened.clone().text()).toBe(true);
    const view = (await opened.json()) as { sandbox: unknown; manifestHash: string };
    expect(view.sandbox).toBeNull();
    expect(view.manifestHash).toBe(hashManifest(plain("bot").manifest));
    expect((await tool(runtime, "s1", "bash", { command: "echo hi" })).status).toBe(404);
  } finally {
    await runtime.close();
  }
});

it("pins an inline sandbox and adds the sandbox tools to the session only", async () => {
  const seen: unknown[] = [];
  const runtime = await boot(oneCall("bash", { command: "echo from-model" }, seen));
  try {
    await register(runtime, plain("bot"));
    const opened = await open(runtime, "s1", {
      agentId: "bot",
      sandbox: { network: { allow: ["api.github.com"] }, resources: { cpus: 1 } },
    });
    expect(opened.ok, await opened.clone().text()).toBe(true);
    const view = (await opened.json()) as {
      sandbox: Record<string, unknown>;
      sandboxSource: string;
      manifestHash: string;
    };
    expect(view.sandboxSource).toBe("inline");
    expect(view.sandbox).toEqual({
      network: { preset: "none", allow: ["api.github.com"] },
      resources: { cpus: 1, memory: "1024MiB" },
      idle: "15m",
    });
    expect(view.manifestHash).not.toBe(hashManifest(plain("bot").manifest));

    // The registered definition is unchanged.
    const listed = (await (
      await fetch(`${runtime.url}/v1/agents`, { headers: serverHeaders })
    ).json()) as { agents: { agentId: string; manifest: { capabilities: { id: string }[] } }[] };
    const definition = listed.agents.find((item) => item.agentId === "bot")!;
    expect(definition.manifest.capabilities.map((item) => item.id)).not.toContain(
      SANDBOX_CAPABILITY_ID
    );

    // The model sees the six tools and runs one in the sandbox.
    await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
      method: "POST",
      headers: serverHeaders,
      body: JSON.stringify({ type: "message", requestId: "m1", idempotencyKey: "m1", content: "go" }),
    });
    let session: { status: string } = { status: "" };
    for (let attempt = 0; attempt < 200 && !["completed", "failed"].includes(session.status); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      session = (await (await fetch(`${runtime.url}/v1/sessions/s1`, { headers: serverHeaders })).json()) as {
        status: string;
      };
    }
    expect(session.status).toBe("completed");
    expect(seen[0]).toEqual(expect.arrayContaining(["bash", "read", "write", "edit", "grep", "glob"]));
    const items = (await (
      await fetch(`${runtime.url}/v1/sessions/s1/items`, { headers: serverHeaders })
    ).json()) as { items: { type: string; payload: any }[] };
    const exec = items.items.find((item) => item.type === "sandbox.exec");
    expect(exec?.payload).toMatchObject({ tool: "bash", exitCode: 0, outcome: "completed" });
  } finally {
    await runtime.close();
  }
});

it("reports every problem with an inline sandbox in one 400", async () => {
  const runtime = await boot();
  try {
    await register(runtime, plain("bot"));
    const refused = await open(runtime, "s1", {
      agentId: "bot",
      sandbox: {
        image: "node:24",
        network: { allow: ["api.openai.com"] },
        resources: { cpus: 16 },
      },
    });
    expect(refused.status).toBe(400);
    const text = await refused.text();
    expect(text).toContain("sandbox.image is not supported");
    expect(text).toContain("api.openai.com, which this Tenant does not allow");
    expect(text).toContain("sandbox.resources.cpus asks for 16");
    // Nothing was created.
    expect((await fetch(`${runtime.url}/v1/sessions/s1`, { headers: serverHeaders })).status).toBe(404);
  } finally {
    await runtime.close();
  }
});

it("uses the Tenant default when the request omits the sandbox, and none for false", async () => {
  const runtime = await boot();
  try {
    const saved = await fetch(`${runtime.url}/v1/tenant/sandbox`, {
      method: "PUT",
      headers: runtime.managementHeaders(),
      body: JSON.stringify({ default: "virtual", limits: { idle: "5m" } }),
    });
    expect(saved.ok, await saved.clone().text()).toBe(true);
    const report = (await saved.json()) as { backend: string; config: Record<string, any> };
    expect(report.backend).toBe("virtual");
    expect(report.config).toMatchObject({ default: "virtual", limits: { idle: "5m" } });

    await register(runtime, plain("bot"));
    const byDefault = (await (await open(runtime, "d1", { agentId: "bot" })).json()) as {
      sandbox: Record<string, unknown>;
      sandboxSource: string;
    };
    expect(byDefault.sandboxSource).toBe("default");
    expect(byDefault.sandbox).toMatchObject({ idle: "5m", network: { preset: "none" } });

    const none = (await (await open(runtime, "n1", { agentId: "bot", sandbox: false })).json()) as {
      sandbox: unknown;
    };
    expect(none.sandbox).toBeNull();
  } finally {
    await runtime.close();
  }
});

it("refuses to save a Tenant configuration whose default breaks its own limits", async () => {
  const runtime = await boot();
  try {
    const refused = await fetch(`${runtime.url}/v1/tenant/sandbox`, {
      method: "PUT",
      headers: runtime.managementHeaders(),
      body: JSON.stringify({
        default: { network: { allow: ["api.openai.com"] } },
        limits: { resources: { cpus: 2 }, defaultResources: { cpus: 3 } },
      }),
    });
    expect(refused.status).toBe(400);
    const text = await refused.text();
    expect(text).toContain("limits.defaultResources.cpus is above limits.resources.cpus.");
    expect(text).toContain("default: sandbox.network.allow includes api.openai.com");
  } finally {
    await runtime.close();
  }
});

it("fixes the sandbox for the session's life: a different one is a 409", async () => {
  const runtime = await boot();
  try {
    await register(runtime, plain("bot"));
    expect((await open(runtime, "s1", { agentId: "bot", sandbox: {} })).ok).toBe(true);
    expect((await open(runtime, "s1", { agentId: "bot", sandbox: {} })).ok).toBe(true);
    expect((await open(runtime, "s1", { agentId: "bot", sandbox: false })).status).toBe(409);
  } finally {
    await runtime.close();
  }
});

it("shares a pinned sandbox with a session whose agent declares none", async () => {
  const runtime = await boot();
  try {
    await register(runtime, plain("lead"));
    await register(runtime, plain("helper"));
    expect((await open(runtime, "lead-1", { agentId: "lead", sandbox: {} })).ok).toBe(true);
    const shared = await open(runtime, "helper-1", {
      agentId: "helper",
      sandbox: { session: "lead-1" },
    });
    expect(shared.ok, await shared.clone().text()).toBe(true);
    const view = (await shared.json()) as { sandboxOwnerId: string; sandboxSource: string };
    expect(view).toMatchObject({ sandboxOwnerId: "lead-1", sandboxSource: "shared" });

    expect((await tool(runtime, "lead-1", "write", { path: "note.txt", content: "shared" })).ok).toBe(true);
    const read = (await (await tool(runtime, "helper-1", "read", { path: "note.txt" })).json()) as {
      output: string;
    };
    expect(read.output).toContain("shared");
  } finally {
    await runtime.close();
  }
});

/** A definition that declares a sandbox, as agents built with `.sandbox()` did before Sandboxes v3. */
function declaredSandbox(id: string) {
  const manifest = plain(id).manifest;
  return {
    ...manifest,
    capabilities: [...manifest.capabilities, { ...sandboxCapabilityManifest({}), id: "sandbox" }],
  };
}

it("refuses to register a definition that declares a sandbox", async () => {
  const runtime = await boot();
  try {
    const refused = await fetch(`${runtime.url}/v1/agents/old`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({ requestId: "put-old", manifest: declaredSandbox("old"), implementationVersion: "dev" }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("'old' (capability 'sandbox') declares a sandbox");
  } finally {
    await runtime.close();
  }
});

it("keeps a sandbox declared by a definition stored before the upgrade", async () => {
  const runtime = await boot();
  try {
    const manifest = declaredSandbox("old");
    await withTestSessionStore({ root: runtime.root, tenantId: runtime.tenantId }, (store) =>
      store.tx((t) =>
        t.put("definitions", "old", {
          manifest,
          manifestHash: hashManifest(manifest),
          implementationVersion: "dev",
        })
      )
    );
    const legacy = await open(runtime, "legacy", { agentId: "old" });
    expect(legacy.ok, await legacy.clone().text()).toBe(true);
    expect(((await legacy.json()) as { sandbox: unknown }).sandbox).toBeNull();
    expect((await tool(runtime, "legacy", "bash", { command: "echo ok" })).ok).toBe(true);
    const refused = await open(runtime, "both", { agentId: "old", sandbox: {} });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("declares its own sandbox with .sandbox()");
  } finally {
    await runtime.close();
  }
});

it("lets a caller acting for a user use the default, but not define a sandbox", async () => {
  const runtime = await boot();
  try {
    await register(runtime, plain("bot"));
    const subject = {
      ...serverHeaders,
      "Nylorun-Subject": "ada",
      "Nylorun-Scopes": "sessions:own",
    };
    const refused = await open(runtime, "s1", { agentId: "bot", sandbox: {} }, subject);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("Defining a sandbox needs an application key");
    expect((await open(runtime, "s2", { agentId: "bot", sandbox: false }, subject)).ok).toBe(true);
    expect((await open(runtime, "s3", { agentId: "bot" }, subject)).ok).toBe(true);
  } finally {
    await runtime.close();
  }
});

it("gives the agents a session uses as tools the same sandbox", async () => {
  const runtime = await boot();
  try {
    const helper = Agent({ id: "helper", description: "Helps." }).instructions("Help.");
    const lead = Agent({ id: "lead", name: "lead" }).instructions("Lead.").subagents(helper).build();
    await register(runtime, lead);
    const opened = await open(runtime, "s1", { agentId: "lead", sandbox: {} });
    expect(opened.ok, await opened.clone().text()).toBe(true);
    const { withSandboxCapability } = await import("../src/sandbox/session-sandbox.js");
    const sandboxed = withSandboxCapability(lead.manifest, { network: { preset: "none" } });
    expect(sandboxed.ok).toBe(true);
    const child = sandboxed.ok
      ? sandboxed.manifest.capabilities
          .flatMap((item) => item.tools ?? [])
          .find((item) => item.name === "helper")?.agent
      : undefined;
    expect(
      (child as { capabilities: { id: string }[] } | undefined)?.capabilities.map((item) => item.id)
    ).toContain(SANDBOX_CAPABILITY_ID);
  } finally {
    await runtime.close();
  }
});

it("refuses a sandbox for an agent with a tool named like a sandbox tool", async () => {
  const runtime = await boot();
  try {
    const { tool } = await import("@nylorun/core/define");
    const { z } = await import("zod");
    const bash = tool({
      name: "bash",
      description: "Not the sandbox's bash.",
      input: z.object({}),
      async run() {
        return "ok";
      },
    });
    const clash = Agent({ id: "clash", name: "clash" }).instructions("x").tools(bash).build();
    await register(runtime, clash);
    const refused = await open(runtime, "s1", { agentId: "clash", sandbox: {} });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("declares a tool named like a sandbox tool");
  } finally {
    await runtime.close();
  }
});
