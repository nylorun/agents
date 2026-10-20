import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROTOCOL_FEATURES, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { agentsCommand } from "../../src/client/agents.js";
import { applyCommand } from "../../src/client/apply.js";
import { artifactsCommand } from "../../src/client/artifacts.js";
import { migrateCommand } from "../../src/client/migrate.js";
import { sessionsCommand } from "../../src/client/sessions.js";
import { CliError } from "../../src/errors.js";
import { fakeFetch, json, temporaryDir, temporaryHome, testDeps } from "../stack/support.js";

const URL_ = "http://runtime.test";
/** The required features and the optional ones these commands use. */
const FEATURES = [
  ...PROTOCOL_FEATURES,
  "session-reads",
  "tool-calls",
  "traces",
  "artifact-reads",
  "environment-disk-versions",
];
const KEY = "ab".repeat(32);

type Handler = (method: string, path: string, init?: RequestInit) => Response | undefined;

/** Deps on a remote installation (`NYLORUN_RUNTIME_URL` + `NYLORUN_SERVER_KEY`) answering `handle`. */
async function remote(handle: Handler, env: Record<string, string> = {}) {
  const fetch = fakeFetch((url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/health")
      return json({
        status: "ok",
        protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION, features: FEATURES },
      });
    return handle(init?.method ?? "GET", `${parsed.pathname}${parsed.search}`, init);
  });
  const deps = testDeps(await temporaryHome(), { fetch });
  return Object.assign(deps, {
    env: { ...deps.env, NYLORUN_RUNTIME_URL: URL_, NYLORUN_SERVER_KEY: KEY, ...env },
    fetch,
  });
}

/** The requests other than the protocol check, as `METHOD path`. */
const calls = (deps: Awaited<ReturnType<typeof remote>>) =>
  deps.fetch.requests
    .filter((request) => !request.url.endsWith("/health"))
    .map((request) => `${request.init?.method ?? "GET"} ${request.url.slice(URL_.length)}`);
const bodyOf = (deps: Awaited<ReturnType<typeof remote>>, path: string) =>
  JSON.parse(String(deps.fetch.requests.find((request) => request.url.endsWith(path))!.init!.body));
const headersOf = (deps: Awaited<ReturnType<typeof remote>>, path: string) =>
  new Headers(deps.fetch.requests.find((request) => request.url.includes(path))!.init!.headers);

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** An agent folder as nylorun apply reads it: three files, a skill and a runtime file beside. */
async function agentFolder(root: string, harness: Record<string, unknown> = {}) {
  await mkdir(join(root, "agents", "support", "skills", "triage"), { recursive: true });
  await mkdir(join(root, "shared", "kit"), { recursive: true });
  await writeFile(
    join(root, "agents", "support", "agent.manifest.json"),
    JSON.stringify({ manifestSchemaVersion: 8, name: "support", harness: "./harness.manifest.json", runtime: "../../shared/runtime.manifest.json" }),
  );
  await writeFile(
    join(root, "agents", "support", "harness.manifest.json"),
    JSON.stringify({ instructions: ["Answer briefly."], skills: "./skills", ...harness }),
  );
  await writeFile(join(root, "agents", "support", "skills", "triage", "SKILL.md"), SKILL);
  await writeFile(
    join(root, "shared", "runtime.manifest.json"),
    JSON.stringify({ kind: "virtual", files: [{ path: "/workspace/kit", from: "./kit" }] }),
  );
  await writeFile(join(root, "shared", "kit", "run.sh"), "echo kit\n");
}
const SKILL = "---\nname: triage\ndescription: Triage an issue.\n---\nLabel it.\n";
const PLAN = { name: "support", from: 2, to: 3, unchanged: false, warnings: [], errors: [], behind: 1 };

/** The warning every three-file folder gets (D80), naming the command that converts it. */
const DEPRECATED = expect.stringMatching(/^support: warning: agent\.manifest\.json \(the three-file format\) is deprecated: nylorun migrate folder /);

