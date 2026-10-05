import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { registerEndpoint, startEndpoint } from "./support/endpoint.js";
import { patchStoredSession, startTestTenant } from "./support/tenant.js";

const APP = "server-token-value-aaaaaaaa";
import type { TenantConfig } from "../src/tenant/types.js";
import type { ModelProvider } from "../src/core/provider.js";
import type { SandboxBackend } from "../src/sandbox/types.js";
import { virtualBackend } from "../src/adapters/sandbox/virtual.js";

const serverHeaders = {
  authorization: `Bearer ${APP}`,
  "content-type": "application/json",
};

const agent = () => Agent({ id: "bot", name: "Bot" }).instructions("Use the sandbox.").build();

async function boot(
  options: {
    modelProvider: ModelProvider;
    sandbox?: TenantConfig["sandbox"];
    hostRoot?: string;
    tenantId?: string;
    retainRoot?: boolean;
  },
) {
  return startTestTenant({
    mode: "test",
    applicationKey: APP,
    vaultKek: null,
    modelProvider: options.modelProvider,
    sandbox: options.sandbox ?? { backend: "virtual" },
    ...(options.hostRoot ? { hostRoot: options.hostRoot } : {}),
    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
    ...(options.retainRoot ? { retainRoot: true } : {}),
  });
}

