/**
 * Skills only a person starts (Host feature `person-started-skills`): a skill whose SKILL.md sets
 * `disable-model-invocation: true` is kept from the model's catalog and `load_skill` until a
 * message names it in `skill`, for that turn only, and an agent used as a tool never gets it.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, AgentsClient } from "@nylorun/agents";
import { PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "person-started-skills-application-key";
const auth = { authorization: `Bearer ${APP}`, "nylorun-protocol": String(PROTOCOL_VERSION) };
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});
type Runtime = Awaited<ReturnType<typeof startTestTenant>>;

/** Two skills: `review`, which only a person starts, and `notes`, which the model may load. */
function skillsFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "nylorun-skills-"));
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("review/SKILL.md", "---\nname: review\ndescription: Review a design with fresh eyes.\ndisable-model-invocation: true\n---\nRun the review.\n");
  write("notes/SKILL.md", "---\nname: notes\ndescription: Take notes.\n---\nWrite notes.\n");
  return root;
}

type Prompt = { kind?: string; content?: { text?: string }[] }[];
type Call = { name: string; args: Record<string, unknown> };

/** Each agent plays its calls in turn, then answers; every prompt and tool list is kept. */
function scripted(plays: { root: Call[]; child?: Call[] }) {
  const seen: { agent: string; prompt: Prompt; tools: string[]; skills: string; text: string }[] = [];
  const provider = (async (effect: { agent?: { id: string }; input: unknown }) => {
    const input = effect.input as { prompt?: Prompt; tools?: { name: string }[] };
    // The names load_skill takes, as its input schema offers them to the model.
    const skills = JSON.stringify((input.tools ?? []).find((tool) => tool.name === "load_skill") ?? null);
    const prompt = input.prompt ?? [];
    const agent = effect.agent?.id ?? "root";
    seen.push({ agent, prompt, tools: (input.tools ?? []).map((tool) => tool.name), skills, text: JSON.stringify(input) });
    // The calls of this turn: tool results after its latest user message.
    const last = prompt.map((item) => item.kind).lastIndexOf("message");
    const step = prompt.slice(last + 1).filter((item) => item.kind === "tool-result").length;
    const next = (effect.agent ? plays.child ?? [] : plays.root)[step];
    if (!next) return { output: [{ type: "text", text: "done" }] };
    return { output: [{ type: "tool-call", id: `${agent}-${step}`, name: next.name, args: next.args }] };
  }) as unknown as ModelProvider;
  return { provider, seen };
}

async function boot(modelProvider: ModelProvider): Promise<Runtime> {
  const runtime = await startTestTenant({ applicationKey: APP, sandbox: { backend: "virtual" }, modelProvider });
  closers.push(() => runtime.close());
  return runtime;
}

async function settle(runtime: Runtime, sessionId: string): Promise<string> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const view = (await (await fetch(`${runtime.url}/v1/sessions/${sessionId}`, { headers: auth })).json()) as { status: string };
    if (["completed", "failed", "cancelled", "uncertain", "waiting"].includes(view.status)) return view.status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the session did not settle");
}

async function toolOutcomes(runtime: Runtime, sessionId: string) {
  const { items } = (await (await fetch(`${runtime.url}/v1/sessions/${sessionId}/items`, { headers: auth })).json()) as {
    items: { type: string; payload: any }[];
  };
  return items.filter((item) => item.type === "tool.completed").map((item) => item.payload);
}

async function session(runtime: Runtime, agent: ReturnType<ReturnType<typeof Agent>["build"]>) {
  const client = new AgentsClient({ url: runtime.url, key: APP });
  await client.agentManifests.save({ agent, runtime: { kind: "virtual" } });
  await client.agents.put("reviewer", { manifest: agent.manifest.id });
  return client.createSession({ agent: "reviewer", ownerUserId: "ada" });
}