describe("nylorun apply", () => {
  it("plans each folder's manifest, then saves it under If-Match with its files uploaded first", async () => {
    const dir = await temporaryDir();
    await agentFolder(dir);
    const held = new Set([`/v1/files/${sha("echo kit\n")}`]);
    const deps = Object.assign(
      await remote((method, path, init) => {
        if (method === "HEAD") return new Response(null, { status: held.has(path) ? 200 : 404 });
        if (method === "PUT" && path.startsWith("/v1/files/")) {
          held.add(path);
          return json({ sha256: path.slice(10), size: 8 }, 201);
        }
        if (method === "PUT" && path === "/v1/agent-manifests/support?dryRun=true")
          return json({
            ...PLAN,
            changes: [{ section: "harness", path: "instructions", op: "replace", from: ["Old."], to: ["Answer briefly."] }],
            warnings: [{ code: "behind", message: "1 Agent stays on version 2" }],
          });
        if (method === "PUT" && path === "/v1/agent-manifests/support") {
          expect(new Headers(init!.headers).get("if-match")).toBe("2");
          return json({ manifest: { name: "support", version: 3 }, unchanged: false, warnings: [] });
        }
        return undefined;
      }),
      { cwd: dir },
    );
    expect(await applyCommand(deps, ["agents"])).toBe(0);
    expect(deps.lines).toEqual([
      "support: version 2 → 3 (1 Agent on older versions)",
      "  harness instructions replace",
      "    - Old.",
      "    + Answer briefly.",
      "  warning: 1 Agent stays on version 2",
    ]);
    expect(deps.errors).toEqual([DEPRECATED, "Saved agent manifest support version 3 on http://runtime.test."]);
    // The plan uploads what the Runtime lacks (files are stored by content); the save finds them held.
    expect(calls(deps)).toEqual([
      `HEAD /v1/files/${sha("echo kit\n")}`,
      `HEAD /v1/files/${sha(SKILL)}`,
      `PUT /v1/files/${sha(SKILL)}`,
      "PUT /v1/agent-manifests/support?dryRun=true",
      `HEAD /v1/files/${sha("echo kit\n")}`,
      `HEAD /v1/files/${sha(SKILL)}`,
      "PUT /v1/agent-manifests/support",
    ]);
    const saved = JSON.parse(String(deps.fetch.requests.at(-1)!.init!.body));
    expect(saved.harness.skills.triage.files).toEqual({ "SKILL.md": sha(SKILL) });
    expect(saved.runtime.files).toEqual([{ path: "/workspace/kit", files: { "run.sh": sha("echo kit\n") } }]);
  });

  it("--dry-run saves nothing; a manifest with gaps is an error, saved by no one (exit 1)", async () => {
    const dir = await temporaryDir();
    await agentFolder(dir, { requires: { sandbox: "pod" } });
    const deps = Object.assign(
      await remote((method, path) => {
        if (method === "HEAD") return new Response(null, { status: 200 });
        if (method === "PUT" && path === "/v1/agent-manifests/support?dryRun=true")
          return json({ ...PLAN, from: null, to: 1, changes: [] });
        return undefined;
      }),
      { cwd: join(dir, "agents", "support") },
    );
    expect(await applyCommand(deps, ["--dry-run"])).toBe(1);
    expect(deps.lines).toEqual([
      "support: new, version 1 (1 Agent on older versions)",
      '  error: harness.requires.sandbox "pod" needs runtime.kind "pod"; the runtime is "virtual"',
    ]);
    expect(calls(deps).filter((call) => !call.startsWith("HEAD"))).toEqual(["PUT /v1/agent-manifests/support?dryRun=true"]);
    expect(deps.errors).toEqual([DEPRECATED, "Nothing was saved for a manifest with errors."]);
  });

  it("refuses a folder with no manifest, and a file that does not validate, before any request", async () => {
    const dir = await temporaryDir();
    const deps = Object.assign(await remote(() => undefined), { cwd: dir });
    await expect(applyCommand(deps, [])).rejects.toMatchObject({ exitCode: 2 });
    await agentFolder(dir, { approval: "always" });
    const error = await applyCommand(deps, ["agents/support"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as Error).message).toMatch(/harness\.manifest\.json is not valid/);
    expect(deps.fetch.requests).toEqual([]);
  });
});

