/**
 * The Repo brief agent (track R2's exit), end to end against an in-process Runtime: one turn
 * runs a pipe, a switch, a map over remote MCP calls, a parallel review, a loop whose writer
 * runs a skill's script in the sandbox and calls an HTTP tool, and an HTTP stage that
 * publishes the brief. Nothing of the agent's runs in this process except the services it
 * calls over HTTP: the Tenant's model is a stub OpenAI-compatible server, set as the Tenant's
 * model like any provider, DeepWiki is a fake MCP server, and the tools service is the
 * examples' own.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createClient } from "@nylorun/agents";
import { toNodeListener } from "@nylorun/agents/ag-ui";
import { codeToolRefusal, type AgentManifest } from "@nylorun/core/define";
import { startEphemeralRuntime, type EphemeralRuntime } from "@nylorun/runtime";
import { createRepoBrief } from "../agents/repo-brief/agent.js";
import { publishBriefCode, publishedBriefs } from "../agents/repo-brief/publish.js";
import { tools as clock } from "../agents/shared/tools/catalog/now.js";
import { toolsService } from "../agents/shared/tools/service.js";
import { testDatabase } from "./database.js";

const REPO = "acme/widgets";
const QUESTIONS = ["How is it built?", "How is it tested?"];
const BRIEF = [
  `# ${REPO} brief`,
  "## Summary",
  "Widgets for acme.",
  "## Findings",
  "- It is built with make.",
  "- It is tested with vitest.",
  "## Risks",
  "- One maintainer.",
].join("\n");

type Call = { name: string; args: Record<string, unknown> };
type Answer = { calls: readonly Call[]; final: (said: readonly string[], asked: string) => unknown };

/**
 * What each agent of the flow does, found by a phrase of its instructions: its tool calls in
 * order, then its final answer (JSON for an agent with an output schema), from the tool
 * results it got and the last thing it was asked.
 */
const script: Record<string, Answer> = {
  "Decide whether the request names": {
    calls: [],
    final: () => ({ route: "repo", repo: REPO, items: QUESTIONS }),
  },
  "You get one question about the repository": {
    calls: [{ name: "deepwiki__ask_question", args: { repoName: REPO } }],
    final: ([answer], asked) => ({ question: asked, answer }),
  },
  "Summarize what the repository is for": {
    calls: [],
    final: () => ({ summary: "Widgets for acme.", findings: ["It is built with make.", "It is tested with vitest."] }),
  },
  "List up to three risks": { calls: [], final: () => ({ risks: ["One maintainer."] }) },
  "Write the repo brief": {
    calls: [
      { name: "load_skill", args: { name: "repo-brief" } },
      { name: "now", args: {} },
      {
        name: "bash",
        args: {
          command: `cat > /workspace/brief.md <<'EOF'\n${BRIEF}\nEOF\nsh /skills/repo-brief/scripts/check.sh /workspace/brief.md`,
        },
      },
    ],
    final: () => ({ title: `${REPO} brief`, markdown: BRIEF }),
  },
  "You check a repo brief": { calls: [], final: () => ({ pass: true }) },
};

type Message = { role: string; content?: unknown; tool_calls?: unknown };
const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part === "string" ? part : (part as { text?: string }).text ?? "")).join("")
      : "";

async function read(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A stub OpenAI-compatible model that plays `script`, streaming as the provider does. */
function stubModel(): Server {
  let calls = 0;
  const base = { id: "stub", object: "chat.completion.chunk", created: 0, model: "stub" };
  const stream = (res: ServerResponse, delta: Record<string, unknown>, finish: string) => {
    const chunk = (body: Record<string, unknown>) => res.write(`data: ${JSON.stringify({ ...base, ...body })}\n\n`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    chunk({ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
    chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    res.end("data: [DONE]\n\n");
  };
  return createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
    calls += 1;
    const body = JSON.parse(await read(req)) as { messages: Message[] };
    const system = body.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => text(m.content)).join("\n");
    const [, answer] = Object.entries(script).find(([phrase]) => system.includes(phrase)) ?? [];
    if (!answer) return stream(res, { content: "stub answer" }, "stop");
    const lastUser = body.messages.findLastIndex((m) => m.role === "user");
    const said = body.messages.slice(lastUser + 1).filter((m) => m.role === "tool").map((m) => text(m.content));
    const asked = text(body.messages[lastUser]?.content).trim().split("\n").at(-1)!.replace(/^"|"$/g, "");
    const next = answer.calls[said.length];
    if (next) {
      const args = next.name === "deepwiki__ask_question" ? { ...next.args, question: asked } : next.args;
      const call = { index: 0, id: `call_${calls}`, type: "function", function: { name: next.name, arguments: JSON.stringify(args) } };
      return stream(res, { tool_calls: [call] }, "tool_calls");
    }
    stream(res, { content: JSON.stringify(answer.final(said, asked)) }, "stop");
  });
}

/** DeepWiki's `ask_question`, as a stateless streamable-http MCP server answering JSON. */
function fakeDeepWiki(asked: { repoName: string; question: string }[]): Server {
  return createServer(async (req, res) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    const message = JSON.parse(await read(req)) as { id?: number; method: string; params?: any };
    const reply = (result: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    if (message.method === "initialize")
      return reply({
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "deepwiki", version: "0.0.0" },
      });
    if (message.method === "tools/list")
      return reply({
        tools: [
          {
            name: "ask_question",
            description: "Ask a question about a GitHub repository.",
            inputSchema: {
              type: "object",
              properties: { repoName: { type: "string" }, question: { type: "string" } },
              required: ["repoName", "question"],
            },
          },
        ],
      });
    if (message.method === "tools/call") {
      const { repoName, question } = message.params.arguments;
      asked.push({ repoName, question });
      return reply({ content: [{ type: "text", text: `${repoName}: the answer to ${question}` }] });
    }
    res.writeHead(202).end();
  });
}

