import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { Agent, http, tool } from "../src/index.js";
import { AgentsClient, ManifestGapsError, agentManifest, runtimeFiles } from "../src/client.js";

const KEY = "a".repeat(64);
const RUNTIME = "http://127.0.0.1:8787";
const SAVED = { manifest: { name: "triage", version: 1 }, unchanged: false, warnings: [] };
const PLAN = { name: "triage", from: 2, to: 3, unchanged: false, changes: [], warnings: [], errors: [], behind: 1 };

function fake(respond: (method: string, path: string, body: any) => Response = () => Response.json(SAVED)) {
  const sent: { method: string; path: string; search: string; ifMatch: string | null; body?: any }[] = [];
  const client = new AgentsClient({
    url: RUNTIME,
    key: KEY,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return Response.json({ status: "ok", protocol: HOST_PROTOCOL });
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const method = init?.method ?? "GET";
      const ifMatch = new Headers(init?.headers).get("if-match");
      sent.push({ method, path: url.pathname, search: url.search, ifMatch, body });
      return respond(method, url.pathname, body);
    },
  });
  return { client, sent };
}

const lookup = http({
  name: "lookup",
  input: z.object({ id: z.string() }),
  url: "https://items.example.com/lookup",
  credential: "items",
});

describe("client.agentManifests", () => {
  it("saves a v8 document under If-Match, filling in its schema version and dropping $schema", async () => {
    const { client, sent } = fake();
    await client.agentManifests.save(
      {
        $schema: "https://docs.nylorun.com/schemas/agent-manifest/v8.json",
        name: "triage",
        harness: { instructions: ["Triage."] },
      },
      { ifMatch: 0, requestId: "req-1" },
    );
    expect(sent).toEqual([
      {
        method: "PUT",
        path: "/v1/agent-manifests/triage",
        search: "",
        ifMatch: "0",
        body: { requestId: "req-1", manifestSchemaVersion: 8, name: "triage", harness: { instructions: ["Triage."] } },
      },
    ]);
  });

  it("makes the harness section from a built agent, without its requires, and names it after the agent", async () => {
    const agent = Agent({ id: "orders", description: "Answers order questions." })
      .instructions("Use lookup.")
      .tools(lookup)
      .requires({ secrets: ["REGION"] })
      .build();
    const runtime = {
      kind: "virtual" as const,
      secrets: {
        items: { type: "bearer" as const, url: "https://items.example.com/lookup" },
        REGION: { type: "environment_variable" as const },
      },
    };
    expect(agentManifest({ agent, runtime, loop: { maxTurns: 3 } })).toEqual({
      manifestSchemaVersion: 8,
      name: "orders",
      description: "Answers order questions.",
      harness: {
        instructions: ["Use lookup."],
        tools: [expect.objectContaining({ name: "lookup", http: expect.objectContaining({ credential: "items" }) })],
        loop: { maxTurns: 3 },
      },
      runtime,
    });
    const { client, sent } = fake();
    await client.agentManifests.save({ agent, runtime, name: "orders-v2", harness: "nylorun" });
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual(["PUT /v1/agent-manifests/orders-v2"]);
    expect(sent[0]!.body.harness).not.toHaveProperty("requires");
    expect(sent[0]!.body.harness).not.toHaveProperty("id");
  });

  it("turns on the agent's memory, and carries its skills' SKILL.md secrets into the harness section", async () => {
    const root = mkdtempSync(join(tmpdir(), "nylorun-manifest-skills-"));
    mkdirSync(join(root, "open-pr"));
    writeFileSync(
      join(root, "open-pr/SKILL.md"),
      "---\nname: open-pr\ndescription: Open a pull request.\nsecrets: [GH_TOKEN]\n---\nRun gh.\n",
    );
    const agent = Agent({ id: "builder" }).instructions("Build.").skills(root).build();
    const runtime = { kind: "virtual" as const, secrets: { GH_TOKEN: { type: "environment_variable" as const } } };
    const memory = { access: "read_only" as const, instructions: "Keep the build conventions." };
    const { harness } = agentManifest({ agent, runtime, memory });
    expect(harness).toMatchObject({ memory, skills: { "open-pr": { name: "open-pr", secrets: ["GH_TOKEN"] } } });
    // The built agent's own manifest (v7) keeps no secrets on its skills.
    expect(agent.manifest.skills!["open-pr"]).not.toHaveProperty("secrets");
    const flow = Agent({ id: "flow" }).pipe(Agent({ id: "step" }).instructions("Step.")).build();
    expect(() => agentManifest({ agent: flow, memory })).toThrow(/flow, whose harness section has none/);
  });

  it("refuses an agent that misses its requires, and a code tool, before sending anything", async () => {
    const { client, sent } = fake();
    const needsPod = Agent({ id: "builder" }).instructions("Build.").requires({ sandbox: "pod", secrets: ["GH_TOKEN"] });
    const refusal = await client.agentManifests.save({ agent: needsPod, runtime: { kind: "virtual" } }).catch((e) => e);
    expect(refusal).toBeInstanceOf(ManifestGapsError);
    expect(refusal.gaps).toEqual([
      'requires.sandbox "pod" needs runtime.kind "pod"; the runtime is "virtual"',
      'requires.secrets "GH_TOKEN" is not a secret slot in runtime.secrets',
    ]);
    const note = tool({ name: "note", input: z.object({ text: z.string() }), run: async ({ text }) => text });
    await expect(client.agentManifests.save({ agent: Agent({ id: "notes" }).tools(note) })).rejects.toThrow(
      /Tool 'note' of agent 'notes' runs your code/,
    );
    expect(sent).toEqual([]);
  });

  it("plans a save, with the gaps the SDK finds among the errors, and uploads runtime files by hash first", async () => {
    const kit = await runtimeFiles("/workspace/kit", { "run.sh": "echo kit\n", "data.bin": new Uint8Array([1, 2]) });
    expect(Object.keys(kit.entry.files)).toEqual(["data.bin", "run.sh"]);
    const [data, run] = [kit.entry.files["data.bin"]!, kit.entry.files["run.sh"]!];
    expect(run).toMatch(/^sha256:[0-9a-f]{64}$/);
    const { client, sent } = fake((method, path) =>
      method === "HEAD"
        ? new Response(null, { status: path.endsWith(data) ? 200 : 404 })
        : method === "PUT" && path.startsWith("/v1/files/")
          ? Response.json({ sha256: run }, { status: 201 })
          : Response.json({ ...PLAN, errors: ["from the Runtime"] }),
    );
    const plan = await client.agentManifests.plan(
      {
        agent: Agent({ id: "triage" }).instructions("Triage.").requires({ sandbox: "any" }),
        runtime: { kind: "none" },
      },
      { files: kit.bytes, ifMatch: 2 },
    );
    expect(plan.errors).toEqual([
      "from the Runtime",
      'requires.sandbox "any" needs runtime.kind "virtual" or "pod"; the runtime is "none"',
    ]);
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `HEAD /v1/files/${data}`,
      `HEAD /v1/files/${run}`,
      `PUT /v1/files/${run}`,
      "PUT /v1/agent-manifests/triage",
    ]);
    expect(sent.at(-1)!.search).toBe("?dryRun=true");
    expect(sent.at(-1)!.ifMatch).toBe("2");
  });

  it("streams a file whose source has stream(), and sends a new stream after an expired token", async () => {
    const sha256 = `sha256:${"a".repeat(64)}`;
    let opened = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const source = {
      size: 4 * chunk.length,
      read: async () => {
        throw new Error("read() holds the whole file; stream() should be used");
      },
      stream: () => {
        opened += 1;
        let left = 4;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (left-- > 0) controller.enqueue(chunk);
            else controller.close();
          },
        });
      },
    };
    const received: number[] = [];
    let puts = 0;
    const client = new AgentsClient({
      url: RUNTIME,
      key: KEY,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/health") return Response.json({ status: "ok", protocol: HOST_PROTOCOL });
        if (init?.method === "HEAD") return new Response(null, { status: 404 });
        expect(init?.body).toBeInstanceOf(ReadableStream);
        expect((init as { duplex?: string }).duplex).toBe("half");
        puts += 1;
        let bytes = 0;
        for await (const part of init!.body as unknown as AsyncIterable<Uint8Array>) bytes += part.length;
        received.push(bytes);
        if (puts === 1) return Response.json({ code: "token_expired", message: "Expired." }, { status: 401 });
        return Response.json({ sha256, size: bytes }, { status: 201 });
      },
    });
    await client.files.ensure(new Map([[sha256, source]]));
    expect(opened).toBe(2);
    expect(received).toEqual([source.size, source.size]);
  });

  it("reads, lists, versions and deletes manifests", async () => {
    const { client, sent } = fake((_method, path) =>
      path === "/v1/agent-manifests" ? Response.json({ manifests: [{ name: "triage" }] }) : Response.json({ name: "triage" }),
    );
    await client.agentManifests.get("triage");
    await client.agentManifests.get("triage", 2);
    expect(await client.agentManifests.list()).toEqual([{ name: "triage" }]);
    await client.agentManifests.versions("triage");
    await client.agentManifests.delete("triage");
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /v1/agent-manifests/triage",
      "GET /v1/agent-manifests/triage/versions/2",
      "GET /v1/agent-manifests",
      "GET /v1/agent-manifests/triage/versions",
      "DELETE /v1/agent-manifests/triage",
    ]);
    await expect(client.agentManifests.get("no/slash")).rejects.toThrow(TypeError);
  });

  it("compares two versions' sources", async () => {
    const diff = { name: "triage", from: 1, to: 2, added: [], removed: [], changed: [], unchanged: 3 };
    const { client, sent } = fake(() => Response.json(diff));
    expect(await client.agentManifests.sourceDiff("triage", 1, 2)).toEqual(diff);
    expect(sent.map(({ method, path, search }) => `${method} ${path}${search}`)).toEqual([
      "GET /v1/agent-manifests/triage/source/diff?from=1&to=2",
    ]);
  });
});
