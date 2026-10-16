import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tenantCommand } from "../../src/client/tenant.js";
import { CliError } from "../../src/errors.js";
import type { StackDeps } from "../../src/stack/commands.js";
import { fakeFetch, json, temporaryDir, temporaryHome, testDeps } from "../stack/support.js";

const URL = "http://runtime.test";
const KEY = "cd".repeat(32);
const API_KEY = "sk-test-0123456789";

const call = (id: string) => ({
  id,
  effectId: `ef_${id}`,
  sessionId: "ses_1",
  turnId: "turn_1",
  manifestName: "support",
  provider: "openai",
  model: "gpt-test",
  at: "2026-10-14T00:00:00.000Z",
  outcome: "completed",
  usage: null,
});

const PROVIDERS = [
  { id: "openai", name: "OpenAI", model: "gpt-test", authType: "api_key", lastUpdated: "2026-10-14T00:00:00.000Z", active: true },
  {
    id: "custom",
    name: "Custom",
    model: "llama",
    authType: "api_key",
    baseUrl: "http://llm.test/v1",
    lastUpdated: "2026-10-14T00:00:00.000Z",
    active: false,
  },
];

/** The Management API routes the commands call: each echoes what a Runtime would answer. */
function route(url: string, init?: RequestInit): Response | undefined {
  const method = init?.method ?? "GET";
  const path = url.slice(URL.length);
  const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
  const view = (provider: string, model: string, baseUrl?: string) =>
    json({ configured: true, provider, model, authType: "api_key", ...(baseUrl ? { baseUrl } : {}) });
  if (method === "GET" && path === "/v1/tenant/models")
    return json({
      providers: [
        { id: "openai", name: "OpenAI", models: [{ id: "gpt-test", name: "GPT", inputs: ["text", "image"], addableInputs: [] }] },
      ],
    });
  if (method === "GET" && path === "/v1/tenant/providers") return json({ providers: PROVIDERS });
  if (method === "GET" && path === "/v1/tenant/model") return view("openai", "gpt-test");
  if (method === "PUT" && path === "/v1/tenant/model") return view(body.provider, body.model, body.baseUrl);
  if (method === "PUT" && path === "/v1/tenant/model/selection")
    return view(body.provider, body.model, body.baseUrl);
  if (method === "GET" && path.startsWith("/v1/tenant/usage?"))
    return json({ scope: "tenant", period: "total", calls: 2, tokens: 30, costUsd: 0.01 });
  if (method === "GET" && path.startsWith("/v1/tenant/calls/model?")) {
    const after = new URLSearchParams(path.split("?")[1]).get("after");
    return after === null
      ? json({ calls: [call("c1"), call("c2")], next: "cur_2", caughtUp: false, asOf: "2026-10-14T00:00:00.000Z" })
      : json({ calls: [call("c3")], next: "cur_3", caughtUp: true, asOf: "2026-10-14T00:00:00.000Z" });
  }
  if (method === "GET" && path === "/v1/tenant/budgets") return json({ budgets: [] });
  if (method === "PUT" && path === "/v1/tenant/budgets") return json({ budgets: body.budgets });
  if (method === "GET" && path === "/v1/tenant/tool-policy")
    return json({ rules: [{ effect: "deny", tool: "delete_*" }], updatedAt: "2026-10-14T00:00:00.000Z" });
  if (method === "PUT" && path === "/v1/tenant/tool-policy")
    return json({ rules: body.rules, updatedAt: "2026-10-14T01:00:00.000Z" });
  if (method === "GET" && path === "/v1/tenant/sandbox") return json({ preference: "auto", backend: null });
  if (method === "PUT" && path === "/v1/tenant/sandbox") return json({ preference: "auto", backend: null, put: body });
  if (method === "GET" && path === "/v1/tenant/artifacts")
    return json({ limits: { fileBytes: 100, totalBytes: 1000 }, usedBytes: 5 });
  if (method === "PUT" && path === "/v1/tenant/artifacts")
    return json({ limits: body.limits, usedBytes: 5 });
  if (method === "GET" && path === "/v1/tenant/skills") return json({ limits: { totalBytes: 2048 } });
  if (method === "PUT" && path === "/v1/tenant/skills") return json({ limits: body.limits });
  if (method === "GET" && path === "/v1/tenant/limits") return json({ limits: { recordEntryBytes: 4096, chunkBytes: 1024 } });
  if (method === "PUT" && path === "/v1/tenant/limits") return json({ limits: body.limits });
  if (method === "POST" && path === "/v1/tenant/credential-coverage")
    return json({
      agentId: body.agentId,
      complete: false,
      entries: [
        {
          kind: "mcp",
          name: "github",
          serverName: "github",
          url: "https://mcp.github.test/",
          required: false,
          status: "covered",
          credential: { environmentId: body.agentId, name: "GITHUB" },
          message: "Sends GITHUB.",
        },
        {
          kind: "http",
          name: "billing",
          serverName: "billing",
          url: "https://billing.test/",
          required: true,
          status: "missing",
          message: "Fails with http.credential.",
        },
      ],
    });
  return undefined;
}

