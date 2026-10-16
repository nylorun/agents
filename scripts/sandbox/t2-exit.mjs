#!/usr/bin/env node
// Track T2's exit test (Agents from one manifest, protocol 16) on a real cluster, as one scenario:
//
//   node scripts/sandbox/t2-exit.mjs --context docker-desktop
//   node scripts/sandbox/t2-exit.mjs --context kind-nylorun --host-address 172.17.0.1
//
// Starts a Tenant with Studio, turns on its fixture model and sandbox pods, then:
//
// - `nylorun apply` on a folder of three files (`agent.manifest.json`, `harness.manifest.json`,
//   `runtime.manifest.json`, a pod) saves one agent manifest, `triage`, version 1;
// - `PUT /v1/agents/triage` makes the Agent from it, and a session the developer opens on it,
//   `triage-inbox`, runs a turn whose `bash` runs in the Agent's pod (/workspace);
// - a manifest whose MCP server names a credential the runtime section declares no slot for is
//   refused at save: `nylorun apply` exits 1 naming the gap and saves nothing, and the API answers
//   `422 manifest_inconsistent` with the gap;
// - Studio, signed in like a browser, lists the Agent with its manifest version and its state.
//
// Needs what `npm run test:sandboxes` needs (kubectl, a context with agent-sandbox, the workspace
// builds, images the cluster's node can use: CI loads them with `kind load docker-image`).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { ensureImages, eventually, runtimeHeaders, studioSession, withStack } from "../lib/stack.mjs";

const { values: options } = parseArgs({
  options: {
    context: { type: "string", default: process.env.NYLORUN_SANDBOX_CONTEXT ?? "kind-nylorun" },
    "host-address": { type: "string", default: process.env.NYLORUN_SANDBOX_HOST_ADDRESS },
  },
});
const started = Date.now();
const step = (message) => console.log(`\n[t2-exit ${Math.round((Date.now() - started) / 1000)}s] ${message}`);
const MCP_URL = "https://mcp.example.com/mcp";

