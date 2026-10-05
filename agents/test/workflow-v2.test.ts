import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import type { Action } from "@nylorun/core/contracts";
import { Agent, hashManifest, tool } from "../src/index.js";
import { createActionHandler } from "../src/action-handler.js";
import { AgentsClient } from "../src/client.js";
import { executeAction } from "../src/execute-action.js";

/**
 * Flow Agents Phase 2 in the SDK: a flow agent is saved as one workflow manifest v2
 * document, and its Action endpoint serves flow actions only for the manifest it runs.
 */

const KEY = "a".repeat(64);
const URL = "http://127.0.0.1:8787";
const ENDPOINT = "http://localhost:3000/nylorun/actions";

/** Registers `agents` against a fake Runtime; returns what was saved and registered. */
async function register(agents: Parameters<typeof createActionHandler>[0]["agents"]) {
  const saved: string[] = [];
  let registrations: { agentId: string; manifestHash?: string }[] = [];
  const application = new AgentsClient({
    url: URL,
    key: KEY,
    fetch: async (url, init) => {
      const path = String(url);
      if (path.endsWith("/health")) return healthOk();
      if (path.includes("/v1/files/")) return heldFile(init);
      if (path.includes("/v1/agents/") && init?.method === "PUT") {
        saved.push(decodeURIComponent(path.split("/").pop()!));
        return Response.json({ ok: true });
      }
      if (path.endsWith("/v1/endpoints") && init?.method === "PUT") {
        registrations = JSON.parse(String(init.body)).endpoints;
        return Response.json({ endpoints: [] });
      }
      if (path.endsWith("/ping")) {
        const agentId = decodeURIComponent(path.split("/").at(-2)!);
        const manifestHash = registrations.find((r) => r.agentId === agentId)?.manifestHash;
        return Response.json({
          agentId,
          implementationVersion: "test",
          ...(manifestHash ? { manifestHash } : {}),
        });
      }
      throw new Error(`unexpected ${path}`);
    },
  });
  const answers = await createActionHandler({
    agents,
    client: application,
    implementationVersion: "test",
  }).register({ url: ENDPOINT });
  return { saved, registrations, answers };
}

/** The Runtime holds every skill file already: `saveAgent` asks (HEAD) and uploads nothing. */
function heldFile(init: RequestInit | undefined) {
  if (init?.method !== "HEAD") throw new Error(`unexpected ${init?.method} of a file`);
  return new Response(null, { status: 200 });
}

function healthOk() {
  return Response.json({
    status: "ok",
    service: "nylorun-runtime",
    version: "0.9.0-beta",
    protocol: { ...HOST_PROTOCOL },
    coreVersion: "0.4.0-beta",
    hostId: "host_00000000000000000000000001",
    pid: 1,
  });
}

function pluginFolder(): string {
  const directory = mkdtempSync(join(tmpdir(), "nylorun-v2-plugin-"));
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), contents);
  };
  write(
    "plugin.json",
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "github",
      version: "1.0.0",
      description: "GitHub helpers.",
    })
  );
  write("skills/open-pr/SKILL.md", "---\nname: open-pr\ndescription: Open a PR.\n---\nSteps.\n");
  return directory;
}

const shout = tool({
  name: "shout",
  input: z.object({ word: z.string() }),
  async run({ word }) {
    return word.toUpperCase();
  },
});

function deskWith(pluginRoot: string) {
  const writer = Agent({ id: "writer" }).instructions("Write.").plugin(pluginRoot);
  return Agent({ id: "desk" })
    .step(writer)
    .step(shout, { input: ({ input }) => ({ word: String(input) }) })
    .build();
}

