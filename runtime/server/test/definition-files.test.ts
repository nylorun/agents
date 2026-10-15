/**
 * Definition files and skills (track R2 M4): the upload route, a definition refused while it
 * names a file the Runtime does not hold, the skill tools the Runtime serves itself, and a
 * skill's files in the session's virtual sandbox.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { Agent, AgentsClient } from "@nylorun/agents";
import { SKILL_TOTAL_BYTES_DEFAULT } from "@nylorun/core/contracts";
import { DELEGATE_INPUT_SCHEMA, skillFolderOf } from "@nylorun/core/define";
import { DEFINITION_FILE_CHUNK_BYTES } from "@nylorun/core/harness-api";
import type { BlobStore } from "../src/blob/index.js";
import type { ModelProvider } from "../src/core/provider.js";
import { withTestSessionStore } from "./support/store.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "definition-files-application-key-aaaa";
const auth = { authorization: `Bearer ${APP}`, "nylorun-protocol": String(PROTOCOL_VERSION) };
const json = { ...auth, "content-type": "application/json" };

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

type Runtime = Awaited<ReturnType<typeof startTestTenant>>;

async function boot(options: Parameters<typeof startTestTenant>[0] = {}): Promise<Runtime> {
  const runtime = await startTestTenant({ applicationKey: APP, sandbox: { backend: "virtual" }, ...options });
  closers.push(() => runtime.close());
  return runtime;
}

const sha256 = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function put(runtime: Runtime, file: string, body: BodyInit, headers: Record<string, string> = auth) {
  return fetch(`${runtime.url}/v1/files/${file}`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/octet-stream" },
    body,
    duplex: "half",
  } as RequestInit);
}

const head = (runtime: Runtime, file: string, headers: Record<string, string> = auth) =>
  fetch(`${runtime.url}/v1/files/${file}`, { method: "HEAD", headers });

/** A PUT that declares `declared` bytes and sends a few: the Runtime answers before it reads on. */
function putDeclaring(runtime: Runtime, file: string, declared: number): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = httpRequest(
      `${runtime.url}/v1/files/${file}`,
      {
        method: "PUT",
        headers: { ...auth, "content-type": "application/octet-stream", "content-length": String(declared) },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => {
          settled = true;
          request.destroy();
          resolve({ status: response.statusCode!, body: JSON.parse(text) });
        });
      },
    );
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
    request.write(new Uint8Array(16));
  });
}

/** What the Tenant's Object store holds under `prefix`. */
async function keysUnder(blobs: BlobStore, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const entry of blobs.list(prefix)) keys.push(entry.key);
  return keys;
}

const SKILL_MD = "---\nname: triage\ndescription: Triage an issue.\n---\n\nLabel P0 when the order is lost.\n";
const LABELS = "# Labels\nP0, P1\n";
const LOGO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0xff]);
const SCRIPT = "echo triaged\n";

/** A skills folder with a text resource, a script and a binary file. */
function skillsFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "nylorun-skills-"));
  const write = (path: string, contents: string | Uint8Array) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  write("triage/SKILL.md", SKILL_MD);
  write("triage/references/labels.md", LABELS);
  write("triage/scripts/run.sh", SCRIPT);
  write("triage/assets/logo.png", LOGO);
  return root;
}

/** An Agent Plugin, `ops` 1.2.0, whose skills are `skillsFolder()`'s. */
function pluginFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "nylorun-plugin-"));
  writeFileSync(
    join(root, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "ops",
      version: "1.2.0",
    }),
  );
  cpSync(skillsFolder(), join(root, "skills"), { recursive: true });
  return root;
}

/** A model that runs `steps` tool calls in turn, then answers. */
function scripted(steps: { name: string; args: Record<string, unknown> }[]): ModelProvider {
  return async (effect) => {
    const prompt = (effect.input as { prompt?: { kind?: string }[] }).prompt ?? [];
    const done = prompt.filter((item) => item.kind === "tool-result").length;
    const step = steps[done];
    if (!step) return { output: [{ type: "text", text: "done" }] };
    return { output: [{ type: "tool-call", id: `call-${done}`, name: step.name, args: step.args }] };
  };
}

async function settle(runtime: Runtime, sessionId: string): Promise<string> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const view = (await (await fetch(`${runtime.url}/v1/sessions/${sessionId}`, { headers: auth })).json()) as {
      status: string;
    };
    if (["completed", "failed", "cancelled", "uncertain", "waiting"].includes(view.status)) return view.status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("session did not settle");
}