describe("a skill only a person starts", () => {
  it("is carried on the manifest's skill, and kept from the model's catalog and load_skill", async () => {
    const model = scripted({ root: [{ name: "load_skill", args: { name: "review" } }] });
    const runtime = await boot(model.provider);
    const agent = Agent({ id: "bot", instructions: "Help." }).skills(skillsFolder()).build();
    expect(agent.manifest.skills!.review!.disableModelInvocation).toBe(true);
    expect(agent.manifest.skills!.notes!.disableModelInvocation).toBeUndefined();
    const s = await session(runtime, agent);
    await s.input("Review my design.", { idempotencyKey: "m1" });
    expect(await settle(runtime, s.id)).toBe("completed");
    const first = model.seen[0]!;
    expect(first.skills).toContain('"notes"');
    expect(first.skills).not.toContain('"review"');
    expect(first.text).not.toContain("Review a design with fresh eyes.");
    // The model asked for it anyway: load_skill never ran it.
    expect((await toolOutcomes(runtime, s.id)).filter((outcome) => outcome.toolName === "load_skill")).toEqual([]);
  });

  it("is offered for the turn whose message names it, with a note that the person started it, and only then", async () => {
    const model = scripted({ root: [{ name: "load_skill", args: { name: "review" } }] });
    const runtime = await boot(model.provider);
    const s = await session(runtime, Agent({ id: "bot", instructions: "Help." }).skills(skillsFolder()).build());
    await s.input("Review my design.", { idempotencyKey: "m1", skill: "review" });
    expect(await settle(runtime, s.id)).toBe("completed");
    const [loaded] = await toolOutcomes(runtime, s.id);
    expect(loaded.output).toMatchObject({ name: "review", content: "Run the review.\n" });
    expect(model.seen[0]!.text).toContain("The person started the skill review for this turn");

    expect(model.seen[0]!.skills).toContain('"review"');

    // The next turn, named by no message, keeps it from the model again.
    const before = model.seen.length;
    await s.input("And again.", { idempotencyKey: "m2" });
    expect(await settle(runtime, s.id)).toBe("completed");
    const next = model.seen[before]!;
    expect(next.skills).not.toContain('"review"');
    expect((await toolOutcomes(runtime, s.id)).filter((outcome) => outcome.toolName === "load_skill")).toHaveLength(1);
  });

  it("refuses a message naming a skill the agent doesn't have", async () => {
    const runtime = await boot(scripted({ root: [] }).provider);
    const s = await session(runtime, Agent({ id: "bot", instructions: "Help." }).skills(skillsFolder()).build());
    const response = await fetch(`${runtime.url}/v1/sessions/${s.id}/commands`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ type: "message", requestId: "r1", idempotencyKey: "m1", content: "Go.", skill: "nothing" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "unknown_skill", details: { skill: "nothing", skills: ["notes", "review"] } });
  });

  it("is never an agent used as a tool's, even in a turn a person started it for", async () => {
    const model = scripted({
      root: [{ name: "helper", args: { task: "Review it." } }],
      child: [{ name: "load_skill", args: { name: "review" } }],
    });
    const runtime = await boot(model.provider);
    const folder = skillsFolder();
    const helper = Agent({ id: "helper", description: "Helps.", instructions: "Help." }).skills(folder);
    const s = await session(runtime, Agent({ id: "bot", instructions: "Help.", tools: [helper] }).skills(folder).build());
    await s.input("Review my design.", { idempotencyKey: "m1", skill: "review" });
    expect(await settle(runtime, s.id)).toBe("completed");
    const child = model.seen.find((call) => call.agent === "helper")!;
    expect(child.skills).toContain('"notes"');
    expect(child.skills).not.toContain('"review"');
    expect(model.seen.find((call) => call.agent === "root")!.skills).toContain('"review"');
    expect((await toolOutcomes(runtime, s.id)).filter((outcome) => outcome.toolName === "load_skill")).toEqual([]);
  });
});
