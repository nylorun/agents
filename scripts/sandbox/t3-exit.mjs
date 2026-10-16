#!/usr/bin/env node
// Track T3's exit test (Agents that evolve, D73) on a real cluster, as one scenario:
//
//   node scripts/sandbox/t3-exit.mjs --context docker-desktop
//   node scripts/sandbox/t3-exit.mjs --context kind-nylorun --host-address 172.17.0.1
//
// Starts a Tenant with its fixture model and sandbox pods, makes the pod Agent `evolve` that
// tracks its manifest, writes a file on its disk and a secret in its vault from a session, then
// moves it three times while the session keeps going:
//
// - an instruction change (harness only) applies at once: the session's next turn runs it;
// - a runtime change a pod applies only when it starts (its resources) waits for the pod's next
//   start, then runs on a new pod on the same volume: the file is still there;
// - a version whose setup fails goes back to the version it ran, with the file intact, and the
//   Agent names the version that failed.
//
// Through all of it the Agent keeps its id, its vault and its session, and each turn's end names
// the version it ran.
//
// Needs what `npm run test:sandboxes` needs (kubectl, a context with agent-sandbox, the workspace
// builds, images the cluster's node can use: CI loads them with `kind load docker-image`).
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { ensureImages, eventually, runtimeHeaders, withStack } from "../lib/stack.mjs";

const { values: options } = parseArgs({
  options: {
    context: { type: "string", default: process.env.NYLORUN_SANDBOX_CONTEXT ?? "kind-nylorun" },
    "host-address": { type: "string", default: process.env.NYLORUN_SANDBOX_HOST_ADDRESS },
  },
});
const started = Date.now();
const step = (message) => console.log(`\n[t3-exit ${Math.round((Date.now() - started) / 1000)}s] ${message}`);

/** Agent manifest `evolve` with `instructions` on a pod with `runtime`. */
const manifest = (instructions, runtime = {}) => ({
  manifestSchemaVersion: 8,
  name: "evolve",
  harness: { instructions: [instructions] },
  runtime: { kind: "pod", secrets: { MODE: { type: "environment_variable" } }, ...runtime },
});