/** Writes the three files of one agent into `dir`; `secrets` is the runtime file's slots. */
async function agentFolder(dir, name, { secrets } = {}) {
  await mkdir(dir, { recursive: true });
  const json = (file, value) => writeFile(join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
  await json("agent.manifest.json", {
    $schema: "https://docs.nylorun.com/schemas/agent-manifest/v8.json",
    manifestSchemaVersion: 8,
    name,
    description: "Triages the inbox.",
    harness: "./harness.manifest.json",
    runtime: "./runtime.manifest.json",
  });
  await json("harness.manifest.json", {
    $schema: "https://docs.nylorun.com/schemas/harness-manifest/v1.json",
    instructions: ["Triage the inbox. Answer briefly."],
    ...(secrets === undefined
      ? {}
      : {
          mcpServers: { tracker: { name: "tracker", type: "streamable-http", url: MCP_URL } },
          credentials: { tracker: "TRACKER_TOKEN" },
        }),
  });
  await json("runtime.manifest.json", {
    $schema: "https://docs.nylorun.com/schemas/runtime-manifest/v1.json",
    kind: "pod",
    ...(secrets === undefined ? {} : { secrets }),
  });
}

const images = await ensureImages({ only: ["runtime", "studio", "sandboxes"] });
const folders = await mkdtemp(join(tmpdir(), "nylorun-t2-exit-"));
let failed = false;
const check = (ok, detail) => {
  console.log(`${ok ? "pass" : "fail"} ${detail}`);
  if (!ok) failed = true;
};
try {
  await withStack({ name: "nylorun-t2-exit", images }, async (stack) => {
    let tenant = await stack.tenant();
    const manage = async (method, path, body) => {
      const response = await fetch(`${stack.runtimeUrl}${path}`, {
        method,
        headers: runtimeHeaders(tenant.managementKey, { "content-type": "application/json" }),
        body: JSON.stringify({ requestId: randomUUID(), ...body }),
      });
      assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.text()}`);
    };
    const api = async (method, path, body) => {
      const response = await fetch(`${stack.runtimeUrl}${path}`, {
        method,
        headers: runtimeHeaders(tenant.key, { "content-type": "application/json" }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : undefined };
    };
    const ok = async (method, path, body) => {
      const answer = await api(method, path, body);
      assert.ok(answer.status < 300, `${method} ${path}: ${answer.status} ${JSON.stringify(answer.body)}`);
      return answer.body;
    };
    /** `nylorun apply <dir>` with this Tenant's application key, as a developer runs it. */
    const apply = (dir) =>
      new Promise((resolve) => {
        execFile(
          process.execPath,
          [stack.cli, "apply", dir],
          {
            env: { ...stack.env, NYLORUN_RUNTIME_URL: stack.runtimeUrl, NYLORUN_SERVER_KEY: tenant.key },
            timeout: 120_000,
          },
          (error, stdout, stderr) => {
            console.log(stdout + stderr);
            resolve({ code: error ? (error.code ?? 1) : 0, output: stdout + stderr });
          },
        );
      });

    step(`nylorun local sandbox enable --context ${options.context}`);
    const enable = ["local", "sandbox", "enable", "--context", options.context, "--no-pull"];
    if (options["host-address"]) enable.push("--host-address", options["host-address"]);
    await stack.nylorun(enable, { timeout: 900_000 });
    tenant = await stack.tenant();
    await manage("PUT", "/v1/tenant/sandbox", { limits: { idle: "10m" }, lifecycle: { stopGrace: "10s" } });
    await manage("PUT", "/v1/tenant/config/seed", { fixtureModel: true });

    step("nylorun apply: three files make one agent manifest");
    const triage = join(folders, "triage");
    await agentFolder(triage, "triage");
    const applied = await apply(triage);
    check(applied.code === 0 && /triage: new, version 1/.test(applied.output), `nylorun apply saved triage version 1 (exit ${applied.code})`);
    const saved = await ok("GET", "/v1/agent-manifests/triage");
    check(
      saved.version === 1 && saved.manifest?.runtime?.kind === "pod" && saved.manifest?.harness?.instructions?.length === 1,
      `the saved manifest holds both sections: runtime ${saved.manifest?.runtime?.kind}, version ${saved.version}`,
    );

    step("PUT /v1/agents/triage, and the session triage-inbox runs a turn on its pod");
    const made = await ok("PUT", "/v1/agents/triage", { requestId: randomUUID(), manifest: "triage" });
    check(made.kind === "pod" && made.resolvedVersion === 1 && made.manifest === "triage", `the Agent runs triage@${made.resolvedVersion} on a ${made.kind}`);
    await ok("PUT", "/v1/sessions/triage-inbox", { requestId: randomUUID(), agent: "triage", ownerUserId: "t2-exit" });
    const requestId = randomUUID();
    await ok("POST", "/v1/sessions/triage-inbox/commands", {
      type: "message",
      requestId,
      idempotencyKey: requestId,
      content: `fixture:tool bash ${JSON.stringify({ command: "echo triage-pod:$(pwd):$(hostname)" })}`,
    });
    const items = await eventually(
      async () => {
        const { items } = await ok("GET", "/v1/sessions/triage-inbox/items");
        return items.some((item) => /^turn\.(completed|failed|cancelled)$/.test(item.type)) && items;
      },
      { timeout: 600_000, interval: 1000, message: "the turn of triage-inbox to end" },
    );
    const end = items.find((item) => /^turn\.(completed|failed|cancelled)$/.test(item.type));
    check(end?.type === "turn.completed", `the turn ended ${end?.type}`);
    const ran = items.find((item) => item.type === "tool.completed" && item.payload?.toolName === "bash");
    const stdout = String(ran?.payload?.output?.stdout ?? "");
    const pod = (await ok("GET", "/v1/agents/triage")).compute?.pod;
    check(
      stdout.includes("triage-pod:/workspace:") && pod !== undefined,
      `bash ran in the Agent's pod, in /workspace: ${JSON.stringify(stdout.trim())}`,
    );
    const session = await ok("GET", "/v1/sessions/triage-inbox");
    check(
      session.agentId === "triage" && session.manifest?.name === "triage" && session.manifest?.version === 1,
      `the session runs on Agent ${session.agentId}, pinned to ${session.manifest?.name}@${session.manifest?.version}`,
    );

    step("a manifest whose MCP server needs an undeclared secret is refused at save");
    const gap = 'harness.mcpServers.tracker.credential "TRACKER_TOKEN" is not a secret slot in runtime.secrets';
    const undeclared = join(folders, "undeclared");
    await agentFolder(undeclared, "undeclared", { secrets: {} });
    const refused = await apply(undeclared);
    check(refused.code === 1 && refused.output.includes(gap), `nylorun apply exits 1 naming the gap (exit ${refused.code})`);
    const put = await api("PUT", "/v1/agent-manifests/undeclared", {
      requestId: randomUUID(),
      manifestSchemaVersion: 8,
      name: "undeclared",
      harness: { mcpServers: { tracker: { name: "tracker", type: "streamable-http", url: MCP_URL, credential: "TRACKER_TOKEN" } } },
      runtime: { kind: "pod" },
    });
    check(
      put.status === 422 && put.body?.code === "manifest_inconsistent" && JSON.stringify(put.body?.details?.gaps ?? []).includes("TRACKER_TOKEN"),
      `the Runtime refuses it: ${put.status} ${put.body?.code}`,
    );
    check((await api("GET", "/v1/agent-manifests/undeclared")).status === 404, "nothing was saved");

    step("Studio lists the Agent with its manifest version and state");
    const studio = await studioSession(await stack.studioLogin());
    const listed = await studio.get(`/_studio/tenants/${tenant.id}/runtime/v1/agents`);
    const page = listed.ok ? await listed.json() : undefined;
    const row = (page?.agents ?? page?.items ?? []).find((agent) => agent.id === "triage");
    check(
      listed.status === 200 && row?.manifest === "triage" && row?.resolvedVersion === 1 && typeof row?.state === "string",
      `Studio's Runtime API lists triage: manifest ${row?.manifest}@${row?.resolvedVersion}, state ${row?.state}`,
    );
    const screen = await studio.get(`/tenants/${tenant.id}/agents`);
    check(screen.status === 200, `Studio serves the Agents screen (${screen.status})`);

    await api("DELETE", "/v1/agents/triage");
    if (failed) await stack.logs().catch(() => {});
  });
} finally {
  await rm(folders, { recursive: true, force: true });
}
console.log(failed ? "\nt2-exit: FAILED" : "\nt2-exit: passed");
process.exitCode = failed ? 1 : 0;
