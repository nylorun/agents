import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { Agent, tool } from "../src/index.js";
import { AgentsClient } from "../src/client.js";

/**
 * Flow agents in the SDK: a flow agent is saved as one workflow manifest v3 document. Its
 * stages are agents: a tool stage would run your code, so `saveAgent` refuses it.
 */

const KEY = "a".repeat(64);
const URL = "http://127.0.0.1:8787";

/** A client of a fake Runtime that records every definition it is sent. */
function recording() {
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
  return { client, puts };
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
  const directory = mkdtempSync(join(tmpdir(), "nylorun-flow-plugin-"));
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

function deskWith(pluginDir: string) {
  const writer = Agent({ id: "writer" })
    .instructions("Write.")
    .plugin(pluginDir)
    .output(z.object({ word: z.string() }));
  return Agent({ id: "desk" }).pipe(writer, Agent({ id: "editor" }).instructions("Edit.")).build();
}

describe("saveAgent with a flow agent", () => {
  it("PUTs one document", async () => {
    const desk = deskWith(pluginFolder());
    const { client, puts } = recording();
    await client.saveAgent(desk, { implementationVersion: "test" });
    expect(puts.map((p) => p.path)).toEqual(["desk"]);
    expect(puts[0]!.body.manifest.workflowSchemaVersion).toBe(3);
    expect(Object.keys(puts[0]!.body).sort()).toEqual(["implementationVersion", "manifest", "requestId"]);
  });

  it("refuses a tool stage before sending anything", async () => {
    const desk = Agent({ id: "desk" }).pipe(Agent({ id: "writer" }).instructions("Write."), shout).build();
    const { client, puts } = recording();
    await expect(client.saveAgent(desk)).rejects.toThrow(
      "The tool stage 'shout' of flow agent 'desk' runs your code, but the Runtime runs agents from their manifests alone.",
    );
    expect(puts).toEqual([]);
  });
});

describe("a flow agent used as a tool (Phase 3)", () => {
  const research = Agent({ id: "research", description: "Researches a question." }).pipe(
    Agent({ id: "searcher" }).instructions("Search.").plugin(pluginFolder()).output(z.object({ word: z.string() })),
    Agent({ id: "summarizer" }).instructions("Summarize."),
  );
  const lead = Agent({ id: "lead" }).instructions("Delegate.").subagents(research);

  it("is saved inside its parent", async () => {
    const { client, puts } = recording();
    await client.saveAgent(lead, { implementationVersion: "test" });
    expect(puts.map((p) => p.path)).toEqual(["lead"]);
    expect(Object.keys(puts[0]!.body).sort()).toEqual(["implementationVersion", "manifest", "requestId"]);
  });
});
