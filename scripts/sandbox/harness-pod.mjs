#!/usr/bin/env node
// A custom harness as a pod's image (track R4, R4.4) on a real cluster:
//
//   node scripts/sandbox/harness-pod.mjs --context docker-desktop
//   node scripts/sandbox/harness-pod.mjs --context kind-nylorun --host-address 172.17.0.1
//
// Builds the example harness's image (`examples/harness-minimal`), starts a Tenant
// (`nylorun start --no-studio`) and turns on its fixture model and sandbox pods. A session on a
// pod Agent, made from an agent manifest whose `harness.id` is `minimal` and whose runtime is a
// pod with the example as its `image`, runs `bash`: the pod runs the image's own entrypoint, joins
// with its join token, takes the turn and runs the command in /workspace. Our harness stays in
// its container beside it and serves a session on a kind none Agent at the same time.
//
// Needs what `npm run test:sandboxes` needs (kubectl, a context with agent-sandbox, the workspace
// builds, images the cluster's node can use: CI loads them with `kind load docker-image`).
// NYLORUN_EXAMPLE_HARNESS_IMAGE names a prebuilt example image.
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { root, run } from "../lib/repo.mjs";
import { ensureImages, imageId, runtimeHeaders, withStack } from "../lib/stack.mjs";

const { values: options } = parseArgs({
  options: {
    context: { type: "string", default: process.env.NYLORUN_SANDBOX_CONTEXT ?? "kind-nylorun" },
    "host-address": { type: "string", default: process.env.NYLORUN_SANDBOX_HOST_ADDRESS },
  },
});
const started = Date.now();
const step = (message) => console.log(`\n[harness-pod ${Math.round((Date.now() - started) / 1000)}s] ${message}`);

const exampleImage = process.env.NYLORUN_EXAMPLE_HARNESS_IMAGE?.trim() || "nylorun-example-harness-minimal:local";
if (!process.env.NYLORUN_EXAMPLE_HARNESS_IMAGE || !(await imageId(exampleImage))) {
  step(`build ${exampleImage}`);
  await run("docker", ["build", "--quiet", "--file", "examples/harness-minimal/Dockerfile", "--tag", exampleImage, "."], {
    cwd: root,
    capture: true,
    timeout: 1_200_000,
  });
}

const images = await ensureImages({ only: ["runtime", "sandboxes"] });
let failed = false;
await withStack({ name: "nylorun-harness-pod", images, startArgs: ["--no-studio"] }, async (stack) => {
  let tenant = await stack.tenant();
  const manage = (method, path, body) =>
    fetch(`${stack.runtimeUrl}${path}`, {
      method,
      headers: runtimeHeaders(tenant.managementKey, { "content-type": "application/json" }),
      body: JSON.stringify({ requestId: randomUUID(), ...body }),
    });

  step(`nylorun sandbox enable --context ${options.context}`);
  const enable = ["local", "sandbox", "enable", "--context", options.context, "--no-pull"];
  if (options["host-address"]) enable.push("--host-address", options["host-address"]);
  await stack.nylorun(enable, { timeout: 900_000 });
  tenant = await stack.tenant();
  const limits = await manage("PUT", "/v1/tenant/sandbox", { limits: { idle: "10m" }, lifecycle: { stopGrace: "10s" } });
  if (!limits.ok) throw new Error(`PUT /v1/tenant/sandbox: ${limits.status} ${await limits.text()}`);

  const api = async (method, path, body) => {
    const response = await fetch(`${stack.runtimeUrl}${path}`, {
      method,
      headers: runtimeHeaders(tenant.key, { "content-type": "application/json" }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  const seeded = await manage("PUT", "/v1/tenant/config/seed", { fixtureModel: true });
  if (!seeded.ok) throw new Error(`PUT /v1/tenant/config/seed: ${seeded.status} ${await seeded.text()}`);
  const prefix = `hp-${randomUUID().slice(0, 8)}`;
  // Two agent manifests of one harness section: one runs in our harness with no runtime (kind
  // none), the other names the harness `minimal`, which runs from its pod's image.
  const harness = { instructions: ["Answer briefly."] };
  await api("PUT", `/v1/agent-manifests/${prefix}-ours`, {
    requestId: randomUUID(),
    manifestSchemaVersion: 8,
    name: `${prefix}-ours`,
    harness,
  });
  await api("PUT", `/v1/agent-manifests/${prefix}-pod`, {
    requestId: randomUUID(),
    manifestSchemaVersion: 8,
    name: `${prefix}-pod`,
    harness: { id: "minimal", ...harness },
    runtime: { kind: "pod", image: exampleImage },
  });
  for (const name of [`${prefix}-ours`, `${prefix}-pod`])
    await api("PUT", `/v1/agents/${name}`, { requestId: randomUUID(), manifest: name });

  /** Opens `session` on Agent `agent`, sends `content` and waits for the turn's end: its items. */
  const turn = async (session, agent, content) => {
    await api("PUT", `/v1/sessions/${session}`, {
      requestId: randomUUID(),
      agent,
      ownerUserId: "harness-pod",
    });
    const requestId = randomUUID();
    await api("POST", `/v1/sessions/${session}/commands`, { type: "message", requestId, idempotencyKey: requestId, content });
    const deadline = Date.now() + 600_000;
    for (;;) {
      const { items } = await api("GET", `/v1/sessions/${session}/items`);
      if (items.some((item) => /^turn\.(completed|failed|cancelled)$/.test(item.type))) return items;
      if (Date.now() > deadline) throw new Error(`the turn of ${session} did not end within 600 s`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
  const check = (ok, detail) => {
    console.log(`${ok ? "pass" : "fail"} ${detail}`);
    if (!ok) failed = true;
  };

  step(`a session on the pod Agent, harness minimal as ${exampleImage}, beside ours`);
  const command = `fixture:tool bash ${JSON.stringify({ command: "echo nylorun-pod:$(pwd)" })}`;
  const [pod, ours] = await Promise.all([turn(`${prefix}-pod`, `${prefix}-pod`, command), turn(`${prefix}-ours`, `${prefix}-ours`, "fixture:text")]);
  const podEnd = pod.find((item) => /^turn\.(completed|failed|cancelled)$/.test(item.type));
  check(
    podEnd?.type === "turn.completed" && podEnd.source?.kind === "harness" && podEnd.source.id === "minimal",
    `the pod's harness took the run and settled it: ${podEnd?.type} from ${podEnd?.source?.kind} ${podEnd?.source?.id ?? ""}`
  );
  const ran = pod.find((item) => item.type === "tool.completed" && item.payload?.toolName === "bash");
  check(
    String(ran?.payload?.output?.stdout ?? "").includes("nylorun-pod:/workspace"),
    `bash ran in /workspace: ${JSON.stringify(ran?.payload?.output?.stdout ?? null)}`
  );
  const oursEnd = ours.find((item) => item.type === "turn.completed");
  check(oursEnd?.source?.kind === "harness" && oursEnd.source.id === "nylorun", "our harness served the session on a kind none Agent at the same time");
  await api("DELETE", `/v1/agents/${prefix}-pod`).catch(() => {});
  if (failed) await stack.logs().catch(() => {});
});
console.log(failed ? "\nharness-pod: FAILED" : "\nharness-pod: passed");
process.exitCode = failed ? 1 : 0;