async function register(runtime: { url: string }, manifest: unknown) {
  const response = await fetch(`${runtime.url}/v1/agents/bot`, {
    method: "PUT",
    headers: serverHeaders,
    body: JSON.stringify({ requestId: "put-agent", manifest, implementationVersion: "dev" }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
}

async function openSession(runtime: { url: string }, id: string) {
  const response = await fetch(`${runtime.url}/v1/sessions/${id}`, {
    method: "PUT",
    headers: serverHeaders,
    body: JSON.stringify({ requestId: `session-${id}`, agentId: "bot", ownerUserId: "ada", sandbox: {} }),
  });
  expect(response.ok).toBe(true);
}

async function say(runtime: { url: string }, id: string, content: string) {
  const response = await fetch(`${runtime.url}/v1/sessions/${id}/commands`, {
    method: "POST",
    headers: serverHeaders,
    body: JSON.stringify({
      type: "message",
      requestId: `msg-${id}-${content}`,
      idempotencyKey: `msg-${id}-${content}`,
      content,
    }),
  });
  expect(response.ok).toBe(true);
}

async function until(runtime: { url: string }, id: string, statuses: readonly string[]) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const body = await (await fetch(`${runtime.url}/v1/sessions/${id}`, { headers: serverHeaders })).json();
    if (statuses.includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session ${id} did not reach ${statuses.join(", ")}`);
}

async function items(runtime: { url: string }, id: string) {
  const body = await (await fetch(`${runtime.url}/v1/sessions/${id}/items`, { headers: serverHeaders })).json();
  return body.items as { type: string; payload: any }[];
}

/** A model that plays a fixed list of tool calls, one per step, then answers. */
function script(calls: readonly { name: string; args: Record<string, unknown> }[], results: unknown[] = []): ModelProvider {
  const baseline = new Map<string, number>();
  return async (effect) => {
    const prompt = (effect.input as { prompt?: { kind?: string; content?: unknown }[] }).prompt ?? [];
    const all = prompt.filter((item) => item.kind === "tool-result");
    if (!baseline.has(effect.turnId)) baseline.set(effect.turnId, all.length);
    const step = all.length - baseline.get(effect.turnId)!;
    if (step > 0) results.push(all.at(-1));
    const next = calls[step];
    if (!next) return { output: [{ type: "text", text: "done" }] };
    return { output: [{ type: "tool-call", id: `call-${effect.turnId}-${step}`, name: next.name, args: next.args }] };
  };
}

it("runs built-in sandbox tools in the Runtime without delivering an Action", async () => {
  const results: unknown[] = [];
  const runtime = await boot({
    retainRoot: true,
    modelProvider: script(
      [
        { name: "write", args: { path: "data.csv", content: "region,sales\nnorth,3\nsouth,4\n" } },
        { name: "bash", args: { command: "awk -F, 'NR>1{s+=$2} END{print s}' data.csv" } },
      ],
      results
    ),
  });
  let closeEndpoint = async () => {};
  try {
    const host = await (await fetch(`${runtime.url}/v1/tenant/sandbox`, { headers: runtime.managementHeaders() })).json();
    expect(host).toMatchObject({ backend: "virtual", isolation: "process", defaultImage: "python:3.13-slim" });
    await register(runtime, agent().manifest);
    // The agent has an Action endpoint, but the sandbox tools never reach it.
    const endpoint = await startEndpoint({ runtime });
    closeEndpoint = () => endpoint.close();
    await registerEndpoint(runtime, "bot", endpoint.url);
    await openSession(runtime, "s1");
    await say(runtime, "s1", "sum the sales");
    const session = await until(runtime, "s1", ["completed", "failed", "uncertain"]);
    expect(session.status).toBe("completed");
    expect(JSON.stringify(results.at(-1))).toContain('\\"stdout\\":\\"7\\\\n\\"');
    expect(endpoint.deliveries).toEqual([]);
    const history = await items(runtime, "s1");
    expect(history.some((item) => item.type === "action.pending")).toBe(false);
    expect(history.filter((item) => item.type === "sandbox.state").map((item) => item.payload.state)).toEqual([
      "creating",
      "running",
    ]);
    const execs = history.filter((item) => item.type === "sandbox.exec");
    expect(execs.map((item) => item.payload.tool)).toEqual(["write", "bash"]);
    expect(execs[1]!.payload).toMatchObject({ exitCode: 0, outcome: "completed" });
  } finally {
    await closeEndpoint();
    await runtime.close();
  }
  // Files persist across a Runtime restart; the sandbox reattaches.
  const again = await boot({
    hostRoot: runtime.root,
    tenantId: runtime.tenantId,
    modelProvider: script([{ name: "read", args: { path: "data.csv" } }], results),
  });
  try {
    await say(again, "s1", "read it back");
    const session = await until(again, "s1", ["completed", "failed", "uncertain"]);
    expect(session.status).toBe("completed");
    expect(JSON.stringify(results.at(-1))).toContain("north,3");
    const history = await items(again, "s1");
    expect(history.filter((item) => item.type === "sandbox.state").at(-2)?.payload).toMatchObject({
      state: "creating",
      reattach: true,
    });
  } finally {
    await again.close();
    await rm(runtime.root, { recursive: true, force: true });
  }
});

it("returns an unavailable backend as a failed tool result the model can read", async () => {
  const results: unknown[] = [];
  const runtime = await boot({
    modelProvider: script([{ name: "bash", args: { command: "ls" } }], results),
    sandbox: {
      backend: "virtual",
      backends: [fakeBackend({ available: false })],
    },
  });
  try {
    await register(runtime, agent().manifest);
    await openSession(runtime, "s1");
    await say(runtime, "s1", "list");
    const session = await until(runtime, "s1", ["completed", "failed", "uncertain"]);
    expect(session.status).toBe("completed");
    expect(JSON.stringify(results.at(-1))).toContain("sandbox.unavailable");
    expect(JSON.stringify(results.at(-1))).toContain("doctor sandbox");
  } finally {
    await runtime.close();
  }
});

it("treats a backend failure during a write tool as uncertain and never re-runs it", async () => {
  const backend = fakeBackend({ available: true, execThrows: true });
  const runtime = await boot({
    retainRoot: true,
    modelProvider: script([{ name: "bash", args: { command: "rm -rf build" } }]),
    sandbox: { backend: "virtual", backends: [backend] },
  });
  try {
    await register(runtime, agent().manifest);
    await openSession(runtime, "s1");
    await say(runtime, "s1", "clean");
    const session = await until(runtime, "s1", ["completed", "failed", "uncertain"]);
    expect(session.status).toBe("uncertain");
    expect(backend.execs).toBe(1);
  } finally {
    await runtime.close();
  }
  await patchStoredSession(runtime.root, runtime.tenantId, "s1", { status: "runnable" });
  const again = await boot({
    hostRoot: runtime.root,
    tenantId: runtime.tenantId,
    modelProvider: async () => {
      throw new Error("model must not run again");
    },
    sandbox: { backend: "virtual", backends: [backend] },
  });
  try {
    await until(again, "s1", ["uncertain", "failed", "completed"]);
    expect(backend.execs).toBe(1);
  } finally {
    await again.close();
    await rm(runtime.root, { recursive: true, force: true });
  }
});

it("deletes sandboxes of an ephemeral Runtime on close", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-ephemeral-"));
  const runtime = await startTestTenant({
    mode: "ephemeral",
    applicationKey: APP,
    vaultKek: null,
    modelProvider: script([{ name: "write", args: { path: "a.txt", content: "a" } }]),
    sandbox: { backend: "virtual", backends: [virtualBackend({ root })] },
  });
  await register(runtime, agent().manifest);
  await openSession(runtime, "s1");
  await say(runtime, "s1", "write");
  expect((await until(runtime, "s1", ["completed", "failed", "uncertain"])).status).toBe("completed");
  const history = await items(runtime, "s1");
  expect(history.some((item) => item.type === "sandbox.exec")).toBe(true);
  await runtime.close();
  const { readdirSync } = await import("node:fs");
  expect(readdirSync(root)).toEqual([]);
  await rm(root, { recursive: true, force: true });
  expect(existsSync(root)).toBe(false);
});

function fakeBackend(options: { available: boolean; execThrows?: boolean }): SandboxBackend & { execs: number } {
  const backend = {
    name: "virtual" as const,
    isolation: "process" as const,
    execs: 0,
    async probe() {
      return {
        name: "virtual" as const,
        isolation: "process" as const,
        available: options.available,
        reason: options.available ? "fake" : "fake backend is off",
      };
    },
    unmet() {
      return undefined;
    },
    async open() {
      return {
        async exec() {
          backend.execs += 1;
          if (options.execThrows) throw new Error("backend connection lost");
          return { exitCode: 0, stdout: "", stderr: "", killed: false, timedOut: false };
        },
        async readFile() {
          return undefined;
        },
        async writeFile() {},
        async stop() {},
      };
    },
    async remove() {},
    async list() {
      return [];
    },
  };
  return backend;
}
