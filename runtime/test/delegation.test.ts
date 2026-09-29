import { chmodSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  tool,
} from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import { startTestTenant } from "./support/tenant.js";

const APP = "server-token-value-aaaaaaaa";
import type { ModelProvider } from "../src/core/provider.js";

const serverHeaders = {
  authorization: `Bearer ${APP}`,
  "content-type": "application/json",
};
const executorHeaders = {
  authorization: "Bearer executor-token-value",
  "content-type": "application/json",
};
const fixtureDir = realpathSync(
  dirname(
    fileURLToPath(new URL("./fixtures/stdio-env-server.mjs", import.meta.url))
  )
);

const search = tool({
  name: "search_orders",
  input: z.object({ query: z.string() }),
  run: async () => "unused: the test plays the executor",
});

type Call = { name: string; args: Record<string, unknown> };
type Prompt = { kind?: string; content?: { text?: string }[] }[];

/** Each agent plays its own list of tool calls, one per step, then answers. */
function script(plays: {
  root: Call[][];
  child: (task: string) => Call[];
}): ModelProvider & {
  seen: { agent: string; prompt: Prompt }[];
} {
  const seen: { agent: string; prompt: Prompt }[] = [];
  const provider = (async (effect: HostEffect) => {
    const prompt = (effect.input as { prompt?: Prompt }).prompt ?? [];
    seen.push({ agent: effect.agent?.id ?? "root", prompt });
    const step = prompt.filter((item) => item.kind === "tool-result").length;
    if (effect.agent) {
      const task =
        prompt.find((item) => item.kind === "message")?.content?.[0]?.text ??
        "";
      const next = plays.child(task)[step];
      if (!next) return { output: [{ type: "text", text: `answer ${task}` }] };
      return {
        output: [
          {
            type: "tool-call",
            id: `c${step}`,
            name: next.name,
            args: next.args,
          },
        ],
      };
    }
    const batch = plays.root[step];
    if (!batch) return { output: [{ type: "text", text: "done" }] };
    return {
      output: batch.map((call, index) => ({
        type: "tool-call",
        id: `p${step}-${index}`,
        name: call.name,
        args: call.args,
      })),
    };
  }) as ModelProvider & { seen: { agent: string; prompt: Prompt }[] };
  provider.seen = seen;
  return provider;
}

async function boot(_directory: string, modelProvider: ModelProvider) {
  return startTestTenant({
    applicationKey: APP,
    executors: [
      {
        token: "executor-token-value",
        agentId: "bot",
        implementationVersion: "dev",
      },
    ],
    vaultKek: null,
    modelProvider,
    sandbox: { backend: "virtual" },
  });
}

async function start(
  runtime: { url: string },
  manifest: unknown,
  pluginRoots?: Record<string, string>,
  sandbox?: Record<string, unknown>
) {
  const put = await fetch(`${runtime.url}/v1/agents/bot`, {
    method: "PUT",
    headers: serverHeaders,
    body: JSON.stringify({
      requestId: "put-agent",
      manifest,
      implementationVersion: "dev",
      ...(pluginRoots ? { pluginRoots } : {}),
    }),
  });
  expect(put.ok, await put.clone().text()).toBe(true);
  const session = await fetch(`${runtime.url}/v1/sessions/s1`, {
    method: "PUT",
    headers: serverHeaders,
    body: JSON.stringify({
      requestId: "session",
      agentId: "bot",
      ownerUserId: "ada",
      ...(sandbox ? { sandbox } : {}),
    }),
  });
  expect(session.ok).toBe(true);
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
}

async function session(runtime: { url: string }) {
  return (
    await fetch(`${runtime.url}/v1/sessions/s1`, { headers: serverHeaders })
  ).json();
}

async function until(runtime: { url: string }, statuses: readonly string[]) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const body = await session(runtime);
    if (statuses.includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session did not reach ${statuses.join(", ")}`);
}

async function items(runtime: { url: string }, agent?: string) {
  const query = agent ? `?agent=${encodeURIComponent(agent)}` : "";
  const body = await (
    await fetch(`${runtime.url}/v1/sessions/s1/items${query}`, {
      headers: serverHeaders,
    })
  ).json();
  return body.items as { type: string; payload: any }[];
}

async function pendingActions(runtime: { url: string }, count: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const listed = await (
      await fetch(`${runtime.url}/v1/actions`, { headers: executorHeaders })
    ).json();
    if (listed.actions.length >= count) return listed.actions as any[];
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected ${count} actions`);
}