let hostRoot: string;
let database: Awaited<ReturnType<typeof testDatabase>>;
let runtime: EphemeralRuntime;
const servers: Server[] = [];
const asked: { repoName: string; question: string }[] = [];
let toolsUrl: string;
let mcpUrl: string;

beforeAll(async () => {
  hostRoot = await mkdtemp(join(tmpdir(), "examples-repo-brief-"));
  database = await testDatabase();
  runtime = await startEphemeralRuntime({ hostRoot, model: { kind: "vault" }, database: database.url });
  const model = stubModel();
  const deepwiki = fakeDeepWiki(asked);
  const tools = createServer(toNodeListener({ fetch: toolsService([publishBriefCode, ...clock]) }));
  servers.push(model, deepwiki, tools);
  const modelUrl = await listen(model);
  mcpUrl = `${await listen(deepwiki)}/mcp`;
  toolsUrl = await listen(tools);
  const set = await fetch(`${runtime.url}/v1/tenant/model`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${runtime.managementKey}`,
      "nylorun-protocol": "10",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      requestId: "model",
      idempotencyKey: "model",
      provider: "custom",
      model: "stub",
      baseUrl: `${modelUrl}/v1`,
      auth: { type: "api_key", key: "stub-model-key" },
    }),
  });
  expect(set.ok, await set.text()).toBe(true);
}, 60_000);

afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await runtime?.close();
  await database?.drop();
  await rm(hostRoot, { recursive: true, force: true });
});

it("declares no code the Runtime would have to call", () => {
  const { manifest } = createRepoBrief();
  expect(manifest.workflowSchemaVersion).toBe(3);
  for (const agent of Object.values(manifest.agents ?? {}))
    if ((agent as { kind?: string }).kind !== "workflow")
      expect(codeToolRefusal(agent as AgentManifest)).toBeUndefined();
});

it("researches, writes, checks and publishes a brief in one turn", { timeout: 60_000 }, async () => {
  const client = createClient({ url: runtime.url, key: runtime.applicationKey });
  await client.saveAgent(createRepoBrief({ toolsUrl, mcpUrl }));
  const session = await client.createSession({ agentId: "repo-brief", ownerUserId: "ada", sandbox: {} });
  const events: { type: string; sessionId: string; payload: any }[] = [];
  const done = (async () => {
    for await (const event of session.observe()) {
      events.push({ type: event.type, sessionId: event.sessionId, payload: event.payload });
      if (event.sessionId === session.id && (event.type === "turn.completed" || event.type === "turn.failed")) return;
    }
  })();
  await session.input(`Brief me on ${REPO}.`, { idempotencyKey: "m1" });
  await Promise.race([
    done,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(events.map((e) => `${e.type} ${JSON.stringify(e.payload)}`).join("\n"))), 45_000),
    ),
  ]);

  const last = events.findLast((e) => e.sessionId === session.id)!;
  expect(last.type, JSON.stringify(last.payload)).toBe("turn.completed");
  // The flow's output is the publish stage's answer.
  expect(last.payload.output).toEqual({ id: expect.stringMatching(/^brief-/), title: `${REPO} brief`, words: 27 });
  expect(publishedBriefs.at(-1)).toMatchObject({ title: `${REPO} brief`, markdown: BRIEF });

  // The switch took the repo case; the map ran a researcher per question, the parallel both
  // reviews, the loop one draft that passed, and the HTTP stage published it.
  const agents = events.filter((e) => e.type === "node.agent");
  expect(agents.map((e) => e.payload.path).sort()).toEqual(
    [
      "triage",
      "research/researcher[0]",
      "research/researcher[1]",
      "research/overview",
      "research/risks",
      "research/writer",
      "research/editor",
    ].sort(),
  );
  expect(events.filter((e) => e.type === "loop.verified").map((e) => e.payload)).toEqual([
    { path: "research/draft", n: 1, pass: true },
  ]);
  expect(events.find((e) => e.type === "node.started")?.payload).toMatchObject({
    path: "research/publish_brief",
    kind: "http",
  });
  // Each researcher asked DeepWiki its question, through the Runtime's MCP connection.
  expect(asked.map((call) => call.question).sort()).toEqual([...QUESTIONS].sort());
  expect(asked.every((call) => call.repoName === REPO)).toBe(true);

  // The writer loaded the skill, dated the brief through the tools service, and ran the
  // skill's check script in the session's sandbox, where it passed.
  const writer = agents.find((e) => e.payload.path === "research/writer")!.payload.sessionId as string;
  const response = await fetch(`${runtime.url}/v1/sessions/${writer}/items`, {
    headers: { authorization: `Bearer ${runtime.applicationKey}`, "nylorun-protocol": "10" },
  });
  const { items } = (await response.json()) as { items: { type: string; payload: any }[] };
  const [skill, now, check] = items.filter((item) => item.type === "tool.completed").map((item) => item.payload);
  expect(skill.output).toMatchObject({ name: "repo-brief", sandboxPath: "/skills/repo-brief/" });
  expect(now.output).toMatchObject({ iso: expect.stringMatching(/Z$/) });
  expect(check.output).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("ok: 27 words") });
  // No Action: nothing called back into a developer process.
  expect(events.some((e) => e.type.startsWith("action."))).toBe(false);
});
