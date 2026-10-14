import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROTOCOL_FEATURES, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { agentsCommand } from "../../src/client/agents.js";
import { artifactsCommand } from "../../src/client/artifacts.js";
import { environmentsCommand } from "../../src/client/environments.js";
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

describe("nylorun agents", () => {
  const manifest = (files: Record<string, string>) => ({
    manifestSchemaVersion: 7,
    id: "support",
    instructions: ["Answer briefly."],
    skills: { triage: { name: "triage", description: "Triage", files } },
  });

  it("save uploads the files the manifest names that the Runtime lacks, found by hash, then saves", async () => {
    const dir = await temporaryDir();
    await mkdir(join(dir, "skills", "triage"), { recursive: true });
    await writeFile(join(dir, "skills", "triage", "SKILL.md"), "# Triage");
    await writeFile(join(dir, "skills", "other.txt"), "held already");
    await writeFile(
      join(dir, "agent.json"),
      JSON.stringify(manifest({ "SKILL.md": sha("# Triage"), "notes.txt": sha("held already") })),
    );
    const deps = await remote((method, path) => {
      if (method === "HEAD") return new Response(null, { status: path.endsWith(sha("held already")) ? 200 : 404 });
      if (method === "PUT" && path.startsWith("/v1/files/")) return json({ sha256: path.slice(10), size: 8 }, 201);
      if (method === "PUT" && path === "/v1/agents/support") return json({ agentId: "support", manifestHash: "h" });
      return undefined;
    });
    expect(
      await agentsCommand(deps, ["save", join(dir, "agent.json"), "--files", join(dir, "skills"), "--implementation-version", "v3"]),
    ).toBe(0);
    expect(calls(deps)).toEqual([
      `HEAD /v1/files/${sha("# Triage")}`,
      `PUT /v1/files/${sha("# Triage")}`,
      `HEAD /v1/files/${sha("held already")}`,
      "PUT /v1/agents/support",
    ]);
    expect(bodyOf(deps, "/v1/agents/support")).toMatchObject({ implementationVersion: "v3", manifest: { id: "support" } });
    expect(deps.errors).toEqual(["Saved agent support on http://runtime.test (2 files, 1 uploaded)."]);
  });

  it("save refuses, before any request, a manifest naming a file it cannot find", async () => {
    const dir = await temporaryDir();
    await writeFile(join(dir, "agent.json"), JSON.stringify(manifest({ "SKILL.md": sha("missing") })));
    const deps = await remote(() => undefined);
    const error = await agentsCommand(deps, ["save", join(dir, "agent.json"), "--files", dir]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as Error).message).toContain(`manifest.skills.triage.files["SKILL.md"] = ${sha("missing")}`);
    expect(deps.fetch.requests).toEqual([]);
  });

  it("list prints a table, and get one agent's entry", async () => {
    const deps = await remote((method, path) =>
      method === "GET" && path === "/v1/agents"
        ? json({ agents: [{ agentId: "support", manifestHash: "h", implementationVersion: "dev", manifest: { description: "Helps" } }] })
        : undefined,
    );
    expect(await agentsCommand(deps, ["list"])).toBe(0);
    expect(deps.lines).toEqual(["ID       KIND   DESCRIPTION", "support  agent  Helps"]);
    expect(await agentsCommand(deps, ["get", "support"])).toBe(0);
    expect(JSON.parse(deps.lines.slice(2).join("\n"))).toMatchObject({ agentId: "support" });
    expect(await agentsCommand(deps, ["get", "ghost"])).toBe(1);
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
      await sessionsCommand(deps, ["create", "--agent", "support", "--owner", "u1", "--environment", "users/u1", "--id", "s1", "--info", '{"ticket":7}']),
    ).toBe(0);
    expect(deps.lines).toEqual(["s1"]);
    expect(bodyOf(deps, "/v1/sessions/s1")).toMatchObject({
      agentId: "support",
      ownerUserId: "u1",
      environment: "users/u1",
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
                environmentId: null,
                createdAt: null,
                lastEventAt: "2026-10-14T00:00:00.000Z",
              },
            ],
            nextCursor: "c2",
          })
        : undefined,
    );
    expect(await sessionsCommand(deps, ["list", "--agent", "support", "--limit", "1"])).toBe(0);
    expect(calls(deps)).toEqual(["GET /v1/sessions?limit=1&agentId=support"]);
    expect(deps.lines[0]).toMatch(/^ID +AGENT +OWNER +STATUS +ENVIRONMENT +LAST EVENT$/);
    expect(deps.lines[1]).toMatch(/^s1 +support +u1 +idle +- +2026-10-14T00:00:00\.000Z$/);
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
    await sessionsCommand(deps, ["get", "s1", "--as", "user:7", "--scope", "sessions:own", "--scope", "environments:write"]);
    const headers = headersOf(deps, "/v1/sessions/s1");
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("nylorun-subject")).toBe("user:7");
    expect(headers.get("nylorun-scopes")).toBe("sessions:own environments:write");
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

describe("nylorun environments", () => {
  it("put merges a recipe file with --kind and --label; secrets put reads the secret from a file", async () => {
    const dir = await temporaryDir();
    await writeFile(join(dir, "recipe.json"), JSON.stringify({ labels: { team: "a" }, network: { preset: "dev" } }));
    await writeFile(join(dir, "secret.json"), JSON.stringify({ type: "bearer", token: "t0k", url: "https://mcp.test/" }));
    const deps = await remote((method, path) => {
      if (method === "PUT" && path === "/v1/environments/users%2Fu1") return json({ id: "users/u1" });
      if (method === "PUT" && path === "/v1/environments/users%2Fu1/secrets/linear") return json({ name: "linear" });
      if (method === "POST" && path === "/v1/environments/users%2Fu1/restore") return json({ version: 4 });
      return undefined;
    });
    expect(
      await environmentsCommand(deps, ["put", "users/u1", join(dir, "recipe.json"), "--kind", "virtual", "--label", "owner=u1"]),
    ).toBe(0);
    expect(bodyOf(deps, "/v1/environments/users%2Fu1")).toMatchObject({
      kind: "virtual",
      labels: { team: "a", owner: "u1" },
      network: { preset: "dev" },
    });
    expect(await environmentsCommand(deps, ["secrets", "put", "users/u1", "linear", join(dir, "secret.json")])).toBe(0);
    expect(bodyOf(deps, "/secrets/linear")).toMatchObject({ type: "bearer", token: "t0k" });
    expect(await environmentsCommand(deps, ["restore", "users/u1", "latest"])).toBe(0);
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