/** Deps on a remote installation whose Management API answers `route`; `stdin` when given. */
async function remote(stdin?: StackDeps["stdin"]) {
  const fetch = fakeFetch(route);
  const home = await temporaryHome();
  const deps = testDeps(home, { fetch, ...(stdin ? { stdin } : {}) });
  return Object.assign(deps, {
    env: { ...deps.env, NYLORUN_RUNTIME_URL: URL, NYLORUN_MANAGEMENT_KEY: KEY },
    fetch,
  });
}

const piped = (text: string): StackDeps["stdin"] => ({ isTTY: false, text: async () => text });

/** Each request as method, path and body, after checking it carried the management key. */
function sent(deps: Awaited<ReturnType<typeof remote>>) {
  return deps.fetch.requests.map(({ url, init }) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    return {
      method: init?.method ?? "GET",
      path: url.slice(URL.length),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
    };
  });
}

async function exitCodeOf(promise: Promise<number>): Promise<number> {
  const error = await promise.catch((e: unknown) => e);
  if (typeof error === "number") return error;
  expect(error).toBeInstanceOf(CliError);
  return (error as CliError).exitCode;
}

describe("nylorun tenant models", () => {
  it("catalog, providers and get print tables or a line, else JSON", async () => {
    const deps = await remote();
    expect(await tenantCommand(deps, ["models", "catalog"])).toBe(0);
    expect(deps.lines.splice(0)).toEqual(["PROVIDER  MODEL     READS", "openai    gpt-test  text,image"]);
    expect(await tenantCommand(deps, ["models", "providers"])).toBe(0);
    expect(deps.lines.splice(0)).toEqual([
      "PROVIDER  MODEL     AUTH     IN USE",
      "openai    gpt-test  api_key  yes",
      "custom    llama     api_key",
    ]);
    expect(await tenantCommand(deps, ["models", "get"])).toBe(0);
    expect(deps.lines.splice(0)).toEqual(["openai  gpt-test  api_key"]);
    expect(await tenantCommand(deps, ["models", "providers", "--json"])).toBe(0);
    expect(JSON.parse(deps.lines.splice(0).join("\n"))).toEqual(PROVIDERS);
    expect(sent(deps)).toEqual([
      { method: "GET", path: "/v1/tenant/models" },
      { method: "GET", path: "/v1/tenant/providers" },
      { method: "GET", path: "/v1/tenant/model" },
      { method: "GET", path: "/v1/tenant/providers" },
    ]);
  });

  it("select keeps the provider's model and endpoint unless --model names another", async () => {
    const deps = await remote();
    expect(await tenantCommand(deps, ["models", "select", "custom"])).toBe(0);
    expect(await tenantCommand(deps, ["models", "select", "openai", "--model", "gpt-other"])).toBe(0);
    expect(deps.lines).toEqual(["custom  llama  api_key  http://llm.test/v1", "openai  gpt-other  api_key"]);
    const selections = sent(deps).filter((r) => r.path === "/v1/tenant/model/selection");
    expect(selections.map((r) => r.body)).toEqual([
      expect.objectContaining({ provider: "custom", model: "llama", baseUrl: "http://llm.test/v1" }),
      expect.objectContaining({ provider: "openai", model: "gpt-other" }),
    ]);
    for (const { body } of selections) expect(body.idempotencyKey).toEqual(expect.any(String));
    // A provider without a credential: exit 1 after reading the list.
    deps.fetch.requests.splice(0);
    expect(await exitCodeOf(tenantCommand(deps, ["models", "select", "anthropic"]))).toBe(1);
    expect(sent(deps).map((r) => r.path)).toEqual(["/v1/tenant/providers"]);
  });

  it("set --provider --model reads the API key from stdin and puts an api_key credential", async () => {
    const deps = await remote(piped(`${API_KEY}\n`));
    expect(
      await tenantCommand(deps, ["models", "set", "--provider", "custom", "--model", "llama", "--base-url", "http://llm.test/v1"]),
    ).toBe(0);
    const [put] = sent(deps);
    expect(put).toMatchObject({
      method: "PUT",
      path: "/v1/tenant/model",
      body: { provider: "custom", model: "llama", baseUrl: "http://llm.test/v1", auth: { type: "api_key", key: API_KEY } },
    });
    expect(put!.body.idempotencyKey).toEqual(expect.any(String));
    expect(deps.lines).toEqual(["custom  llama  api_key  http://llm.test/v1"]);
  });

  it("set refuses a terminal, an empty stdin or a missing --model, before any request", async () => {
    const terminal = await remote({ isTTY: true, text: async () => API_KEY });
    const args = ["models", "set", "--provider", "openai", "--model", "gpt-test"];
    const error = await tenantCommand(terminal, args).catch((e: unknown) => e);
    expect((error as CliError).exitCode).toBe(2);
    expect((error as CliError).message).toContain("Pipe the API key in on standard input");
    expect(await exitCodeOf(tenantCommand(await remote(), args))).toBe(2);
    const empty = await remote(piped("\n"));
    expect(await exitCodeOf(tenantCommand(empty, args))).toBe(2);
    const half = await remote(piped(API_KEY));
    expect(await exitCodeOf(tenantCommand(half, ["models", "set", "--provider", "openai"]))).toBe(2);
    for (const deps of [terminal, empty, half]) expect(deps.fetch.requests).toEqual([]);
  });
});