async function toolOutcomes(runtime: Runtime, sessionId: string) {
  const response = await fetch(`${runtime.url}/v1/sessions/${sessionId}/items`, { headers: auth });
  const { items } = (await response.json()) as { items: { type: string; payload: any }[] };
  return items.filter((item) => item.type === "tool.completed").map((item) => item.payload);
}

describe("PUT and HEAD /v1/files/{file}", () => {
  it("stores a file once at its hash: 201, then 200 without rewriting", async () => {
    const runtime = await boot();
    const file = sha256(LABELS);
    expect((await head(runtime, file)).status).toBe(404);
    const first = await put(runtime, file, LABELS);
    expect(first.status, await first.clone().text()).toBe(201);
    expect(await first.json()).toEqual({ sha256: file, size: Buffer.byteLength(LABELS) });
    expect((await head(runtime, file)).status).toBe(200);
    const again = await put(runtime, file, LABELS);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ sha256: file, size: Buffer.byteLength(LABELS) });
  });

  it("refuses a body of another hash, a malformed name and a body declared over 2 GiB, staging nothing", async () => {
    let blobs!: BlobStore;
    const runtime = await boot({ wrapBlobs: (store) => (blobs = store) });
    const mismatch = await put(runtime, sha256("other"), LABELS);
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({
      code: "invalid_request",
      details: { expected: sha256("other"), actual: sha256(LABELS) },
    });
    expect((await head(runtime, sha256("other"))).status).toBe(404);

    const malformed = await put(runtime, "sha256:ABC", LABELS);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "invalid_request" });

    // One file may be as large as the Tenant allows a whole skill: 2 GiB by default.
    const tooLarge = await putDeclaring(runtime, sha256("big"), SKILL_TOTAL_BYTES_DEFAULT + 1);
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body).toMatchObject({ code: "limit_exceeded", details: { limitBytes: 2 * 1024 ** 3 } });
    expect((await head(runtime, sha256("big"))).status).toBe(404);
    // The refused bodies left nothing behind, at their hash or staged.
    expect(await keysUnder(blobs, "definitions/")).toEqual([]);
  });

  it("streams a file over 10 MiB to its hash, without a Content-Length too", async () => {
    let blobs!: BlobStore;
    const runtime = await boot({ wrapBlobs: (store) => (blobs = store) });
    const big = new Uint8Array(10 * 1024 * 1024 + 1).fill(7);
    const stored = await put(runtime, sha256(big), big);
    expect(stored.status).toBe(201);
    expect(await stored.json()).toEqual({ sha256: sha256(big), size: big.byteLength });
    expect((await head(runtime, sha256(big))).status).toBe(200);

    const streamedBytes = new Uint8Array(11 * 1024 * 1024).fill(9);
    const streamed = await put(
      runtime,
      sha256(streamedBytes),
      new ReadableStream({
        start(controller) {
          controller.enqueue(streamedBytes.subarray(0, 1024));
          controller.enqueue(streamedBytes.subarray(1024));
          controller.close();
        },
      }),
    );
    expect(streamed.status).toBe(201);
    expect(await keysUnder(blobs, "definitions/uploads/")).toEqual([]);
    const held = await blobs.get(`definitions/sha256/${sha256(streamedBytes).slice("sha256:".length)}`);
    // By hash: a deep comparison of 11 MiB is slow.
    expect(sha256(new Uint8Array(await new Response(held!.body).arrayBuffer()))).toBe(sha256(streamedBytes));
  });

  it("takes an application key only", async () => {
    const runtime = await boot();
    const file = sha256(LABELS);
    const management = { authorization: `Bearer ${runtime.managementKey}`, "nylorun-protocol": String(PROTOCOL_VERSION) };
    const managed = await put(runtime, file, LABELS, management);
    expect(managed.status).toBe(403);
    expect(await managed.json()).toMatchObject({ code: "key_role_mismatch" });
    expect((await head(runtime, file, management)).status).toBe(403);
    const subject = { ...auth, "nylorun-subject": "ada", "nylorun-scopes": "sessions:own agents:write" };
    expect((await put(runtime, file, LABELS, subject)).status).toBe(403);
    // A GET of the path is no route.
    expect((await fetch(`${runtime.url}/v1/files/${file}`, { headers: auth })).status).toBe(404);
  });
});

