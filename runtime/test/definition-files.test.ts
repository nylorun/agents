/**
 * Definition files and skills (track R2 M4): the upload route, a definition refused while it
 * names a file the Runtime does not hold, the skill tools the Runtime serves itself, and a
 * skill's files in the session's virtual sandbox.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, AgentsClient } from "@nylorun/agents";
import { DEFINITION_FILE_MAX_BYTES } from "@nylorun/core/contracts";
import { DELEGATE_INPUT_SCHEMA } from "@nylorun/core/define";
import type { ModelProvider } from "../src/core/provider.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "definition-files-application-key-aaaa";
const auth = { authorization: `Bearer ${APP}`, "nylorun-protocol": "10" };
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

  it("refuses a body of another hash, a malformed name and a body over 10 MiB", async () => {
    const runtime = await boot();
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

    const big = new Uint8Array(DEFINITION_FILE_MAX_BYTES + 1);
    const tooLarge = await put(runtime, sha256(big), big);
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ code: "limit_exceeded" });
    // Without a Content-Length, the count stops it too.
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
    expect((await head(runtime, sha256(big))).status).toBe(404);
  });

  it("takes an application key only", async () => {
    const runtime = await boot();
    const file = sha256(LABELS);
    const management = { authorization: `Bearer ${runtime.managementKey}`, "nylorun-protocol": "10" };
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
    id: "skills",
    type: "agent",
    skills: { triage: { name: "triage", description: "Triage an issue.", files } },
  });
  const manifest = (id: string, capabilities: unknown[]) => ({ manifestSchemaVersion: 5, id, capabilities });

  it("is refused while the Runtime lacks a file, its agents' used as tools included", async () => {
    const runtime = await boot();
    const putAgent = (document: unknown) =>
      fetch(`${runtime.url}/v1/agents/${(document as { id: string }).id}`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ requestId: "r", manifest: document, implementationVersion: "dev" }),
      });
    const files = { "SKILL.md": sha256(SKILL_MD), "references/labels.md": sha256(LABELS) };
    const refused = await putAgent(manifest("bot", [skill(files)]));
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { code: string; message: string; details: { missing: string[] } };
    expect(body.code).toBe("definition_files_missing");
    expect(body.details.missing).toEqual([...Object.values(files)].sort());
    expect(body.message).toContain(sha256(LABELS));

    await put(runtime, sha256(SKILL_MD), SKILL_MD);
    const nested = manifest("lead", [
      {
        id: "agent",
        type: "agent",
        tools: [
          {
            name: "helper",
            description: "Helps.",
            inputSchema: DELEGATE_INPUT_SCHEMA,
            agent: { ...manifest("helper", [skill(files)]), description: "Helps." },
          },
        ],
      },
    ]);
    const missing = await putAgent(nested);
    expect(missing.status, await missing.clone().text()).toBe(400);
    expect(await missing.json()).toMatchObject({ details: { missing: [sha256(LABELS)] } });

    await put(runtime, sha256(LABELS), LABELS);
    expect((await putAgent(manifest("bot", [skill(files)]))).status).toBe(200);
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
    const session = await client.createSession({ agentId: "triager", ownerUserId: "ada", sandbox: false });
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

  it("puts a skill's files in the sandbox, read-only, and names them", async () => {
    const runtime = await boot({
      harness,
      modelProvider: scripted([
        { name: "load_skill", args: { name: "triage" } },
        {
          name: "bash",
          args: {
            command:
              "sh /skills/triage/scripts/run.sh; wc -c < /skills/triage/assets/logo.png; cat /skills/triage/references/labels.md",
          },
        },
        { name: "read_skill_resource", args: { name: "triage", path: "assets/logo.png" } },
      ]),
    });
    const agent = Agent({ id: "triager", instructions: "Triage." }).skills(skillsFolder()).build();
    const client = new AgentsClient({ url: runtime.url, key: APP });
    await client.saveAgent(agent, { implementationVersion: "dev" });
    const session = await client.createSession({ agentId: "triager", ownerUserId: "ada", sandbox: {} });
    await session.input("Triage this.", { idempotencyKey: "m1" });
    expect(await settle(runtime, session.id)).toBe("completed");
    const [loaded, ran, logo] = await toolOutcomes(runtime, session.id);
    expect(loaded.output).toMatchObject({ sandboxPath: "/skills/triage/" });
    expect(ran.output).toMatchObject({ exitCode: 0 });
    expect(ran.output.stdout).toContain("triaged");
    expect(ran.output.stdout).toContain(`${LOGO.length}`);
    expect(ran.output.stdout).toContain("P0, P1");
    expect(logo.error.message).toContain("/skills/triage/assets/logo.png");
    const { manifest } = await session.manifest();
    const sandbox = (manifest.capabilities as { id: string; instructions?: string[] }[]).find(
      (item) => item.id === "nylorun.sandbox",
    );
    expect(sandbox?.instructions?.join("\n")).toContain("/skills/triage/");
  });
});
