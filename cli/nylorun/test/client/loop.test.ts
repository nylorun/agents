/**
 * Both ends of the agent folder loop (track T7): `apply --agent`, the instructions' text diff in a
 * plan, `apply --watch` and `nylorun chat`, against a fake Runtime.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_FEATURES, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { applyCommand } from "../../src/client/apply.js";
import { chatCommand } from "../../src/client/chat.js";
import { lineDiff } from "../../src/client/plan-diff.js";
import { watchApply, type FolderWatcher } from "../../src/client/watch.js";
import { fakeFetch, json, temporaryDir, temporaryHome, testDeps } from "../stack/support.js";

const URL_ = "http://runtime.test";
const KEY = "ab".repeat(32);
const TENANT = "tn_00000000000000000000000001";

type Handler = (method: string, path: string, init?: RequestInit) => Response | undefined;

/** Deps on a remote installation answering `handle`, working in `cwd`. */
async function remote(cwd: string, handle: Handler = () => undefined) {
  const fetch = fakeFetch((url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/health")
      return json({ status: "ok", protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION, features: [...PROTOCOL_FEATURES] } });
    return handle(init?.method ?? "GET", `${parsed.pathname}${parsed.search}`, init);
  });
  const deps = testDeps(await temporaryHome(), { fetch, cwd });
  return Object.assign(deps, { env: { ...deps.env, NYLORUN_RUNTIME_URL: URL_, NYLORUN_SERVER_KEY: KEY }, fetch });
}

const calls = (deps: Awaited<ReturnType<typeof remote>>) =>
  deps.fetch.requests
    .filter((request) => !request.url.endsWith("/health") && request.init?.method !== "HEAD")
    .map((request) => `${request.init?.method ?? "GET"} ${request.url.slice(URL_.length)}`);

const AGENT = "---\nname: support\ndescription: Answers billing questions.\n---\nAnswer questions about invoices.\n";

async function folder(dir: string, text = AGENT): Promise<void> {
  await mkdir(join(dir, "support"), { recursive: true });
  await writeFile(join(dir, "support", "AGENT.md"), text);
}

const plan = (overrides: Record<string, unknown> = {}) => ({
  name: "support",
  from: 1,
  to: 2,
  unchanged: false,
  changes: [],
  warnings: [],
  errors: [],
  behind: 0,
  moves: { now: 0, nextStart: 0, secrets: 0 },
  diagnostics: [],
  compiler: "agent-folder/1",
  ...overrides,
});

/** An Agent as the Runtime shows it, with the fields the CLI prints. */
const agentView = (overrides: Record<string, unknown> = {}) => ({
  id: "support",
  manifest: "support",
  resolvedVersion: 2,
  manifestHash: "sha256:x",
  tracking: "tracking",
  targetVersion: null,
  waitingFor: null,
  failedVersion: null,
  startCheck: null,
  kind: "none",
  harness: "nylorun",
  owner: null,
  labels: {},
  state: "sleeping",
  attention: [],
  ...overrides,
});

describe("the plan's text diff of the instructions", () => {
  it("prints the lines that differ, removed before added, with … between changes apart", () => {
    expect(lineDiff("a\nb\nc\nd\ne", "a\nB\nc\nd\ne\nf")).toEqual(["- b", "+ B", "…", "+ f"]);
    expect(lineDiff("", "one")).toEqual(["+ one"]);
    expect(lineDiff("same", "same")).toEqual([]);
  });
});