describe("a definition naming definition files", () => {
  const skill = (files: Record<string, string>) => ({
    skills: { triage: { name: "triage", description: "Triage an issue.", files } },
  });
  const manifest = (id: string, parts: Record<string, unknown>) => ({ manifestSchemaVersion: 7, id, ...parts });

  it("is refused while the Runtime lacks a file, its agents' used as tools included", async () => {
    const runtime = await boot();
    const putAgent = (document: unknown) =>
      fetch(`${runtime.url}/v1/agents/${(document as { id: string }).id}`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ requestId: "r", manifest: document, implementationVersion: "dev" }),
      });
    const files = { "SKILL.md": sha256(SKILL_MD), "references/labels.md": sha256(LABELS) };
    const refused = await putAgent(manifest("bot", skill(files)));
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { code: string; message: string; details: { missing: string[] } };
    expect(body.code).toBe("definition_files_missing");
    expect(body.details.missing).toEqual([...Object.values(files)].sort());
    expect(body.message).toContain(sha256(LABELS));

    await put(runtime, sha256(SKILL_MD), SKILL_MD);
    const nested = manifest("lead", {
      tools: [
        {
          name: "helper",
          description: "Helps.",
          inputSchema: DELEGATE_INPUT_SCHEMA,
          agent: { ...manifest("helper", skill(files)), description: "Helps." },
        },
      ],
    });
    const missing = await putAgent(nested);
    expect(missing.status, await missing.clone().text()).toBe(400);
    expect(await missing.json()).toMatchObject({ details: { missing: [sha256(LABELS)] } });

    await put(runtime, sha256(LABELS), LABELS);
    expect((await putAgent(manifest("bot", skill(files)))).status).toBe(200);
  });

  it("is refused while a skill's files hold more than 2 GiB together, with no limit per file or on their count", async () => {
    const runtime = await boot();
    const putAgent = (document: unknown) =>
      fetch(`${runtime.url}/v1/agents/${(document as { id: string }).id}`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ requestId: "r", manifest: document, implementationVersion: "dev" }),
      });
    // Files the Tenant holds, by size alone: putting a definition reads their rows, not their bytes.
    const gib = sha256("a GiB");
    const almost = sha256("2 GiB less a byte");
    await withTestSessionStore({ root: runtime.root, tenantId: runtime.tenantId }, (store) =>
      store.tx(async (t) => {
        for (const [file, size] of [
          [gib, 1024 ** 3],
          [almost, SKILL_TOTAL_BYTES_DEFAULT - Buffer.byteLength(SKILL_MD)],
        ] as const)
          await t.insertDefinitionFile({ sha256: file, kind: "skill", size, contentType: null, createdAt: new Date().toISOString() });
      }),
    );
    await put(runtime, sha256(SKILL_MD), SKILL_MD);
    await put(runtime, sha256(LABELS), LABELS);

    // Exactly 2 GiB: one file holds nearly all of it.
    const full = { "SKILL.md": sha256(SKILL_MD), "data/model.bin": almost };
    expect((await putAgent(manifest("full", skill(full)))).status).toBe(200);

    // One file at two paths counts twice: a sandbox holds both.
    const over = { "SKILL.md": sha256(SKILL_MD), "data/one.bin": gib, "data/two.bin": gib };
    const refused = await putAgent(manifest("over", skill(over)));
    expect(refused.status).toBe(413);
    const bytes = 2 * 1024 ** 3 + Buffer.byteLength(SKILL_MD);
    expect(await refused.json()).toMatchObject({
      code: "limit_exceeded",
      message: expect.stringContaining(`'triage' holds ${bytes}`),
      details: { limitBytes: SKILL_TOTAL_BYTES_DEFAULT, skills: [{ name: "triage", bytes }] },
    });
    // An agent used as a tool is held to it too.
    const nested = manifest("lead", {
      tools: [
        {
          name: "helper",
          description: "Helps.",
          inputSchema: DELEGATE_INPUT_SCHEMA,
          agent: { ...manifest("helper", skill(over)), description: "Helps." },
        },
      ],
    });
    expect((await putAgent(nested)).status).toBe(413);

    // More than 500 files.
    const many: Record<string, string> = { "SKILL.md": sha256(SKILL_MD) };
    for (let index = 0; index < 600; index += 1) many[`references/${index}.md`] = sha256(LABELS);
    const stored = await putAgent(manifest("many", skill(many)));
    expect(stored.status, await stored.clone().text()).toBe(200);
  });
});