describe("saveAgent with a v2 flow agent", () => {
  it("PUTs one document, carrying its agents' plugin roots", async () => {
    const root = pluginFolder();
    const desk = deskWith(root);
    const puts: { path: string; body: any }[] = [];
    const client = new AgentsClient({
      url: URL,
      key: KEY,
      fetch: async (url, init) => {
        if (String(url).endsWith("/health")) return healthOk();
        if (String(url).includes("/v1/files/")) return heldFile(init);
        if (init?.method === "PUT") {
          puts.push({ path: decodeURIComponent(String(url).split("/").pop()!), body: JSON.parse(String(init.body)) });
          return Response.json({ ok: true });
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    await client.saveAgent(desk, { implementationVersion: "test" });
    expect(puts.map((p) => p.path)).toEqual(["desk"]);
    expect(puts[0]!.body.manifest.workflowSchemaVersion).toBe(2);
    expect(puts[0]!.body.pluginRoots).toEqual({ "writer/github": realpathSync(root) });
  });
});

describe("createActionHandler with a v2 flow agent", () => {
  it("saves only the flow agent, and registers its endpoint with the manifest hash", async () => {
    const desk = deskWith(pluginFolder());
    const { saved, registrations, answers } = await register([desk]);
    expect(saved).toEqual(["desk"]);
    expect(registrations.map((r) => [r.agentId, r.manifestHash])).toEqual([
      ["desk", hashManifest(desk.manifest)],
      ["writer", undefined],
    ]);
    expect(answers[0]).toEqual({
      agentId: "desk",
      implementationVersion: "test",
      manifestHash: hashManifest(desk.manifest),
    });
  });
});

describe("executeAction on a v2 flow agent", () => {
  it("routes fn and tool actions by stage key", async () => {
    const desk = deskWith(pluginFolder());
    const base = {
      sessionId: "s1",
      turnId: "t1",
      agentId: "desk",
      manifestHash: hashManifest(desk.manifest),
      implementationVersion: "test",
      context: {},
      status: "delivering" as const,
      generation: 1,
    };
    const input = await executeAction(
      {
        ...base,
        actionId: "a1",
        kind: "fn",
        path: "shout:input",
        key: "shout:input",
        input: { input: "hello", results: {}, flowInput: "go" },
      } as Action,
      desk,
      new AbortController().signal
    );
    expect(input).toEqual({ value: { word: "hello" } });
    const loud = await executeAction(
      { ...base, actionId: "a2", kind: "tool", path: "shout", key: "shout", input: { word: "hello" } } as Action,
      desk,
      new AbortController().signal
    );
    expect(loud).toMatchObject({ value: { kind: "completed", output: "HELLO" } });
  });
});

describe("a flow agent used as a tool (Phase 3)", () => {
  const root = pluginFolder();
  const research = Agent({ id: "research", description: "Researches a question." })
    .step(Agent({ id: "searcher" }).instructions("Search.").plugin(root))
    .step(shout, { input: ({ input }) => ({ word: String(input) }) });
  const lead = Agent({ id: "lead" }).instructions("Delegate.").subagents(research);

  it("is saved inside its parent, with its agents' plugin roots under its id", async () => {
    const puts: { path: string; body: any }[] = [];
    const client = new AgentsClient({
      url: URL,
      key: KEY,
      fetch: async (url, init) => {
        if (String(url).endsWith("/health")) return healthOk();
        if (String(url).includes("/v1/files/")) return heldFile(init);
        puts.push({ path: decodeURIComponent(String(url).split("/").pop()!), body: JSON.parse(String(init!.body)) });
        return Response.json({ ok: true });
      },
    });
    await client.saveAgent(lead, { implementationVersion: "test" });
    expect(puts.map((p) => p.path)).toEqual(["lead"]);
    expect(puts[0]!.body.pluginRoots).toEqual({ "research/searcher/github": realpathSync(root) });
  });

  it("is served by the parent's Action endpoint, with its agents", async () => {
    const { saved, registrations } = await register([lead]);
    expect(saved).toEqual(["lead"]);
    expect(registrations.map((r) => r.agentId)).toEqual(["lead", "research", "searcher"]);
    expect(registrations[1]!.manifestHash).toBe(hashManifest(research.manifest));
  });
});
