#!/usr/bin/env node
// A custom harness as a pod's image (track R4, R4.4, conformance HC15) on a real cluster:
//
//   node scripts/sandbox/harness-pod.mjs --context docker-desktop
//   node scripts/sandbox/harness-pod.mjs --context kind-nylorun --host-address 172.17.0.1
//
// Builds the example harness's image (`examples/harness-minimal`), starts a Tenant
// (`nylorun start --no-studio`), turns on its fixture model and sandbox pods, then runs the
// harness conformance suite with the pod profile: every session runs on a pod Environment whose
// `image` is the example and whose `harness` is `minimal`, so the pod runs the image's own
// entrypoint, joins with its join token, and takes the turns. Our harness stays in its container
// beside it (HC18).
//
// Needs what `npm run test:sandboxes` needs (kubectl, a context with agent-sandbox, the workspace
// builds, images the cluster's node can use: CI loads them with `kind load docker-image`).
// NYLORUN_EXAMPLE_HARNESS_IMAGE names a prebuilt example image.
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
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
const { runConformance } = await import(join(root, "conformance", "dist", "index.js"));

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
  const enable = ["sandbox", "enable", "--context", options.context, "--no-pull"];
  if (options["host-address"]) enable.push("--host-address", options["host-address"]);
  await stack.nylorun(enable, { timeout: 900_000 });
  tenant = await stack.tenant();
  const limits = await manage("PUT", "/v1/tenant/sandbox", { limits: { idle: "10m" }, lifecycle: { stopGrace: "10s" } });
  if (!limits.ok) throw new Error(`PUT /v1/tenant/sandbox: ${limits.status} ${await limits.text()}`);

  step(`conformance, pod profile, harness minimal as ${exampleImage}`);
  const report = await runConformance({
    runtime: stack.runtimeUrl,
    key: tenant.key,
    manageKey: tenant.managementKey,
    harness: "minimal",
    profile: "pod",
    image: exampleImage,
    turnTimeoutMs: 600_000,
  });
  for (const result of report.results)
    console.log(`${result.status.padEnd(7)} ${result.id} ${result.section ?? ""} ${result.detail}`);
  failed = report.results.some((result) => result.status === "fail");
  if (failed) await stack.logs().catch(() => {});
});
console.log(failed ? "\nharness-pod: FAILED" : "\nharness-pod: every check that applies passed");
process.exitCode = failed ? 1 : 0;
