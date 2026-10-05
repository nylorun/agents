#!/usr/bin/env node
// The harness red-team smoke (F6.2 W8) on a real `nylorun start` Tenant:
//
//   node scripts/smoke-redteam.mjs      # npm run test:redteam
//
// Builds nylorun-runtime:local and nylorun-studio:local from this checkout unless
// NYLORUN_RUNTIME_IMAGE / NYLORUN_STUDIO_IMAGE name prebuilt images (CI). Needs the CLI and
// @nylorun/admin built.
//
// 1. A stub model on the Tenant's network; session A (an agent with a sandbox) runs bash, and
//    session B (another agent) answers once.
// 2. The harness service is stopped, and runtime/test/redteam/harness.mjs runs in a container
//    of the harness service's own definition (image, user, environment, mounts, network):
//    `docker compose run --rm --no-deps -T --entrypoint node harness --input-type=module -`.
//    Every check must be refused: the stores and Restate, other secrets and keys, mounts
//    outside /harness, the harness token anywhere but the Harness API, runs and sessions this
//    connection does not hold, a workspace record outside the Tenant's prefix, A's run token
//    for B, keys or deliveries, and A's token once A is cancelled.
// 3. The suite's `lease` takes A's next turn (sent when it says it is leasing); A is cancelled
//    once it says it holds the run.
// 4. The harness service starts again, and A runs another turn.
//
// The Tenant is always reset at the end.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { root, run } from "./lib/repo.mjs";
import { ensureImages, eventually, runtimeGet, runtimeHeaders, withStack } from "./lib/stack.mjs";
import { startStubModel } from "./lib/stub-model.mjs";

const SUITE = join(root, "runtime", "test", "redteam", "harness.mjs");