describe("nylorun apply --agent", () => {
  it("saves, then makes the Agent from the manifest, and prints its plan's instruction diff and what needs a person", async () => {
    const dir = await temporaryDir();
    await folder(dir);
    const deps = await remote(dir, (method, path) => {
      if (method === "HEAD") return new Response(null, { status: 200 });
      if (path === "/v1/agent-manifests/support?dryRun=true")
        return json(
          plan({
            changes: [
              {
                section: "harness",
                path: "instructions",
                op: "replace",
                from: ["Answer questions about invoices."],
                to: ["Answer questions about invoices and refunds.", "Be brief."],
              },
            ],
          }),
        );
      if (path === "/v1/agent-manifests/support") return json({ manifest: { name: "support", version: 2 }, unchanged: false, warnings: [] });
      if (method === "GET" && path === "/v1/agents/bot") return json({ code: "agent_not_found", message: "No Agent bot." }, 404);
      if (method === "PUT" && path === "/v1/agents/bot")
        return json(agentView({ id: "bot", attention: [{ state: "input_required", reason: "secret_unset: required secret ORDERS_TOKEN unset" }] }));
      return undefined;
    });
    expect(await applyCommand(deps, ["support", "--agent", "bot"])).toBe(0);
    expect(deps.lines).toEqual([
      "support: version 1 → 2",
      "  harness instructions replace",
      "    - Answer questions about invoices.",
      "    + Answer questions about invoices and refunds.",
      "    +",
      "    + Be brief.",
    ]);
    expect(deps.errors).toEqual([
      "Saved agent manifest support version 2 on http://runtime.test.",
      "Made Agent bot: it runs support@2 tracks on http://runtime.test.",
      "  attention: secret_unset: required secret ORDERS_TOKEN unset",
    ]);
    expect(calls(deps).slice(-2)).toEqual(["GET /v1/agents/bot", "PUT /v1/agents/bot"]);
    expect(JSON.parse(String(deps.fetch.requests.at(-1)!.init!.body))).toMatchObject({ manifest: "support" });
  });

  it("moves an existing Agent on an unchanged manifest; the id defaults to the name, and a directory after --agent is a folder", async () => {
    const dir = await temporaryDir();
    await folder(dir);
    const deps = await remote(dir, (method, path) => {
      if (method === "HEAD") return new Response(null, { status: 200 });
      if (path === "/v1/agent-manifests/support?dryRun=true") return json(plan({ from: 2, to: 2, unchanged: true }));
      if (method === "GET" && path === "/v1/agents/support") return json(agentView({ manifest: "support@1", resolvedVersion: 1, tracking: "pinned" }));
      if (method === "PUT" && path === "/v1/agents/support") return json(agentView());
      return undefined;
    });
    expect(await applyCommand(deps, ["--agent", "support"])).toBe(0);
    expect(deps.errors).toEqual(["Moved Agent support from support@1 pinned: it runs support@2 tracks on http://runtime.test."]);
    expect(calls(deps)).toEqual(["PUT /v1/agent-manifests/support?dryRun=true", "GET /v1/agents/support", "PUT /v1/agents/support"]);

    // --dry-run makes no Agent; --save goes with --watch only.
    const before = calls(deps).length;
    expect(await applyCommand(deps, ["support", "--agent", "--dry-run"])).toBe(0);
    expect(calls(deps).slice(before)).toEqual(["PUT /v1/agent-manifests/support?dryRun=true"]);
    await expect(applyCommand(deps, ["support", "--save"])).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("nylorun apply --watch", () => {
  it("checks and plans at once and on each change, and saves nothing without --save", async () => {
    const dir = await temporaryDir();
    await folder(dir);
    const deps = await remote(dir, (method, path) => {
      if (method === "HEAD") return new Response(null, { status: 200 });
      if (path === "/v1/agent-manifests/support?dryRun=true") return json(plan({ from: 1, to: 1, unchanged: true }));
      return undefined;
    });
    let changed: ((path: string) => void) | undefined;
    const watched: string[] = [];
    const watcher: FolderWatcher = (paths, onChange) => {
      watched.push(...paths);
      changed = onChange;
      return { close: () => (changed = undefined) };
    };
    const stop = new AbortController();
    const running = watchApply(deps, { dirs: ["support"], args: ["support"], save: false }, { watcher, signal: stop.signal, debounceMs: 1 });
    const watching = "Watching support for changes (Ctrl-C stops).";
    await vi.waitFor(() => expect(deps.lines).toContain(watching));
    expect(watched).toEqual([join(dir, "support")]);
    expect(deps.lines).toEqual(["support: ok, agent manifest support (1 file, agent-folder/1)", "support: unchanged at version 1", watching]);

    await writeFile(join(dir, "support", "AGENT.md"), "---\nname: support\n---\nWork.\n");
    changed!(join(dir, "support", ".git", "index"));
    changed!(join(dir, "support", "AGENT.md"));
    await vi.waitFor(() => expect(deps.lines.filter((line) => line === watching)).toHaveLength(2));
    expect(deps.lines.slice(3)).toEqual(["", "support/AGENT.md changed: checking again.", watching]);
    expect(deps.errors).toEqual([expect.stringMatching(/^support\/AGENT\.md.* error: description is required/), "support: 1 error"]);

    stop.abort();
    expect(await running).toBe(0);
    expect(changed).toBeUndefined();
    expect(calls(deps)).toEqual(["PUT /v1/agent-manifests/support?dryRun=true"]);
  });
});

/** A session event on the wire, `nylorun.event/2`. */
const event = (turnId: string, type: string, payload: unknown, seq: number) => ({
  schema: "nylorun.event/2",
  eventId: `e${seq}`,
  sessionId: "s1",
  tenantId: TENANT,
  runId: null,
  turnId,
  cursor: `c${seq}`,
  incarnation: 0,
  epoch: 0,
  seq,
  time: `2026-10-20T00:00:0${seq}.000Z`,
  schemaVersion: 1,
  source: { kind: "loop", id: "runtime" },
  evidence: "observed",
  visibility: "public",
  retention: "full",
  type,
  payload,
});

const sse = (events: unknown[]) =>
  new Response(events.map((item, index) => `id: c${index + 1}\ndata: ${JSON.stringify(item)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

describe("nylorun chat", () => {
  it("--message opens a session on the Agent, sends it, and prints the reply of that turn", async () => {
    const dir = await temporaryDir();
    let sessionId = "";
    const deps = await remote(dir, (method, path, init) => {
      if (method === "GET" && path === "/v1/agents/support") return json(agentView({ owner: "ada" }));
      if (method === "PUT" && path.startsWith("/v1/sessions/chat-")) {
        sessionId = decodeURIComponent(path.slice("/v1/sessions/".length));
        expect(JSON.parse(String(init!.body))).toMatchObject({ agent: "support", ownerUserId: "ada" });
        return json({ id: sessionId }, 201);
      }
      if (method === "POST" && path.endsWith("/commands")) {
        expect(JSON.parse(String(init!.body))).toMatchObject({ type: "message", content: "Where is my invoice?" });
        return json({ status: "accepted", turnId: "t2", cursor: "c1", requestId: "r1" });
      }
      if (method === "GET" && path.endsWith("/events"))
        return sse([
          event("t1", "message.assistant", { invocationId: "i0", text: "An older answer.", toolCalls: [] }, 1),
          event("t2", "message.assistant", { invocationId: "i1", text: "", toolCalls: [{ callId: "c", name: "get_order", input: {} }] }, 2),
          event("t2", "message.assistant", { invocationId: "i2", text: "It was sent on Monday.\n", toolCalls: [] }, 3),
          event("t2", "turn.completed", { output: "It was sent on Monday." }, 4),
        ]);
      return undefined;
    });
    expect(await chatCommand(deps, ["support", "--message", "Where is my invoice?"])).toBe(0);
    expect(deps.lines).toEqual(["It was sent on Monday."]);
    expect(deps.errors).toEqual([`Session ${sessionId} on Agent support (continue it with --session ${sessionId}).`, "[get_order]"]);
  });

  it("reuses --session, sends each line, and exits 1 when a turn fails", async () => {
    const dir = await temporaryDir();
    let turn = 0;
    const deps = await remote(dir, (method, path) => {
      if (method === "GET" && path === "/v1/agents/support") return json(agentView());
      if (method === "GET" && path === "/v1/agents/nobody") return json({ code: "agent_not_found", message: "No Agent nobody." }, 404);
      if (method === "GET" && path === "/v1/sessions/s1") return json({ id: "s1", status: "idle" });
      if (method === "POST" && path === "/v1/sessions/s1/commands") {
        turn += 1;
        return json({ status: "accepted", turnId: `t${turn}`, cursor: null, requestId: "r" });
      }
      if (method === "GET" && path === "/v1/sessions/s1/events")
        return sse([
          event("t1", "message.assistant", { invocationId: "i1", text: "Hi.", toolCalls: [] }, 1),
          event("t1", "turn.completed", { output: "Hi." }, 2),
          event("t2", "turn.failed", { error: { code: "model_error", message: "The model is down" } }, 3),
        ]);
      return undefined;
    });
    const lines = (async function* () {
      yield "hello";
      yield "";
      yield "again";
    })();
    expect(await chatCommand(deps, ["support", "--session", "s1"], { lines })).toBe(1);
    expect(deps.lines).toEqual(["Hi."]);
    expect(deps.errors).toEqual(["The turn failed: The model is down."]);
    expect(calls(deps).filter((call) => call.startsWith("PUT"))).toEqual([]);

    await expect(chatCommand(deps, ["nobody", "--message", "x"])).rejects.toMatchObject({ exitCode: 1 });
  });
});
