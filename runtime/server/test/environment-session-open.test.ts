/**
 * Opening a session on an Environment (protocol 11): the session names the Environment it works
 * in, whose recipe was resolved against the Tenant's configuration when it was written, and its
 * sandbox spec is pinned for the session's life. The agent definition declares nothing.
 */
import { expect, it } from "vitest";
import { Agent, hashManifest, runtimeManifestFor } from "@nylorun/core/define";
import { startTestTenant } from "./support/tenant.js";
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

/** Creates (or finds) Environment `id` with `recipe`. */
async function environment(runtime: { url: string }, id: string, recipe: Record<string, unknown> = {}) {
  const response = await fetch(`${runtime.url}/v1/environments/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: serverHeaders,
    body: JSON.stringify(recipe),
  });
  return response;
}

/** The sandbox spec the session pinned: its pinned manifest's `runtime` block. */
async function pinnedSandbox(runtime: { url: string }, id: string): Promise<unknown> {
  const response = await fetch(`${runtime.url}/v1/sessions/${id}/manifest`, { headers: serverHeaders });
  expect(response.ok, await response.clone().text()).toBe(true);
  const view = (await response.json()) as { manifest: { runtime?: { sandbox?: unknown } } };
  return view.manifest.runtime?.sandbox;
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

it("gives no sandbox when the request names no Environment", async () => {
  const runtime = await boot();
  try {
    await register(runtime, plain("bot"));
    const opened = await open(runtime, "s1", { agentId: "bot" });
    expect(opened.ok, await opened.clone().text()).toBe(true);
    const view = (await opened.json()) as {
      environment: unknown;
      manifestHash: string;
      definitionHash?: string;
    };
    expect(view.environment).toBeNull();
    // The session pins its definition with read_artifact added (protocol 12).
    expect(view.manifestHash).not.toBe(hashManifest(plain("bot").manifest));
    expect(view.definitionHash).toBe(hashManifest(plain("bot").manifest));
    expect(await pinnedSandbox(runtime, "s1")).toBeUndefined();
    expect((await tool(runtime, "s1", "bash", { command: "echo hi" })).status).toBe(404);
  } finally {
    await runtime.close();
  }
});

it("pins the Environment's sandbox and adds the sandbox tools to the session only", async () => {
  const seen: unknown[] = [];
  const runtime = await boot(oneCall("bash", { command: "echo from-model" }, seen));
  try {
    await register(runtime, plain("bot"));
    const created = await environment(runtime, "work/ada", {
      network: { allowedHosts: ["api.github.com"] },
      resources: { cpus: 1 },
    });
    expect(created.ok, await created.clone().text()).toBe(true);
    const opened = await open(runtime, "s1", { agentId: "bot", environment: "work/ada" });
    expect(opened.ok, await opened.clone().text()).toBe(true);
    const view = (await opened.json()) as {
      environment: Record<string, unknown>;
      manifestHash: string;
    };
    expect(view.environment).toEqual({ id: "work/ada", version: 1 });
    expect(await pinnedSandbox(runtime, "s1")).toEqual({
      network: { preset: "none", allow: ["api.github.com"] },
      resources: { cpus: 1, memory: "1024MiB" },
      idle: "15m",
    });
    expect(view.manifestHash).not.toBe(hashManifest(plain("bot").manifest));

    // The registered definition is unchanged.
    const listed = (await (
      await fetch(`${runtime.url}/v1/agents`, { headers: serverHeaders })
    ).json()) as { agents: { agentId: string; manifest: { runtime?: unknown } }[] };
    const definition = listed.agents.find((item) => item.agentId === "bot")!;
    expect(definition.manifest.runtime).toBeUndefined();

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
    const exec = items.items.find((item) => item.type === "environment.exec");
    expect(exec?.payload).toMatchObject({ tool: "bash", exitCode: 0, outcome: "completed" });
  } finally {
    await runtime.close();
  }
});

it("reports every problem with an Environment's recipe in one 400", async () => {
  const runtime = await boot();
  try {
    const refused = await environment(runtime, "bad/one", {
      image: "node:24",
      network: { allowedHosts: ["api.openai.com"] },
      resources: { cpus: 16 },
    });
    expect(refused.status).toBe(400);
    const text = await refused.text();
    expect(text).toContain("image is for kind pod");
    expect(text).toContain("api.openai.com, which this Tenant does not allow");
    expect(text).toContain("resources.cpus asks for 16");
    // Nothing was created.
    expect(
      (await fetch(`${runtime.url}/v1/environments/bad%2Fone`, { headers: serverHeaders })).status
    ).toBe(404);
  } finally {
    await runtime.close();
  }
});

it("pins the Tenant's idle when the recipe names none, and the recipe's when it does", async () => {
  const runtime = await boot();
  try {
    const saved = await fetch(`${runtime.url}/v1/tenant/sandbox`, {
      method: "PUT",
      headers: runtime.managementHeaders(),
      body: JSON.stringify({ limits: { idle: "5m" } }),
    });
    expect(saved.ok, await saved.clone().text()).toBe(true);
    const report = (await saved.json()) as { backend: string; config: Record<string, any> };
    expect(report.backend).toBe("virtual");
    expect(report.config).toMatchObject({ limits: { idle: "5m" } });
    // The Tenant default sandbox is gone (protocol 11).
    const old = await fetch(`${runtime.url}/v1/tenant/sandbox`, {
      method: "PUT",
      headers: runtime.managementHeaders(),
      body: JSON.stringify({ default: "virtual" }),
    });
    expect(old.status).toBe(400);

    await register(runtime, plain("bot"));
    await environment(runtime, "idle/tenant");
    await open(runtime, "d1", { agentId: "bot", environment: "idle/tenant" });
    expect(await pinnedSandbox(runtime, "d1")).toMatchObject({ idle: "5m", network: { preset: "none" } });
    await environment(runtime, "idle/own", { lifecycle: { idle: "2m" } });
    await open(runtime, "d2", { agentId: "bot", environment: "idle/own" });
    expect(await pinnedSandbox(runtime, "d2")).toMatchObject({ idle: "2m" });
    // Above the Tenant's: refused.
    const above = await environment(runtime, "idle/above", { lifecycle: { idle: "1h" } });
    expect(above.status).toBe(400);
    expect(await above.text()).toContain("lifecycle.idle is 1h; this Tenant allows at most 5m");

    // A session with no Environment has no sandbox, whatever the Tenant's settings.
    const none = (await (await open(runtime, "n1", { agentId: "bot" })).json()) as {
      environment: unknown;
    };
    expect(none.environment).toBeNull();
    expect(await pinnedSandbox(runtime, "n1")).toBeUndefined();
  } finally {
    await runtime.close();
  }
});

it("refuses to save a Tenant configuration whose defaults break its own limits", async () => {
  const runtime = await boot();
  try {
    const refused = await fetch(`${runtime.url}/v1/tenant/sandbox`, {
      method: "PUT",
      headers: runtime.managementHeaders(),
      body: JSON.stringify({
        limits: { resources: { cpus: 2 }, defaultResources: { cpus: 3 } },
      }),
    });
    expect(refused.status).toBe(400);
    const text = await refused.text();
    expect(text).toContain("limits.defaultResources.cpus is above limits.resources.cpus.");
  } finally {
    await runtime.close();
  }
});

it("fixes the Environment for the session's life: a different one is a 409", async () => {
  const runtime = await boot();
  try {
    await register(runtime, plain("bot"));
    await environment(runtime, "fixed/one");
    await environment(runtime, "fixed/two");
    expect((await open(runtime, "s1", { agentId: "bot", environment: "fixed/one" })).ok).toBe(true);
    expect((await open(runtime, "s1", { agentId: "bot", environment: "fixed/one" })).ok).toBe(true);
    expect((await open(runtime, "s1", { agentId: "bot", environment: "fixed/two" })).status).toBe(409);
    expect((await open(runtime, "s1", { agentId: "bot" })).status).toBe(409);
  } finally {
    await runtime.close();
  }
});

it("refuses to register a definition that sets runtime, which only the Runtime writes", async () => {
  const runtime = await boot();
  try {
    const manifest = { ...plain("old").manifest, runtime: runtimeManifestFor({}, { sandbox: {} }) };
    const refused = await fetch(`${runtime.url}/v1/agents/old`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({ requestId: "put-old", manifest, implementationVersion: "dev" }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("'old' sets runtime, which only the Runtime writes");
  } finally {
    await runtime.close();
  }
});

it("lets a caller acting for a user open sessions on an Environment, but change one only with environments:write", async () => {
  const runtime = await boot();
  try {
    await register(runtime, plain("bot"));
    await environment(runtime, "people/ada");
    const subject = {
      ...serverHeaders,
      "Nylorun-Subject": "ada",
      "Nylorun-Scopes": "sessions:own",
    };
    const opened = await open(runtime, "s1", { agentId: "bot", environment: "people/ada" }, subject);
    expect(opened.ok, await opened.clone().text()).toBe(true);
    expect(((await opened.json()) as { environment: unknown }).environment).toEqual({
      id: "people/ada",
      version: 1,
    });
    expect((await open(runtime, "s2", { agentId: "bot" }, subject)).ok).toBe(true);
    const refused = await fetch(`${runtime.url}/v1/environments/people%2Fada`, {
      method: "PUT",
      headers: subject,
      body: JSON.stringify({ resources: { cpus: 1 } }),
    });
    expect(refused.status).toBe(403);
    const writer = await fetch(`${runtime.url}/v1/environments/people%2Fada`, {
      method: "PUT",
      headers: { ...subject, "Nylorun-Scopes": "sessions:own environments:write" },
      body: JSON.stringify({ resources: { cpus: 1 } }),
    });
    expect(writer.ok, await writer.clone().text()).toBe(true);
    expect(((await writer.json()) as { version: number }).version).toBe(2);
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
    await environment(runtime, "lead/ws");
    const opened = await open(runtime, "s1", { agentId: "lead", environment: "lead/ws" });
    expect(opened.ok, await opened.clone().text()).toBe(true);
    const pinned = (await (
      await fetch(`${runtime.url}/v1/sessions/s1/manifest`, { headers: serverHeaders })
    ).json()) as { manifest: { runtime?: { sandbox?: unknown }; tools?: { name: string; agent?: unknown }[] } };
    const child = pinned.manifest.tools?.find((item) => item.name === "helper")?.agent as
      | { runtime?: { sandbox?: unknown; tools?: { name: string }[] } }
      | undefined;
    expect(child?.runtime?.sandbox).toEqual(pinned.manifest.runtime?.sandbox);
    expect(child?.runtime?.tools?.map((item) => item.name)).toContain("bash");
  } finally {
    await runtime.close();
  }
});

it("refuses to register an agent with a tool named like a sandbox tool", async () => {
  const runtime = await boot();
  try {
    const manifest = {
      manifestSchemaVersion: 7,
      id: "clash",
      instructions: ["x"],
      tools: [
        {
          name: "bash",
          description: "Not the sandbox's bash.",
          inputSchema: { type: "object", properties: {} },
          http: { url: "https://tools.example.com/bash" },
        },
      ],
    };
    const refused = await fetch(`${runtime.url}/v1/agents/clash`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({ requestId: "put-clash", manifest, implementationVersion: "dev" }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("takes the name of a tool the Runtime serves");
  } finally {
    await runtime.close();
  }
});
