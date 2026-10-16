/**
 * Opening a session on an Agent (protocol 16): the session names the Agent it runs on, whose
 * runtime section was resolved against the Tenant's configuration when the Agent was made, and
 * pins the Agent's manifest version and its sandbox spec for the session's life.
 */
import { expect, it } from "vitest";
import { Agent, hashManifest, loopManifestOf } from "@nylorun/core/define";
import { startTestTenant } from "./support/tenant.js";
import { withTestSessionStore } from "./support/store.js";
import { deploy, manifestOf, openSession, writeManifest } from "./support/agents.js";
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

function open(runtime: { url: string }, id: string, agent: string, headers: Record<string, string> = serverHeaders) {
  return openSession(runtime.url, headers, id, { agent, ownerUserId: "ada" });
}

/** The sandbox spec the session pinned: on its row (`Session.sandbox`), not in its manifest. */
async function pinnedSandbox(
  runtime: Parameters<typeof withTestSessionStore>[0] & { url: string },
  id: string,
): Promise<unknown> {
  const response = await fetch(`${runtime.url}/v1/sessions/${id}/manifest`, { headers: serverHeaders });
  expect(response.ok).toBe(true);
  const view = (await response.json()) as { manifest: Record<string, unknown> };
  expect(view.manifest).not.toHaveProperty("runtime");
  return withTestSessionStore(runtime, (store) =>
    store.tx(async (t) => (await t.get<{ sandbox?: unknown }>("sessions", id))?.sandbox),
  );
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

it("gives no sandbox on an Agent of kind none, and pins the manifest version it runs", async () => {
  const runtime = await boot();
  try {
    await deploy(runtime.url, serverHeaders, plain("bot"));
    const opened = await open(runtime, "s1", "bot");
    expect(opened.ok, await opened.clone().text()).toBe(true);
    const view = (await opened.json()) as Record<string, unknown>;
    expect(view).toMatchObject({ agentId: "bot", manifest: { name: "bot", version: 1 }, harness: "nylorun" });
    expect(view).not.toHaveProperty("environment");
    expect(view).not.toHaveProperty("implementationVersion");
    // The session pins the loop manifest its version's harness section makes.
    expect(view.manifestHash).toBe(hashManifest(loopManifestOf(manifestOf(plain("bot"))) as never));
    expect(await pinnedSandbox(runtime, "s1")).toBeUndefined();
    expect((await tool(runtime, "s1", "bash", { command: "echo hi" })).status).toBe(404);
  } finally {
    await runtime.close();
  }
});

it("refuses a session on an Agent that does not exist", async () => {
  const runtime = await boot();
  try {
    const opened = await open(runtime, "s1", "nobody");
    expect(opened.status).toBe(404);
    // The old body is refused: sessions name an Agent.
    const old = await fetch(`${runtime.url}/v1/sessions/s2`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({ requestId: "r", agentId: "bot", ownerUserId: "ada" }),
    });
    expect(old.status).toBe(400);
  } finally {
    await runtime.close();
  }
});

it("pins the Agent's sandbox and adds the sandbox tools to the session only", async () => {
  const seen: unknown[] = [];
  const runtime = await boot(oneCall("bash", { command: "echo from-model" }, seen));
  try {
    await deploy(runtime.url, serverHeaders, plain("bot"), {
      id: "work/ada",
      runtime: { kind: "virtual", network: { allowedHosts: ["api.github.com"] }, resources: { cpus: 1 } },
    });
    const opened = await open(runtime, "s1", "work/ada");
    expect(opened.ok, await opened.clone().text()).toBe(true);
    expect(await pinnedSandbox(runtime, "s1")).toEqual({
      network: { preset: "none", allow: ["api.github.com"] },
      resources: { cpus: 1, memory: "1024MiB" },
      idle: "15m",
    });

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
    expect(items.items.find((item) => item.type === "agent.attached")?.payload).toEqual({ agentId: "work/ada" });
    const exec = items.items.find((item) => item.type === "environment.exec");
    expect(exec?.payload).toMatchObject({ tool: "bash", exitCode: 0, outcome: "completed" });
  } finally {
    await runtime.close();
  }
});