describe("nylorun tenant usage and calls", () => {
  it("usage maps --scope, --id and --period to the query and prints JSON", async () => {
    const deps = await remote();
    expect(await tenantCommand(deps, ["usage"])).toBe(0);
    expect(JSON.parse(deps.lines.join("\n"))).toMatchObject({ calls: 2, costUsd: 0.01 });
    expect(await tenantCommand(deps, ["usage", "--scope", "manifest", "--id", "support", "--period", "month"])).toBe(0);
    expect(sent(deps).map((r) => r.path)).toEqual([
      "/v1/tenant/usage?scope=tenant&period=total",
      "/v1/tenant/usage?scope=manifest&period=month&id=support",
    ]);
  });

  it("calls prints every row of every page as one JSON line, then the cursor on stderr", async () => {
    const deps = await remote();
    expect(await tenantCommand(deps, ["calls", "--limit", "2"])).toBe(0);
    expect(deps.lines.map((line) => JSON.parse(line).id)).toEqual(["c1", "c2", "c3"]);
    expect(deps.errors).toEqual(["Caught up. Resume with --after cur_3"]);
    expect(sent(deps).map((r) => r.path)).toEqual([
      "/v1/tenant/calls/model?limit=2",
      "/v1/tenant/calls/model?limit=2&after=cur_2",
    ]);
    deps.fetch.requests.splice(0);
    expect(await tenantCommand(deps, ["calls", "--after", "cur_2"])).toBe(0);
    expect(sent(deps).map((r) => r.path)).toEqual(["/v1/tenant/calls/model?limit=200&after=cur_2"]);
  });
});

