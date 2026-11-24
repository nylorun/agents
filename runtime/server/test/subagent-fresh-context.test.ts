/**
 * An agent used as a tool starts fresh: its model sees its own instructions and the `task` its
 * caller writes, never the caller's conversation, compaction summary or memory index, and no
 * repository instruction file it didn't read itself. It shares the caller's computer, so it reads
 * a file the caller wrote, and it can't call agents of its own.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { PROTOCOL_HEADER } from "@nylorun/core/compatibility";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";
import { deploy, openSession } from "./support/agents.js";

const APP = "fresh-context-app-key-aaaaaaaaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json", [PROTOCOL_HEADER]: "18" };
const ROOT_ONLY = "the caller's words, marker 7f3a";
const AGENTS_MD = "repository instructions, marker 91c2";

type Prompt = { kind?: string; role?: string; content?: { type: string; text?: string }[] }[];
const seen: { agent: string; text: string; tools: string[] }[] = [];

/** The root writes two files and calls the helper; the helper reads one of them. */
const model: ModelProvider = async (effect) => {
  const input = effect.input as { prompt?: Prompt; tools?: { name: string }[] };
  const prompt = input.prompt ?? [];
  const agent = effect.agent?.id ?? "root";
  seen.push({ agent, text: JSON.stringify(input), tools: (input.tools ?? []).map((tool) => tool.name) });
  const step = prompt.filter((item) => item.kind === "tool-result").length;
  const plays =
    agent === "root"
      ? [
          { name: "bash", args: { command: `echo shared-note > /workspace/note.txt; echo '${AGENTS_MD}' > /workspace/AGENTS.md; cp /workspace/AGENTS.md /workspace/CLAUDE.md` } },
          { name: "helper", args: { task: "Read /workspace/note.txt and say what it holds." } },
        ]
      : [{ name: "bash", args: { command: "cat /workspace/note.txt" } }];
  const next = plays[step];
  if (!next) return { output: [{ type: "text", text: `${agent} done` }] };
  return { output: [{ type: "tool-call", id: `${agent}-${step}`, name: next.name, args: next.args }] };
};

let runtime: Awaited<ReturnType<typeof startTestTenant>>;

beforeAll(async () => {
  runtime = await startTestTenant({ applicationKey: APP, vaultKek: null, modelProvider: model, sandbox: { backend: "virtual" } });
  const helper = Agent({ id: "helper", description: "Reads files.", instructions: "Read what you are asked to." });
  const bot = Agent({ id: "bot", instructions: "Help the team.", tools: [helper] }).build();
  await deploy(runtime.url, headers, bot, { name: "bot", runtime: { kind: "virtual" }, memory: { instructions: "Keep notes." } });
});

afterAll(async () => {
  await runtime?.close();
});

async function items(session: string): Promise<{ type: string; payload: any }[]> {
  const body = (await (await fetch(`${runtime.url}/v1/sessions/${session}/items`, { headers })).json()) as { items: { type: string; payload: any }[] };
  return body.items;
}

describe("an agent used as a tool", () => {
  it("reads its caller's files and sees none of its caller's context", async () => {
    const opened = await openSession(runtime.url, headers, "s1", { agent: "bot", ownerUserId: "ada" });
    expect(opened.status, await opened.clone().text()).toBe(200);
    const sent = await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "message", requestId: "r1", idempotencyKey: "k1", content: `Please help: ${ROOT_ONLY}` }),
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const view = (await (await fetch(`${runtime.url}/v1/sessions/s1`, { headers })).json()) as { status: string };
      if (["completed", "failed", "uncertain"].includes(view.status)) {
        expect(view.status).toBe("completed");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const root = seen.filter((call) => call.agent === "root");
    const child = seen.filter((call) => call.agent === "helper");
    expect(root.length).toBeGreaterThan(0);
    expect(child.length).toBeGreaterThan(0);
    // The caller had its conversation and its memory index; the helper has neither.
    expect(root[0]!.text).toContain(ROOT_ONLY);
    expect(root[0]!.text).toContain("<memory-index>");
    for (const call of child) {
      expect(call.text).not.toContain(ROOT_ONLY);
      expect(call.text).not.toContain("<memory-index>");
      expect(call.text).not.toContain(AGENTS_MD);
      expect(call.text).toContain("Read /workspace/note.txt and say what it holds.");
      // It can't call agents of its own.
      expect(call.tools).not.toContain("helper");
    }
    // It shares the computer: it read the file its caller wrote.
    const outcomes = (await items("s1")).filter((item) => item.type === "tool.completed");
    const read = outcomes.find((item) => item.payload.agent?.id === "helper" && item.payload.toolName === "bash");
    expect(read?.payload.output.stdout).toContain("shared-note");
  });

  it("can't be given agents of its own", async () => {
    const leaf = Agent({ id: "leaf", description: "Leaf.", instructions: "Leaf." });
    const middle = Agent({ id: "middle", description: "Middle.", instructions: "Middle.", tools: [leaf] });
    expect(() => Agent({ id: "top", instructions: "Top.", tools: [middle] }).build()).toThrow(/nested delegation/i);
  });
});