describe("nylorun migrate v8", () => {
  const v7 = {
    manifestSchemaVersion: 7,
    id: "support",
    description: "Helps.",
    instructions: ["Answer briefly."],
    tools: [
      {
        name: "lookup",
        inputSchema: { type: "object", properties: {} },
        http: { url: "https://items.example.com/lookup", credential: "items" },
      },
    ],
    requires: { sandbox: "any", secrets: ["GH_TOKEN"] },
  };

  it("writes the three files from a v7 manifest and an environment manifest, and names the gaps to fix", async () => {
    const dir = await temporaryDir();
    await writeFile(join(dir, "agent.json"), JSON.stringify(v7));
    await writeFile(
      join(dir, "box.json"),
      JSON.stringify({
        $schema: "https://docs.nylorun.com/schemas/environment-manifest/v1.json",
        manifestSchemaVersion: 1,
        name: "box",
        description: "A box.",
        harness: "nylorun",
        kind: "pod",
        image: "node:24",
        secrets: { GH_TOKEN: { type: "environment_secret", allowedHosts: ["api.github.com"] } },
      }),
    );
    const deps = Object.assign(await remote(() => undefined), { cwd: dir });
    expect(await migrateCommand(deps, ["v8", "agent.json", "--runtime", "box.json", "--out", "agents/support"])).toBe(0);
    const read = async (file: string) => JSON.parse(await readFile(join(dir, "agents", "support", file), "utf8"));
    expect(await read("agent.manifest.json")).toEqual({
      $schema: "https://docs.nylorun.com/schemas/agent-manifest/v8.json",
      manifestSchemaVersion: 8,
      name: "support",
      description: "Helps.",
      harness: "./harness.manifest.json",
      runtime: "./runtime.manifest.json",
    });
    expect(await read("harness.manifest.json")).toEqual({
      $schema: "https://docs.nylorun.com/schemas/harness-manifest/v1.json",
      instructions: ["Answer briefly."],
      tools: v7.tools,
      requires: { sandbox: "any", secrets: ["GH_TOKEN"] },
    });
    expect(await read("runtime.manifest.json")).toEqual({
      $schema: "https://docs.nylorun.com/schemas/runtime-manifest/v1.json",
      kind: "pod",
      image: "node:24",
      secrets: { GH_TOKEN: { type: "environment_secret", allowedHosts: ["api.github.com"] } },
    });
    expect(deps.errors).toEqual([
      '  fix before apply: harness.tools.lookup.http.credential "items" is not a secret slot in runtime.secrets',
      "Save it with nylorun apply agents/support.",
    ]);
    // Nothing is written over an existing file.
    await expect(migrateCommand(deps, ["v8", "agent.json", "--out", "agents/support"])).rejects.toMatchObject({ exitCode: 1 });
    expect(deps.fetch.requests).toEqual([]);
  });

  it("without an environment manifest, kind is virtual for skills or a sandbox, else none", async () => {
    const dir = await temporaryDir();
    const { requires: _, ...plain } = v7;
    await writeFile(join(dir, "plain.json"), JSON.stringify({ ...plain, tools: [] }));
    await writeFile(
      join(dir, "skilled.json"),
      JSON.stringify({ ...plain, tools: [], skills: { triage: { name: "triage", description: "Triage", files: { "SKILL.md": sha(SKILL) } } } }),
    );
    const deps = Object.assign(await remote(() => undefined), { cwd: dir });
    expect(await migrateCommand(deps, ["v8", "plain.json", "--out", "plain"])).toBe(0);
    expect(await migrateCommand(deps, ["v8", "skilled.json", "--out", "skilled"])).toBe(0);
    const kind = async (out: string) => JSON.parse(await readFile(join(dir, out, "runtime.manifest.json"), "utf8")).kind;
    expect(await kind("plain")).toBe("none");
    expect(await kind("skilled")).toBe("virtual");
  });
});