it("reports every problem with a manifest's runtime section in one plan, and saves nothing", async () => {
  const runtime = await boot();
  try {
    const manifest = manifestOf(plain("bad"), {
      runtime: { kind: "virtual", image: "node:24", network: { allowedHosts: ["api.openai.com"] }, resources: { cpus: 16 } },
    });
    const plan = await writeManifest(runtime.url, serverHeaders, manifest, { dryRun: true });
    expect(plan.status).toBe(200);
    const errors = (plan.body as { errors: string[] }).errors.join(" ");
    expect(errors).toContain("image is for kind pod");
    expect(errors).toContain("api.openai.com, which this Tenant does not allow");
    expect(errors).toContain("resources.cpus asks for 16");
    const refused = await writeManifest(runtime.url, serverHeaders, manifest);
    expect(refused.status).toBe(400);
    expect((await fetch(`${runtime.url}/v1/agent-manifests/bad`, { headers: serverHeaders })).status).toBe(404);
  } finally {
    await runtime.close();
  }
});

it("pins the Tenant's idle when the runtime section names none, and the section's when it does", async () => {
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

    await deploy(runtime.url, serverHeaders, plain("bot"), { name: "tenant-idle", id: "idle/tenant", runtime: { kind: "virtual" } });
    await open(runtime, "d1", "idle/tenant");
    expect(await pinnedSandbox(runtime, "d1")).toMatchObject({ idle: "5m", network: { preset: "none" } });
    await deploy(runtime.url, serverHeaders, plain("bot"), {
      name: "own-idle",
      id: "idle/own",
      runtime: { kind: "virtual", lifecycle: { idle: "2m" } },
    });
    await open(runtime, "d2", "idle/own");
    expect(await pinnedSandbox(runtime, "d2")).toMatchObject({ idle: "2m" });
    // Above the Tenant's: refused at save.
    const above = await writeManifest(
      runtime.url,
      serverHeaders,
      manifestOf(plain("bot"), { name: "above-idle", runtime: { kind: "virtual", lifecycle: { idle: "1h" } } }),
    );
    expect(above.status).toBe(400);
    expect(JSON.stringify(above.body)).toContain("lifecycle.idle is 1h; this Tenant allows at most 5m");

    // An Agent of kind none has no sandbox, whatever the Tenant's settings.
    await deploy(runtime.url, serverHeaders, plain("bot"));
    await open(runtime, "n1", "bot");
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

it("fixes the Agent for the session's life: another one is a 409", async () => {
  const runtime = await boot();
  try {
    await deploy(runtime.url, serverHeaders, plain("bot"), { id: "fixed/one" });
    await deploy(runtime.url, serverHeaders, plain("bot"), { id: "fixed/two" });
    expect((await open(runtime, "s1", "fixed/one")).ok).toBe(true);
    expect((await open(runtime, "s1", "fixed/one")).ok).toBe(true);
    expect((await open(runtime, "s1", "fixed/two")).status).toBe(409);
  } finally {
    await runtime.close();
  }
});

it("refuses a manifest whose subagent sets runtime, and a v7 manifest, with the way to rebuild", async () => {
  const runtime = await boot();
  try {
    const helper = Agent({ id: "helper", description: "Helps." }).instructions("Help.");
    const lead = Agent({ id: "lead", name: "lead" }).instructions("Lead.").subagents(helper).build();
    const manifest = JSON.parse(JSON.stringify(manifestOf(lead)));
    const tools = (manifest.harness as { tools: { agent?: Record<string, unknown> }[] }).tools;
    tools[0]!.agent = { ...tools[0]!.agent, runtime: { sandbox: {} } };
    const refused = await writeManifest(runtime.url, serverHeaders, manifest);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("This is a pre-v8 runtime block");
    const v7 = await fetch(`${runtime.url}/v1/agent-manifests/old`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({ ...plain("old").manifest, name: "old" }),
    });
    expect(v7.status).toBe(400);
    expect(await v7.text()).toContain("nylorun migrate v8");
  } finally {
    await runtime.close();
  }
});

it("lets a caller acting for a user open sessions on an Agent, but change one only with agents:write", async () => {
  const runtime = await boot();
  try {
    await deploy(runtime.url, serverHeaders, plain("bot"), { id: "people/ada" });
    const subject = {
      ...serverHeaders,
      "Nylorun-Subject": "ada",
      "Nylorun-Scopes": "sessions:own",
    };
    const opened = await open(runtime, "s1", "people/ada", subject);
    expect(opened.ok, await opened.clone().text()).toBe(true);
    expect(((await opened.json()) as { agentId: unknown }).agentId).toBe("people/ada");
    const refused = await fetch(`${runtime.url}/v1/agents/people%2Fada`, {
      method: "PUT",
      headers: subject,
      body: JSON.stringify({ manifest: "bot", labels: { team: "a" } }),
    });
    expect(refused.status).toBe(403);
    const writer = await fetch(`${runtime.url}/v1/agents/people%2Fada`, {
      method: "PUT",
      headers: { ...subject, "Nylorun-Scopes": "sessions:own agents:write" },
      body: JSON.stringify({ manifest: "bot", labels: { team: "a" } }),
    });
    expect(writer.ok, await writer.clone().text()).toBe(true);
    expect(((await writer.json()) as { labels: unknown }).labels).toEqual({ team: "a" });
    // Saving manifests takes its own scope.
    const save = await writeManifest(runtime.url, { ...subject, "Nylorun-Scopes": "agents:write" }, manifestOf(plain("other")));
    expect(save.status).toBe(403);
  } finally {
    await runtime.close();
  }
});

it("gives the agents a session uses as tools the same sandbox", async () => {
  const runtime = await boot();
  try {
    const helper = Agent({ id: "helper", description: "Helps." }).instructions("Help.");
    const lead = Agent({ id: "lead", name: "lead" }).instructions("Lead.").subagents(helper).build();
    await deploy(runtime.url, serverHeaders, lead, { id: "lead/ws", runtime: { kind: "virtual" } });
    const opened = await open(runtime, "s1", "lead/ws");
    expect(opened.ok, await opened.clone().text()).toBe(true);
    // One sandbox for the tree, on the session; the child's manifest is as it was saved.
    expect(await pinnedSandbox(runtime, "s1")).toMatchObject({ idle: "15m" });
    const pinned = (await (
      await fetch(`${runtime.url}/v1/sessions/s1/manifest`, { headers: serverHeaders })
    ).json()) as { definition: unknown; manifest: { tools?: { name: string; agent?: unknown }[] } };
    expect(pinned.definition).toEqual({ name: "lead", version: 1 });
    const child = pinned.manifest.tools?.find((item) => item.name === "helper")?.agent;
    expect(child).toEqual(lead.manifest.tools?.find((item) => item.name === "helper")?.agent);
  } finally {
    await runtime.close();
  }
});

it("saves a manifest with a tool named like a sandbox tool: no name is reserved (protocol 15)", async () => {
  const runtime = await boot();
  try {
    const saved = await writeManifest(runtime.url, serverHeaders, {
      manifestSchemaVersion: 8,
      name: "clash",
      harness: {
        instructions: ["x"],
        tools: [
          {
            name: "bash",
            description: "Not the sandbox's bash.",
            inputSchema: { type: "object", properties: {} },
            http: { url: "https://tools.example.com/bash" },
          },
        ],
      },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  } finally {
    await runtime.close();
  }
});