const images = await ensureImages({ only: ["runtime", "sandboxes"] });
let failed = false;
const check = (ok, detail) => {
  console.log(`${ok ? "pass" : "fail"} ${detail}`);
  if (!ok) failed = true;
};
await withStack({ name: "nylorun-t3-exit", images }, async (stack) => {
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
  const agent = () => ok("GET", "/v1/agents/evolve");
  const save = async (body) => (await ok("PUT", "/v1/agent-manifests/evolve", { requestId: randomUUID(), ...body })).manifest.version;
  let turns = 0;
  /** Runs `command` in a turn of session `evolve-s`: its end, and what bash printed. */
  const turn = async (command) => {
    const requestId = randomUUID();
    await ok("POST", "/v1/sessions/evolve-s/commands", {
      type: "message",
      requestId,
      idempotencyKey: requestId,
      content: `fixture:tool bash ${JSON.stringify({ command })}`,
    });
    turns += 1;
    const ends = await eventually(
      async () => {
        const { items } = await ok("GET", "/v1/sessions/evolve-s/items");
        const ended = items.filter((item) => /^turn\.(completed|failed|cancelled)$/.test(item.type));
        return ended.length >= turns && { ended, items };
      },
      { timeout: 600_000, interval: 1000, message: `turn ${turns} of evolve-s to end` },
    );
    const end = ends.ended.at(-1);
    const ran = ends.items.filter((item) => item.type === "tool.completed" && item.payload?.toolName === "bash").at(-1);
    return { end, stdout: String(ran?.payload?.output?.stdout ?? "").trim() };
  };
  /** Waits until the pod has stopped (a restart of an outdated pod stops it). */
  const stopped = () =>
    eventually(async () => (await agent()).compute?.pod?.observed === "suspended", {
      timeout: 300_000,
      interval: 1000,
      message: "the pod to stop",
    });

  step(`nylorun local sandbox enable --context ${options.context}`);
  const enable = ["local", "sandbox", "enable", "--context", options.context, "--no-pull"];
  if (options["host-address"]) enable.push("--host-address", options["host-address"]);
  await stack.nylorun(enable, { timeout: 900_000 });
  tenant = await stack.tenant();
  await manage("PUT", "/v1/tenant/sandbox", { limits: { idle: "10m" }, lifecycle: { stopGrace: "10s" } });
  await manage("PUT", "/v1/tenant/config/seed", { fixtureModel: true });

  step("the pod Agent evolve tracks its manifest; a turn writes a file on its disk");
  check((await save(manifest("Answer as version one."))) === 1, "saved evolve version 1");
  const made = await ok("PUT", "/v1/agents/evolve", { requestId: randomUUID(), manifest: "evolve" });
  check(made.tracking === "tracking" && made.resolvedVersion === 1, `the Agent tracks evolve, at version ${made.resolvedVersion}`);
  await ok("PUT", "/v1/agents/evolve/secrets/MODE", { requestId: randomUUID(), value: "steady" });
  await ok("PUT", "/v1/sessions/evolve-s", { requestId: randomUUID(), agent: "evolve", ownerUserId: "t3-exit" });
  const first = await turn('echo "kept:$MODE" > /workspace/marker.txt; cat /workspace/marker.txt');
  check(first.end?.type === "turn.completed" && first.stdout === "kept:steady", `turn 1 wrote the file: ${JSON.stringify(first.stdout)}`);
  check(first.end?.payload?.manifest?.version === 1, `turn 1 ran version ${first.end?.payload?.manifest?.version}`);
  const volume = (await agent()).compute?.pod?.volumeGeneration;

  step("an instruction change applies at once: the next turn runs version 2");
  check((await save(manifest("Answer as version two."))) === 2, "saved evolve version 2");
  const moved = await agent();
  check(moved.resolvedVersion === 2 && moved.targetVersion === null, `the Agent runs version ${moved.resolvedVersion} at once`);
  const second = await turn("cat /workspace/marker.txt");
  check(second.end?.payload?.manifest?.version === 2 && second.stdout === "kept:steady", `turn 2 ran version ${second.end?.payload?.manifest?.version}: ${JSON.stringify(second.stdout)}`);

  step("a runtime change waits for the pod's next start, then runs on the same volume");
  check((await save(manifest("Answer as version three.", { resources: { cpus: 1, memory: "1Gi" } }))) === 3, "saved evolve version 3");
  const outdated = await agent();
  check(
    outdated.resolvedVersion === 2 && outdated.targetVersion === 3 && outdated.waitingFor === "start",
    `the Agent waits for its pod's next start: runs ${outdated.resolvedVersion}, moves to ${outdated.targetVersion}`,
  );
  await ok("POST", "/v1/agents/evolve/restart", { requestId: randomUUID() });
  await stopped();
  const third = await turn("cat /workspace/marker.txt");
  const applied = await agent();
  check(third.end?.payload?.manifest?.version === 3 && third.stdout === "kept:steady", `turn 3 ran version ${third.end?.payload?.manifest?.version} with the file: ${JSON.stringify(third.stdout)}`);
  check(
    applied.resolvedVersion === 3 && applied.runtime?.resources?.cpus === 1 && applied.compute?.pod?.volumeGeneration === volume && applied.startCheck === null,
    `a new pod on the same volume (generation ${applied.compute?.pod?.volumeGeneration}), its start checked`,
  );

  step("a version whose setup fails goes back to the version it ran");
  check(
    (await save(manifest("Answer as version four.", { resources: { cpus: 1, memory: "1Gi" }, setup: [{ command: "echo broken; exit 7" }] }))) === 4,
    "saved evolve version 4",
  );
  await ok("POST", "/v1/agents/evolve/restart", { requestId: randomUUID() });
  await stopped();
  const fourth = await turn("cat /workspace/marker.txt");
  const back = await agent();
  check(fourth.end?.payload?.manifest?.version === 3 && fourth.stdout === "kept:steady", `turn 4 ran version ${fourth.end?.payload?.manifest?.version} with the file: ${JSON.stringify(fourth.stdout)}`);
  check(
    back.resolvedVersion === 3 && back.failedVersion === 4 && back.targetVersion === null && back.compute?.pod?.volumeGeneration === volume,
    `the Agent runs ${back.resolvedVersion} again, version ${back.failedVersion} failed, on the same volume`,
  );
  const { events } = await ok("GET", "/v1/agents/evolve/events?types=agent.start_failed");
  check(events.at(-1)?.payload?.to === 4 && events.at(-1)?.payload?.reverted === true, `agent.start_failed names version 4: ${events.at(-1)?.payload?.reason}`);

  step("the Agent kept its id, vault and session");
  const secrets = (await ok("GET", "/v1/agents/evolve/secrets")).secrets.map((secret) => secret.name);
  const session = await ok("GET", "/v1/sessions/evolve-s");
  check(secrets.includes("MODE") && session.agentId === "evolve" && back.sessions.length === 1, `vault ${secrets.join(",")}, session on ${session.agentId}`);

  await api("DELETE", "/v1/agents/evolve");
  if (failed) await stack.logs().catch(() => {});
});
console.log(failed ? "\nt3-exit: FAILED" : "\nt3-exit: passed");
process.exitCode = failed ? 1 : 0;