async function request(runtimeUrl, tenant, path, { method = "GET", body } = {}) {
  // `/v1/tenant/*` is the Management API: it takes the management key.
  const key = path.startsWith("/v1/tenant/") ? tenant.managementKey : tenant.key;
  const response = await fetch(`${runtimeUrl}${path}`, {
    method,
    headers: runtimeHeaders(key, body ? { "content-type": "application/json" } : {}),
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

try {
  const started = Date.now();
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
  const images = await ensureImages();
  await withStack({ name: "nylorun-smoke-redteam", images }, async (stack) => {
    const { runtimeUrl, home } = stack;
    const tenant = await stack.tenant();
    const stub = await startStubModel(stack, images.runtime);
    try {
      await request(runtimeUrl, tenant, "/v1/tenant/model", {
        method: "PUT",
        body: { requestId: randomUUID(), idempotencyKey: randomUUID(), ...stub.model },
      });
      for (const id of ["agent-a", "agent-b"])
        await request(runtimeUrl, tenant, `/v1/agents/${id}`, {
          method: "PUT",
          body: {
            requestId: randomUUID(),
            implementationVersion: "dev",
            manifest: { id, name: id, manifestSchemaVersion: 5, capabilities: [] },
          },
        });
      const A = "redteam-a";
      const B = "redteam-b";
      await request(runtimeUrl, tenant, `/v1/sessions/${A}`, {
        method: "PUT",
        body: { requestId: randomUUID(), agentId: "agent-a", ownerUserId: "redteam", sandbox: {} },
      });
      await request(runtimeUrl, tenant, `/v1/sessions/${B}`, {
        method: "PUT",
        body: { requestId: randomUUID(), agentId: "agent-b", ownerUserId: "redteam" },
      });
      let n = 0;
      const message = (session, content) =>
        request(runtimeUrl, tenant, `/v1/sessions/${session}/commands`, {
          method: "POST",
          body: { type: "message", requestId: `m${++n}`, idempotencyKey: `m${n}`, content },
        });
      const settled = (session) =>
        eventually(
          async () => {
            const view = await runtimeGet(runtimeUrl, tenant.key, `/v1/sessions/${session}`);
            return ["completed", "failed", "cancelled", "uncertain"].includes(view.status) ? view : undefined;
          },
          { timeout: 120_000, interval: 500, message: `${session} to settle` },
        );
      await message(A, 'call bash {"command":"echo a > a.txt && cat a.txt"}');
      assert.equal((await settled(A)).status, "completed");
      await message(B, "hello");
      assert.equal((await settled(B)).status, "completed");
      console.log(`[redteam] sessions A (bash) and B ran in the harness (${elapsed()})`);

      // The stack's other secrets, by hash: none may be readable in the harness container.
      const dotenv = await readFile(join(home, "docker", ".env"), "utf8");
      const valueOf = (key) => new RegExp(`^${key}=(.+)$`, "m").exec(dotenv)?.[1];
      const secrets = [
        valueOf("NYLORUN_GATES_TOKEN"),
        valueOf("NYLORUN_OBJECT_STORE_SECRET_KEY"),
        valueOf("NYLORUN_POSTGRES_PASSWORD"),
        valueOf("NYLORUN_SANDBOXES_TOKEN"),
        JSON.parse(await readFile(join(home, "host-credentials.json"), "utf8")).adminKey,
        (await readFile(join(home, "keys", "vault-kek"), "utf8")).trim(),
      ].filter(Boolean);
      assert.ok(secrets.length >= 5, "the smoke found the stack's secrets");
      const postgresIp = (
        await run("docker", ["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", `${stack.project}-postgres`], {
          capture: true,
        })
      ).trim().split(/\s+/)[0];

      await stack.compose(["stop", "harness"]);
      const suite = await readFile(SUITE, "utf8");
      const results = [];
      let summary;
      const code = await new Promise((resolve, reject) => {
        const child = spawn(
          "docker",
          [
            "compose", "--project-name", stack.project,
            "--file", join(home, "docker", "compose.yaml"),
            "--env-file", join(home, "docker", ".env"),
            "run", "--rm", "--no-deps", "-T",
            "-e", `SMOKE_SESSION_A=${A}`,
            "-e", `SMOKE_SESSION_B=${B}`,
            "-e", `SMOKE_POSTGRES_IP=${postgresIp}`,
            "-e", `SMOKE_HOST_PORTS=${valueOf("NYLORUN_RESTATE_PORT")}`,
            "-e", `SMOKE_PROTOCOL=${PROTOCOL_VERSION}`,
            "-e", `SMOKE_SECRET_HASHES=${secrets.map(sha256).join(",")}`,
            "-e", `SMOKE_PLUGINS=${join(home, "plugins")}`,
            "--entrypoint", "node",
            "harness", "--input-type=module", "-",
          ],
          { env: stack.env, stdio: ["pipe", "pipe", "inherit"] },
        );
        child.stdin.end(suite);
        const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
        createInterface({ input: child.stdout }).on("line", (line) => {
          let entry;
          try {
            entry = JSON.parse(line);
          } catch {
            console.log(`[suite] ${line}`);
            return;
          }
          if (entry.check !== undefined) {
            results.push(entry);
            console.log(`[suite] ${entry.ok ? "refused" : "FAILED "}  ${entry.check}${entry.ok ? "" : `: ${entry.detail}`}`);
          } else if (entry.step === "leasing") {
            // The suite's lease is the only one: A's next turn goes to it.
            message(A, "hello again").catch(reject);
          } else if (entry.step === "held") {
            console.log(`[redteam] the suite holds A's run ${entry.runId}; cancelling A`);
            request(runtimeUrl, tenant, `/v1/sessions/${A}/commands`, {
              method: "POST",
              body: { type: "cancel", requestId: "cancel-a", idempotencyKey: "cancel-a" },
            }).catch(reject);
          } else if (entry.done) summary = entry;
        });
        child.once("error", reject);
        child.once("close", (exit) => {
          clearTimeout(timer);
          resolve(exit);
        });
      });
      const failed = results.filter((entry) => !entry.ok);
      assert.deepEqual(failed, [], `every check is refused: ${JSON.stringify(failed, null, 2)}`);
      assert.ok(summary, "the suite ran to the end");
      assert.equal(code, 0, "the suite exits 0");
      assert.ok(results.length >= 40, `the suite ran every check (${results.length})`);
      console.log(`[redteam] ${results.length} checks refused (${elapsed()})`);

      // The harness comes back, and A runs again.
      await stack.compose(["start", "harness"]);
      await eventually(
        async () => (await stack.compose(["ps", "--format", "{{.Health}}", "harness"])).trim() === "healthy",
        { timeout: 120_000, interval: 1000, message: "the harness to reconnect" },
      );
      assert.equal((await settled(A)).status, "cancelled");
      await message(A, 'call bash {"command":"cat a.txt"}');
      assert.equal((await settled(A)).status, "completed");
      console.log(`[redteam] the harness reconnected and A ran again (${elapsed()})`);
    } finally {
      await stub.remove();
    }
  });
  console.log("Red-team smoke passed.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