describe("skill limits", () => {
  const skill = (files: Record<string, string>) => ({
    skills: { triage: { name: "triage", description: "Triage an issue.", files } },
  });
  const manifest = (id: string, parts: Record<string, unknown>) => ({ manifestSchemaVersion: 7, id, ...parts });

  it("are the Tenant's for every agent and upload, and an Environment's manifest may set less for its sessions", async () => {
    const runtime = await boot();
    const manage = { ...runtime.managementHeaders(), "content-type": "application/json" };
    const call = (method: string, path: string, body: unknown, headers: Record<string, string> = json) =>
      fetch(`${runtime.url}${path}`, { method, headers, body: JSON.stringify(body) });
    const got = await fetch(`${runtime.url}/v1/tenant/skills`, { headers: manage });
    expect(await got.json()).toEqual({ limits: { totalBytes: SKILL_TOTAL_BYTES_DEFAULT } });
    // An application key is not the operator's.
    expect((await fetch(`${runtime.url}/v1/tenant/skills`, { headers: auth })).status).toBe(403);
    const set = await call("PUT", "/v1/tenant/skills", { limits: { totalBytes: 1000 } }, manage);
    expect(await set.json()).toEqual({ limits: { totalBytes: 1000 } });

    // An upload past the Tenant's limit, by its declared length or as it streams.
    const declared = await putDeclaring(runtime, sha256("big"), 1001);
    expect(declared).toMatchObject({ status: 413, body: { code: "limit_exceeded", details: { limitBytes: 1000 } } });
    const big = new Uint8Array(1001);
    const streamed = await put(
      runtime,
      sha256(big),
      new ReadableStream({
        start(controller) {
          controller.enqueue(big);
          controller.close();
        },
      }),
    );
    expect(streamed.status).toBe(413);

    // A skill of 900 bytes and SKILL.md fits; with a second copy of the file it does not.
    const data = new Uint8Array(900).fill(1);
    expect((await put(runtime, sha256(SKILL_MD), SKILL_MD)).status).toBe(201);
    expect((await put(runtime, sha256(data), data)).status).toBe(201);
    const files = { "SKILL.md": sha256(SKILL_MD), "data.bin": sha256(data) };
    const agent = { requestId: "r", manifest: manifest("bot", skill(files)), implementationVersion: "dev" };
    expect((await call("PUT", "/v1/agents/bot", agent)).status).toBe(200);
    const twice = await call("PUT", "/v1/agents/twice", {
      ...agent,
      manifest: manifest("twice", skill({ ...files, "copy.bin": sha256(data) })),
    });
    expect(twice.status).toBe(413);
    expect(await twice.json()).toMatchObject({ details: { limitBytes: 1000, skills: [{ name: "triage" }] } });

    // An Environment may not ask for more than the Tenant allows, inline or in a manifest.
    const above = await call("PUT", "/v1/environments/roomy", {
      kind: "virtual",
      limits: { skills: { totalBytes: 2000 } },
    });
    expect(above.status).toBe(400);
    expect(await above.text()).toContain("limits.skills.totalBytes asks for 2000 bytes; this Tenant allows at most 1000.");
    const saved = await call("PUT", "/v1/environment-manifests/roomy", {
      manifestSchemaVersion: 1,
      name: "roomy",
      limits: { skills: { totalBytes: 2000 } },
    });
    expect(saved.status).toBe(400);

    // A session opens only where its agent's skills fit: a manifest's lower limit refuses it.
    const tight = await call("PUT", "/v1/environment-manifests/tight", {
      manifestSchemaVersion: 1,
      name: "tight",
      limits: { skills: { totalBytes: 500 } },
    });
    expect(tight.status, await tight.clone().text()).toBe(200);
    const made = await call("PUT", "/v1/environments/tight", { manifest: "tight" });
    expect(((await made.json()) as { limits: unknown }).limits).toMatchObject({ skills: { totalBytes: 500 } });
    const refused = await call("PUT", "/v1/sessions/s1", {
      requestId: "s1",
      agentId: "bot",
      ownerUserId: "ada",
      environment: "tight",
    });
    expect(refused.status).toBe(409);
    const bytes = 900 + Buffer.byteLength(SKILL_MD);
    expect(await refused.json()).toMatchObject({
      code: "environment_unsuitable",
      message: expect.stringContaining(`Environment tight allows a skill's files at most 500 bytes together`),
      details: { limitBytes: 500, skills: [{ name: "triage", bytes }] },
    });
    // Without one, the Environment takes the Tenant's limit.
    await call("PUT", "/v1/environments/plain", { kind: "virtual" });
    const opened = await call("PUT", "/v1/sessions/s2", {
      requestId: "s2",
      agentId: "bot",
      ownerUserId: "ada",
      environment: "plain",
    });
    expect(opened.status, await opened.clone().text()).toBe(200);
  });
});