describe("nylorun sessions", () => {
  const accepted = () => json({ accepted: true, eventId: "e1" }, 202);

  it("create, send text, files or data, approve, respond and cancel", async () => {
    const deps = await remote((method, path) => {
      if (method === "PUT" && path === "/v1/sessions/s1") return json({ id: "s1" }, 201);
      if (method === "POST" && path === "/v1/sessions/s1/commands") return accepted();
      return undefined;
    });
    expect(
      await sessionsCommand(deps, ["create", "--agent", "users/u1/support", "--owner", "u1", "--id", "s1", "--info", '{"ticket":7}']),
    ).toBe(0);
    expect(deps.lines).toEqual(["s1"]);
    expect(bodyOf(deps, "/v1/sessions/s1")).toEqual({
      requestId: expect.any(String),
      agent: "users/u1/support",
      ownerUserId: "u1",
      info: { ticket: 7 },
    });
    await sessionsCommand(deps, ["send", "s1", "Hello", "--idempotency-key", "k1"]);
    await sessionsCommand(deps, ["send", "s1", "Read this", "--file", "a1@2", "--file", "a2"]);
    await sessionsCommand(deps, ["send", "s1", "--data", '{"order":123}']);
    await sessionsCommand(deps, ["approve", "s1", "i1", "--deny"]);
    await sessionsCommand(deps, ["respond", "s1", "i2", '"yes"']);
    await sessionsCommand(deps, ["cancel", "s1", "--reason", "stop"]);
    const commands = deps.fetch.requests
      .filter((request) => request.url.endsWith("/commands"))
      .map((request) => JSON.parse(String(request.init!.body)));
    expect(commands).toMatchObject([
      { type: "message", content: "Hello", idempotencyKey: "k1" },
      {
        type: "message",
        parts: [
          { type: "text", text: "Read this" },
          { type: "file", artifactId: "a1", version: 2 },
          { type: "file", artifactId: "a2" },
        ],
      },
      { type: "message", data: { order: 123 } },
      { type: "approve", interactionId: "i1", approved: false },
      { type: "respond", interactionId: "i2", value: "yes" },
      { type: "cancel", reason: "stop" },
    ]);
  });

  it("list prints the sessions and the next page's cursor", async () => {
    const deps = await remote((method, path) =>
      method === "GET" && path.startsWith("/v1/sessions?")
        ? json({
            sessions: [
              {
                id: "s1",
                agentId: "support",
                ownerUserId: "u1",
                status: "idle",
                activeTurnId: null,
                lastTurnId: null,
                createdAt: null,
                lastEventAt: "2026-10-14T00:00:00.000Z",
              },
            ],
            nextCursor: "c2",
          })
        : undefined,
    );
    expect(await sessionsCommand(deps, ["list", "--agent", "support", "--manifest", "triage", "--limit", "1"])).toBe(0);
    expect(calls(deps)).toEqual(["GET /v1/sessions?limit=1&agentId=support&manifest=triage"]);
    expect(deps.lines[0]).toMatch(/^ID +AGENT +OWNER +STATUS +LAST EVENT$/);
    expect(deps.lines[1]).toMatch(/^s1 +support +u1 +idle +2026-10-14T00:00:00\.000Z$/);
    expect(deps.errors).toEqual(["More: --cursor c2"]);
  });

  it("calls --tool, trace and exec", async () => {
    const deps = await remote((method, path) => {
      if (path.startsWith("/v1/sessions/s1/calls/tool")) return json({ calls: [], nextCursor: null, asOf: "t" });
      if (path === "/v1/sessions/s1/turns/t1/trace") return json({ resourceSpans: [] });
      if (method === "POST" && path === "/v1/sessions/s1/sandbox/bash")
        return json({ kind: "completed", output: { exitCode: 3, stdout: "out\n", stderr: "err\n" } });
      return undefined;
    });
    expect(await sessionsCommand(deps, ["calls", "s1", "--tool", "--turn", "t1"])).toBe(0);
    expect(await sessionsCommand(deps, ["trace", "s1", "t1"])).toBe(0);
    deps.lines.length = 0;
    expect(await sessionsCommand(deps, ["exec", "s1", "--timeout", "30", "--", "ls", "-la"])).toBe(3);
    expect(bodyOf(deps, "/sandbox/bash")).toEqual({ command: "ls -la", timeout: 30 });
    expect(deps.lines).toEqual(["out"]);
    expect(deps.errors).toEqual(["err"]);
  });

  it("acts for a subject with --as, and sends NYLORUN_TOKEN in place of the key", async () => {
    const handle: Handler = (method, path) => (path === "/v1/sessions/s1" ? json({ id: "s1", status: "idle" }) : undefined);
    const deps = await remote(handle);
    await sessionsCommand(deps, ["get", "s1", "--as", "user:7", "--scope", "sessions:own", "--scope", "agents:write"]);
    const headers = headersOf(deps, "/v1/sessions/s1");
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("nylorun-subject")).toBe("user:7");
    expect(headers.get("nylorun-scopes")).toBe("sessions:own agents:write");
    const token = await remote(handle, { NYLORUN_SERVER_KEY: "", NYLORUN_TOKEN: "idp-token" });
    await sessionsCommand(token, ["get", "s1"]);
    expect(headersOf(token, "/v1/sessions/s1").get("authorization")).toBe("Bearer idp-token");
  });

  it("turns a Runtime's refusal into its message (exit 1)", async () => {
    const deps = await remote(() =>
      json({ code: "session_closed", message: "The session is closed." }, 409),
    );
    const error = await sessionsCommand(deps, ["cancel", "s1"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(1);
    expect((error as Error).message).toBe("The session is closed (session_closed). HTTP 409.");
  });
});

describe("nylorun agents", () => {
  it("secrets put reads a typed secret from a file; restore puts a disk version back", async () => {
    const dir = await temporaryDir();
    await writeFile(join(dir, "secret.json"), JSON.stringify({ type: "bearer", value: "t0k", url: "https://mcp.test/" }));
    const deps = await remote((method, path) => {
      if (method === "PUT" && path === "/v1/agents/users%2Fu1/secrets/linear") return json({ name: "linear" });
      if (method === "POST" && path === "/v1/agents/users%2Fu1/restore") return json({ agentId: "users/u1", restored: 4, status: "done" });
      return undefined;
    });
    expect(await agentsCommand(deps, ["secrets", "put", "users/u1", "linear", join(dir, "secret.json")])).toBe(0);
    expect(bodyOf(deps, "/secrets/linear")).toMatchObject({ type: "bearer", value: "t0k" });
    expect(await agentsCommand(deps, ["restore", "users/u1", "latest"])).toBe(0);
    expect(bodyOf(deps, "/restore")).toMatchObject({ version: "latest" });
  });
});

describe("nylorun artifacts", () => {
  it("upload names the file after its path and prints the id; link prints the URL; download writes the bytes", async () => {
    const dir = await temporaryDir();
    await writeFile(join(dir, "brief.txt"), "hello");
    const view = {
      artifactId: "a1",
      kind: "file",
      name: "brief.txt",
      contentType: "text/plain",
      latestVersion: 1,
      createdAt: "t",
      updatedAt: "t",
    };
    const deps = await remote((method, path) => {
      if (method === "POST" && path.startsWith("/v1/artifacts?"))
        return json({ artifact: view, version: { version: 1, size: 5, sha256: "x", contentType: "text/plain", source: "upload", createdAt: "t" } }, 201);
      if (method === "POST" && path === "/v1/artifacts/a1/links")
        return json({ token: "tok", path: "/v1/artifact-links/tok", expiresAt: "t", artifactId: "a1", version: 1 }, 201);
      if (method === "GET" && path === "/v1/artifacts/a1/versions/latest/content")
        return new Response("hello", { headers: { "content-type": "text/plain" } });
      return undefined;
    });
    expect(await artifactsCommand(deps, ["upload", join(dir, "brief.txt"), "--session", "s1", "--label", "kind=brief"])).toBe(0);
    expect(calls(deps)[0]).toBe("POST /v1/artifacts?name=brief.txt&sessionId=s1&label=kind%3Dbrief");
    expect(deps.lines).toEqual(["a1"]);
    expect(await artifactsCommand(deps, ["link", "a1", "--expires-in", "60"])).toBe(0);
    expect(deps.lines.at(-1)).toMatch(/^http:\/\/runtime\.test\/v1\/artifact-links\/tok/);
    const output = join(dir, "copy.txt");
    expect(await artifactsCommand(deps, ["download", "a1", "--output", output])).toBe(0);
    expect(await readFile(output, "utf8")).toBe("hello");
  });
});