describe("nylorun tenant budgets, tool-policy and settings", () => {
  it("get prints each document as JSON", async () => {
    const deps = await remote();
    for (const args of [
      ["budgets"],
      ["budgets", "get"],
      ["tool-policy", "get"],
      ["settings", "sandbox"],
      ["settings", "artifacts", "get"],
      ["settings", "skills"],
      ["settings", "limits", "get"],
    ])
      expect(await tenantCommand(deps, args)).toBe(0);
    expect(sent(deps).map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /v1/tenant/budgets",
      "GET /v1/tenant/budgets",
      "GET /v1/tenant/tool-policy",
      "GET /v1/tenant/sandbox",
      "GET /v1/tenant/artifacts",
      "GET /v1/tenant/skills",
      "GET /v1/tenant/limits",
    ]);
    expect(JSON.parse(deps.lines.at(-3)!)).toEqual({
      limits: { fileBytes: 100, totalBytes: 1000 },
      usedBytes: 5,
    });
    expect(JSON.parse(deps.lines.at(-2)!)).toEqual({ limits: { totalBytes: 2048 } });
    expect(JSON.parse(deps.lines.at(-1)!)).toEqual({ limits: { recordEntryBytes: 4096, chunkBytes: 1024 } });
  });

  it("put reads the body from a file or from stdin, and what get printed puts back", async () => {
    const dir = await temporaryDir();
    const budgets = {
      budgets: [
        { scope: "tenant", period: "day", limitUsd: 5 },
        { scope: "manifest", id: "support", period: "month", limitTokens: 1000 },
      ],
    };
    await writeFile(join(dir, "budgets.json"), JSON.stringify(budgets));
    // What `tool-policy get` printed: its updatedAt is dropped.
    const policy = { rules: [{ effect: "ask", tool: "send_*" }], updatedAt: "2026-10-14T00:00:00.000Z" };
    const deps = await remote(piped(JSON.stringify(policy)));
    expect(await tenantCommand(deps, ["budgets", "put", join(dir, "budgets.json")])).toBe(0);
    expect(await tenantCommand(deps, ["tool-policy", "put", "-"])).toBe(0);
    await writeFile(join(dir, "artifacts.json"), JSON.stringify({ limits: { fileBytes: 10 }, usedBytes: 5 }));
    expect(await tenantCommand(deps, ["settings", "artifacts", "put", join(dir, "artifacts.json")])).toBe(0);
    await writeFile(join(dir, "sandbox.json"), JSON.stringify({ limits: { environments: 3 } }));
    expect(await tenantCommand(deps, ["settings", "sandbox", "put", join(dir, "sandbox.json")])).toBe(0);
    await writeFile(join(dir, "skills.json"), JSON.stringify({ limits: { totalBytes: 4096 } }));
    expect(await tenantCommand(deps, ["settings", "skills", "put", join(dir, "skills.json")])).toBe(0);
    await writeFile(join(dir, "limits.json"), JSON.stringify({ limits: { modelCallBytes: 2048 } }));
    expect(await tenantCommand(deps, ["settings", "limits", "put", join(dir, "limits.json")])).toBe(0);
    const puts = sent(deps);
    expect(puts.map((r) => `${r.method} ${r.path}`)).toEqual([
      "PUT /v1/tenant/budgets",
      "PUT /v1/tenant/tool-policy",
      "PUT /v1/tenant/artifacts",
      "PUT /v1/tenant/sandbox",
      "PUT /v1/tenant/skills",
      "PUT /v1/tenant/limits",
    ]);
    expect(puts[4]!.body).toEqual({ requestId: expect.any(String), limits: { totalBytes: 4096 } });
    expect(puts[5]!.body).toEqual({ requestId: expect.any(String), limits: { modelCallBytes: 2048 } });
    expect(puts[0]!.body).toMatchObject(budgets);
    expect(puts[1]!.body).toEqual({ requestId: expect.any(String), rules: policy.rules });
    expect(puts[2]!.body).toEqual({ requestId: expect.any(String), limits: { fileBytes: 10 } });
    expect(puts[3]!.body).toMatchObject({ limits: { environments: 3 } });
  });

  it("a body that is missing, not JSON or not valid is a usage error, before any request", async () => {
    const dir = await temporaryDir();
    await writeFile(join(dir, "bad.json"), "{");
    await writeFile(join(dir, "turn.json"), JSON.stringify({ budgets: [{ scope: "turn", period: "day", limitUsd: 1 }] }));
    const deps = await remote(piped(JSON.stringify({ rules: [{ effect: "maybe" }] })));
    for (const args of [
      ["budgets", "put", join(dir, "missing.json")],
      ["budgets", "put", join(dir, "bad.json")],
      ["budgets", "put", join(dir, "turn.json")],
      ["tool-policy", "put", "-"],
    ])
      expect(await exitCodeOf(tenantCommand(deps, args))).toBe(2);
    const terminal = await remote({ isTTY: true, text: async () => "{}" });
    expect(await exitCodeOf(tenantCommand(terminal, ["budgets", "put", "-"]))).toBe(2);
    expect(deps.fetch.requests).toEqual([]);
    expect(terminal.fetch.requests).toEqual([]);
  });
});

