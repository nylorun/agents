#!/usr/bin/env node
// `nylorun start --sandbox openshell` smoke under a temporary Host root:
//
//   node scripts/smoke-openshell.mjs
//
// Builds the local images like `npm run test:stack` (the OpenShell images are
// pulled on first use). Starts the stack with the OpenShell gateway and
// telemetry off, checks six containers at rest, opens a session with a sandbox
// through a Tenant's application key, runs `bash` in it, checks the eight
// containers that follow (the sandbox's supervisor and workload), runs
// `npm --version` in a second session whose sandbox names an image (the Runtime
// image under test), and always ends with `nylorun reset --yes`, which also
// removes the sandboxes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Agent } from "@nylorun/core/define";
import { ensureImages, tenantHeaders, withStack } from "./lib/stack.mjs";

const run = promisify(execFile);

/** Running containers: the stack's (by Compose project) and OpenShell's sandboxes. */
async function containers(project) {
  const list = async (filter) =>
    (await run("docker", ["ps", "--filter", filter, "--format", "{{.Names}}"])).stdout.split("\n").filter(Boolean);
  return {
    stack: await list(`label=com.docker.compose.project=${project}`),
    sandboxes: await list(`label=openshell.ai/sandbox-namespace=${project}`),
  };
}

try {
  const images = await ensureImages();
  await withStack(
    { name: "nylorun-smoke-openshell", images, startArgs: ["--sandbox", "openshell", "--openshell-telemetry", "off"] },
    async (stack) => {
      const { runtimeUrl } = stack;
      const status = JSON.parse((await stack.nylorun(["status", "--json"])).stdout);
      const gateway = status.services.find((s) => s.service === "openshell-gateway");
      assert.equal(gateway?.state, "running", "the OpenShell gateway runs");

      const before = await containers(stack.project);
      assert.equal(before.stack.length, 6, `six containers at rest: ${before.stack.join(", ")}`);
      assert.equal(before.sandboxes.length, 0, "no sandbox before a session asks for one");

      const admin = await stack.admin();
      const { tenant, applicationKey } = await admin.createTenant({ name: "openshell-smoke" });
      const headers = tenantHeaders(tenant.id, applicationKey, { "content-type": "application/json" });
      const call = async (method, path, body) => {
        const response = await fetch(`${runtimeUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        });
        const text = await response.text();
        assert.ok(response.ok, `${method} ${path}: HTTP ${response.status} ${text.slice(0, 500)}`);
        return JSON.parse(text);
      };

      const report = await call("GET", "/v1/tenant/sandbox");
      assert.equal(report.backend, "openshell", JSON.stringify(report));

      await call("PUT", "/v1/agents/bot", {
        requestId: "put-bot",
        manifest: Agent({ id: "bot", name: "Bot" }).instructions("Use the sandbox.").build().manifest,
        implementationVersion: "smoke",
      });
      const session = await call("PUT", "/v1/sessions/s1", {
        requestId: "open-s1",
        agentId: "bot",
        ownerUserId: "ada",
        sandbox: { resources: { cpus: 1 } },
      });
      assert.equal(session.sandboxSource, "inline", JSON.stringify(session));

      const bash = await call("POST", "/v1/sessions/s1/sandbox/bash", {
        command: "pwd; (exec 3<>/dev/tcp/example.com/443) 2>/dev/null && echo reached || echo blocked",
      });
      const output = JSON.stringify(bash);
      assert.match(output, /\/sandbox/, output);
      assert.match(output, /blocked/, output);

      const after = await containers(stack.project);
      assert.equal(after.stack.length, 6, `still six stack containers: ${after.stack.join(", ")}`);
      assert.equal(after.sandboxes.length, 2, `a sandbox is two containers: ${after.sandboxes.join(", ")}`);
      console.log(`Containers: ${after.stack.length} + ${after.sandboxes.length} (sandbox)`);

      // A session may name its image. The Runtime image under test has Node and the
      // POSIX tools, and is already local, so nothing is pulled.
      await call("PUT", "/v1/sessions/s2", {
        requestId: "open-s2",
        agentId: "bot",
        ownerUserId: "ada",
        sandbox: { image: images.runtime },
      });
      const npm = JSON.stringify(
        await call("POST", "/v1/sessions/s2/sandbox/bash", { command: "npm --version" }),
      );
      assert.match(npm, /\d+\.\d+\.\d+/, npm);

      await stack.nylorun(["reset", "--yes"]);
      const reset = await containers(stack.project);
      assert.deepEqual(reset, { stack: [], sandboxes: [] }, "reset removes the stack and its sandboxes");
    },
  );
  console.log("OpenShell stack smoke passed.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