describe.each(["memory", "ws"] as const)("skills on a %s harness", (harness) => {
  it("serves load_skill and read_skill_resource from the uploaded files", async () => {
    const runtime = await boot({
      harness,
      modelProvider: scripted([
        { name: "load_skill", args: { name: "triage" } },
        { name: "read_skill_resource", args: { name: "triage", path: "references/labels.md" } },
        { name: "read_skill_resource", args: { name: "triage", path: "assets/logo.png" } },
        { name: "read_skill_resource", args: { name: "triage", path: "nope.md" } },
      ]),
    });
    const agent = Agent({ id: "triager", instructions: "Triage." }).skills(skillsFolder()).build();
    const client = new AgentsClient({ url: runtime.url, key: APP });
    await client.saveAgent(agent, { implementationVersion: "dev" });
    for (const contents of [SKILL_MD, LABELS, LOGO, SCRIPT])
      expect((await head(runtime, sha256(contents))).status).toBe(200);
    // No Environment: no sandbox.
    const session = await client.createSession({ agentId: "triager", ownerUserId: "ada" });
    await session.input("Triage this.", { idempotencyKey: "m1" });
    expect(await settle(runtime, session.id)).toBe("completed");
    const [loaded, labels, logo, unknown] = await toolOutcomes(runtime, session.id);
    expect(loaded.output).toEqual({
      name: "triage",
      content: "Label P0 when the order is lost.\n",
      resources: ["assets/logo.png", "references/labels.md", "scripts/run.sh"],
    });
    expect(labels.output).toEqual({ name: "triage", path: "references/labels.md", content: LABELS });
    expect(logo.error).toMatchObject({
      code: "skill.binary_resource",
      message: expect.stringContaining("only text files can be read without a sandbox"),
    });
    expect(unknown.error).toMatchObject({ code: "skill.unknown_resource" });
  });

  it("puts a plugin skill's files in the sandbox, read-only, names them, and traces each call to the skill and its plugin", async () => {
    // A file larger than one harness answer carries, and than the skill tools read: the
    // sandbox gets it a range at a time.
    const folderOfPlugin = pluginFolder();
    const BIG = DEFINITION_FILE_CHUNK_BYTES + 3;
    writeFileSync(join(folderOfPlugin, "skills/triage/references/big.txt"), "a".repeat(BIG));
    const agent = Agent({ id: "triager", instructions: "Triage." }).plugin(folderOfPlugin).build();
    // The version's own folder (D66).
    const folder = skillFolderOf(agent.manifest.skills!.triage!);
    expect(folder).toMatch(/^\/skills\/triage@[0-9a-f]{12}$/);
    const runtime = await boot({
      harness,
      modelProvider: scripted([
        { name: "load_skill", args: { name: "triage" } },
        {
          name: "bash",
          args: {
            command: `sh ${folder}/scripts/run.sh; wc -c < ${folder}/assets/logo.png; cat ${folder}/references/labels.md; echo big=$(wc -c < ${folder}/references/big.txt)`,
          },
        },
        { name: "read_skill_resource", args: { name: "triage", path: "assets/logo.png" } },
        { name: "read_skill_resource", args: { name: "triage", path: "references/big.txt" } },
      ]),
    });
    const client = new AgentsClient({ url: runtime.url, key: APP });
    await client.saveAgent(agent, { implementationVersion: "dev" });
    await client.environments.put("triage", { kind: "virtual" });
    const session = await client.createSession({ agentId: "triager", ownerUserId: "ada", environment: "triage" });
    await session.input("Triage this.", { idempotencyKey: "m1" });
    expect(await settle(runtime, session.id)).toBe("completed");
    const [loaded, ran, logo, big] = await toolOutcomes(runtime, session.id);
    expect(loaded.output).toMatchObject({ sandboxPath: `${folder}/` });
    expect(ran.output).toMatchObject({ exitCode: 0 });
    expect(ran.output.stdout).toContain("triaged");
    expect(ran.output.stdout).toContain(`${LOGO.length}`);
    expect(ran.output.stdout).toContain("P0, P1");
    expect(logo.error.message).toContain(`${folder}/assets/logo.png`);
    expect(ran.output.stdout).toMatch(new RegExp(`big=\\s*${BIG}`));
    expect(big.error).toMatchObject({
      code: "skill.resource_too_large",
      message: expect.stringContaining(`${folder}/references/big.txt`),
    });
    // From the log alone: each call names the skill it ran and the plugin that brought it.
    const plugin = { name: "ops", version: "1.2.0" };
    expect(loaded).toMatchObject({ kind: "platform", skill: "triage", plugin });
    expect(ran).toMatchObject({ toolName: "bash", kind: "sandbox", skill: "triage", plugin });
    expect(logo).toMatchObject({ skill: "triage", plugin });
    const { manifest } = await session.manifest();
    const runtimeBlock = (manifest as { runtime?: { instructions?: string[] } }).runtime;
    expect(runtimeBlock?.instructions?.join("\n")).toContain(`${folder}/`);
  });
});