describe("nylorun tenant coverage", () => {
  it("posts the Agent and prints a summary and a table, else JSON", async () => {
    const deps = await remote();
    expect(await tenantCommand(deps, ["coverage", "--agent", "users/u1/support"])).toBe(0);
    expect(deps.lines.splice(0)).toEqual([
      "Agent users/u1/support: 1 of 2 missing",
      "STATUS   KIND  NAME     URL                       SECRET",
      "covered  mcp   github   https://mcp.github.test/  GITHUB",
      "missing  http  billing  https://billing.test/     (required)",
    ]);
    expect(await tenantCommand(deps, ["coverage", "--agent", "support", "--json"])).toBe(0);
    expect(JSON.parse(deps.lines.join("\n"))).toMatchObject({ agentId: "support", complete: false });
    expect(sent(deps).map((r) => r.body)).toEqual([
      { requestId: expect.any(String), agentId: "users/u1/support" },
      { requestId: expect.any(String), agentId: "support" },
    ]);
  });
});

describe("nylorun tenant usage errors", () => {
  it("exit 2 before any request", async () => {
    const deps = await remote(piped("{}"));
    for (const args of [
      ["models"],
      ["models", "list"],
      ["models", "get", "extra"],
      ["models", "catalog", "--yes"],
      ["models", "select"],
      ["models", "select", "a", "b"],
      ["usage", "--scope", "everything"],
      ["usage", "--period", "week"],
      ["usage", "--scope", "agent"],
      ["usage", "--scope", "agent", "--id", "support"],
      ["usage", "--scope", "manifest"],
      ["usage", "--id", "support"],
      ["calls", "--limit", "0"],
      ["calls", "--limit", "many"],
      ["calls", "extra"],
      ["budgets", "put"],
      ["budgets", "put", "a.json", "b.json"],
      ["budgets", "get", "a.json"],
      ["budgets", "delete"],
      ["tool-policy", "set", "-"],
      ["settings"],
      ["settings", "model"],
      ["settings", "sandbox", "put"],
      ["coverage"],
      ["coverage", "--environment", "env_1"],
      ["coverage", "--agent", "support", "--environment", "env_1"],
      ["coverage", "--agent", "support", "extra"],
      ["nope"],
    ])
      expect(await exitCodeOf(tenantCommand(deps, args)), args.join(" ")).toBe(2);
    expect(deps.fetch.requests).toEqual([]);
  });
});