/** Play the root agent's executor: claim an action and report a result. */
async function complete(
  runtime: { url: string },
  action: any,
  output: unknown
) {
  const claim = await fetch(
    `${runtime.url}/v1/actions/${encodeURIComponent(action.actionId)}/claim`,
    {
      method: "POST",
      headers: executorHeaders,
      body: JSON.stringify({
        requestId: `claim-${action.actionId}`,
        implementationVersion: "dev",
      }),
    }
  );
  expect(claim.ok, await claim.clone().text()).toBe(true);
  const claimed = await claim.json();
  const result = await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
    method: "POST",
    headers: executorHeaders,
    body: JSON.stringify({
      type: "action_result",
      requestId: `result-${action.actionId}`,
      idempotencyKey: `result-${action.actionId}`,
      actionId: action.actionId,
      claimId: claimed.claimId,
      generation: claimed.generation,
      outcome: { value: { kind: "completed", output } },
    }),
  });
  expect(result.ok, await result.clone().text()).toBe(true);
}

it("runs agents used as tools on the root executor and journals them once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "delegation-"));
  const model = script({
    root: [
      [
        { name: "researcher", args: { task: "A" } },
        { name: "researcher", args: { task: "B" } },
      ],
    ],
    child: (task) => [{ name: "search_orders", args: { query: task } }],
  });
  const runtime = await boot(directory, model);
  try {
    const researcher = Agent({
      id: "researcher",
      description: "Researches.",
      tools: [search],
    });
    await start(
      runtime,
      Agent({ id: "bot", tools: [researcher] }).build().manifest
    );
    const actions = await pendingActions(runtime, 2);
    for (const action of actions)
      expect(action).toMatchObject({
        agentId: "bot",
        kind: "tool",
        toolName: "search_orders",
        agent: { id: "researcher", path: "bot/researcher" },
      });
    for (const action of actions)
      await complete(runtime, action, `found ${action.input.query}`);
    const done = await until(runtime, ["completed", "failed", "uncertain"]);
    expect(done.status).toBe("completed");

    // The parent's final model call saw both children's answers and none of their work.
    const last = model.seen.filter((item) => item.agent === "root").at(-1)!;
    const text = JSON.stringify(last.prompt);
    expect(text).toContain("answer A");
    expect(text).toContain("answer B");
    expect(text).not.toContain("found A");

    const history = await items(runtime);
    const started = history.filter(
      (item) => item.type === "delegation.started"
    );
    const completed = history.filter(
      (item) => item.type === "delegation.completed"
    );
    expect(started.map((item) => item.payload.task).sort()).toEqual(["A", "B"]);
    expect(completed).toHaveLength(2);
    expect(completed.every((item) => item.payload.status === "completed")).toBe(
      true
    );
    // Each lifecycle event names the parent's tool call, for chat UIs.
    for (const item of [...started, ...completed])
      expect(item.payload.callId).toEqual(expect.any(String));
    const work = history.filter((item) => item.type.startsWith("action."));
    expect(work).toHaveLength(6);
    expect(
      work.every((item) => item.payload.agent?.path === "bot/researcher")
    ).toBe(true);

    const one = started[0]!.payload.agent.delegationId;
    const scoped = await items(runtime, one);
    expect(scoped.length).toBeGreaterThan(0);
    expect(
      scoped.every((item) => item.payload.agent.delegationId === one)
    ).toBe(true);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("gives an agent used as a tool its own MCP servers and the session's sandbox", async () => {
  const directory = await mkdtemp(join(tmpdir(), "delegation-mcp-"));
  chmodSync(join(fixtureDir, "stdio-env-server.mjs"), 0o755);
  const model = script({
    root: [
      [{ name: "coder", args: { task: "note" } }],
      [{ name: "read", args: { path: "note.txt" } }],
    ],
    child: () => [
      { name: "local__env", args: { key: "PLUGIN_DATA" } },
      { name: "write", args: { path: "note.txt", content: "from the child" } },
    ],
  });
  const runtime = await boot(directory, model);
  try {
    const coder = Agent({ id: "coder", description: "Writes notes." })
      .use({
        id: "local",
        mcpServers: {
          local: {
            name: "local",
            type: "stdio",
            command: "./stdio-env-server.mjs",
          },
        },
      });
    const bot = Agent({ id: "bot", tools: [coder] }).build();
    // The session is opened with a sandbox; the agent it uses as a tool shares it.
    await start(runtime, bot.manifest, { "coder/local": fixtureDir }, {});
    const done = await until(runtime, ["completed", "failed", "uncertain"]);
    expect(done.status).toBe("completed");
    expect(done.mcpSnapshot.mcpTools).toEqual([
      expect.objectContaining({
        agentId: "coder",
        capabilityId: "local",
        name: "local__env",
      }),
    ]);
    // The root never saw the child's MCP tool; the child did.
    const rootTools = JSON.stringify(
      model.seen.filter((item) => item.agent === "root")
    );
    expect(rootTools).not.toContain("local__env");
    const childPrompts = JSON.stringify(
      model.seen.filter((item) => item.agent === "coder")
    );
    expect(childPrompts).toContain("plugin-data");
    // The parent read the file the child wrote: one sandbox per session.
    const last = model.seen.filter((item) => item.agent === "root").at(-1)!;
    expect(JSON.stringify(last.prompt)).toContain("from the child");
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("fences a delegated agent's work when the session is cancelled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "delegation-cancel-"));
  const model = script({
    root: [[{ name: "researcher", args: { task: "A" } }]],
    child: (task) => [{ name: "search_orders", args: { query: task } }],
  });
  const runtime = await boot(directory, model);
  try {
    const researcher = Agent({
      id: "researcher",
      description: "Researches.",
      tools: [search],
    });
    await start(
      runtime,
      Agent({ id: "bot", tools: [researcher] }).build().manifest
    );
    const [action] = await pendingActions(runtime, 1);
    const cancel = await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
      method: "POST",
      headers: serverHeaders,
      body: JSON.stringify({
        type: "cancel",
        requestId: "c1",
        idempotencyKey: "c1",
      }),
    });
    expect(cancel.ok).toBe(true);
    expect((await session(runtime)).status).toBe("cancelled");
    const listed = await (
      await fetch(`${runtime.url}/v1/actions`, { headers: executorHeaders })
    ).json();
    expect(listed.actions).toEqual([]);
    const claim = await fetch(
      `${runtime.url}/v1/actions/${encodeURIComponent(action.actionId)}/claim`,
      {
        method: "POST",
        headers: executorHeaders,
        body: JSON.stringify({
          requestId: "late",
          implementationVersion: "dev",
        }),
      }
    );
    expect(claim.ok).toBe(false);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("surfaces a child's empty answer as a failed tool result and filters history by path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "delegation-fail-"));
  const seen: { agent: string; prompt: Prompt }[] = [];
  const modelProvider: ModelProvider = async (effect) => {
    const prompt = (effect.input as { prompt?: Prompt }).prompt ?? [];
    seen.push({ agent: effect.agent?.id ?? "root", prompt });
    const step = prompt.filter((item) => item.kind === "tool-result").length;
    if (effect.agent) {
      const task =
        prompt.find((item) => item.kind === "message")?.content?.[0]?.text ??
        "";
      if (task === "A") return { output: [{ type: "text", text: "   " }] };
      if (step === 0)
        return {
          output: [
            {
              type: "tool-call",
              id: "c0",
              name: "search_orders",
              args: { query: task },
            },
          ],
        };
      return { output: [{ type: "text", text: `answer ${task}` }] };
    }
    if (step === 0)
      return {
        output: [
          {
            type: "tool-call",
            id: "p0-0",
            name: "researcher",
            args: { task: "A" },
          },
          {
            type: "tool-call",
            id: "p0-1",
            name: "researcher",
            args: { task: "B" },
          },
        ],
      };
    return { output: [{ type: "text", text: "done" }] };
  };
  const runtime = await boot(directory, modelProvider);
  try {
    const researcher = Agent({
      id: "researcher",
      description: "Researches.",
      tools: [search],
    });
    await start(
      runtime,
      Agent({ id: "bot", tools: [researcher] }).build().manifest
    );
    const actions = await pendingActions(runtime, 1);
    expect(actions).toHaveLength(1);
    await complete(runtime, actions[0], `found ${actions[0].input.query}`);
    const done = await until(runtime, ["completed", "failed", "uncertain"]);
    expect(done.status).toBe("completed");

    const last = seen.filter((item) => item.agent === "root").at(-1)!;
    const text = JSON.stringify(last.prompt);
    expect(text).toContain("answer B");
    expect(text).toContain("finished without an answer");

    const byPath = await items(runtime, "bot/researcher");
    expect(byPath.length).toBeGreaterThan(0);
    expect(
      byPath.every((item) => item.payload.agent?.path === "bot/researcher")
    ).toBe(true);
    const started = byPath.filter((item) => item.type === "delegation.started");
    // Path filter matches every concurrent child that shares the path.
    expect(started).toHaveLength(2);
    const one = started[0]!.payload.agent.delegationId;
    const byId = await items(runtime, one);
    expect(byId.every((item) => item.payload.agent.delegationId === one)).toBe(
      true
    );
    expect(
      byId.filter((item) => item.type === "delegation.started")
    ).toHaveLength(1);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
