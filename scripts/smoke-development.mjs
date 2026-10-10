/**
 * `npm run dev` smoke: the contributor loop on a local Tenant, after
 * `npm run setup`:
 *
 *   npm run test:dev
 *
 * Runs scripts/lib/development.mjs against a temporary NYLORUN_HOME and a
 * unique Tenant (NYLORUN_TENANT), with the images from scripts/lib/stack.mjs.
 * Checks that the Tenant starts on those images, `nylorun start` links the
 * examples Project to it, the examples' `npm run dev` saves their agents, the
 * Runtime (in Docker) calls the examples' tools service on this machine (a
 * fixture-model turn whose `lookup_order` HTTP tool answers), the printed
 * Studio login works, and that an edit to a host package rebuilds it and
 * restarts the examples runner, which saves the agents again. The Tenant is
 * reset afterwards.
 *
 * The examples run from a temporary copy of the files git tracks under
 * examples/, with examples/node_modules linked in, so the developer's local,
 * git-ignored state there (.env files, the .nylorun/ link, .data/) neither
 * affects the smoke nor is read or changed by it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@nylorun/agents";
import { develop, workspaceCommands } from "./lib/development.mjs";
import { root, run } from "./lib/repo.mjs";
import { ensureImages, eventually, runtimeGet, runtimeHeaders, studioSession, withStack } from "./lib/stack.mjs";

const scratch = await mkdtemp(join(tmpdir(), "nylorun-dev-smoke-"));
const examples = join(scratch, "examples");
const link = join(examples, ".nylorun");
const edited = join(root, "cli/nylorun/src/baseline.ts");
const original = await readFile(edited, "utf8");
const lines = [];
const log = (line) => {
  console.log(line);
  lines.push(line.replace(/^\[[^\]]+\] /, ""));
};

/** A clean-checkout copy of examples/: tracked files only, plus its installed node_modules. */
async function copyExamples() {
  const modules = join(root, "examples", "node_modules");
  if (!existsSync(modules))
    throw new Error("examples/node_modules is missing; run npm run setup first.");
  const tracked = (await run("git", ["ls-files", "-z", "--", "examples"], { capture: true }))
    .split("\0")
    .filter(Boolean);
  for (const path of tracked) {
    const target = join(scratch, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, path), target);
  }
  await symlink(modules, join(examples, "node_modules"), "dir");
}

try {
  await copyExamples();
  const images = await ensureImages();
  await withStack({ name: "nylorun-dev-smoke", images, start: false }, async (stack) => {
    const controller = new AbortController();
    const app = await develop(
      { studio: true, open: false, watch: true },
      {
        log,
        signal: controller.signal,
        built: true,
        commands: workspaceCommands({ env: stack.env, project: examples }),
      },
    );
    // Fail fast when the loop ends on its own (e.g. the runner exits).
    const ended = app.done.then((code) => {
      throw new Error(`npm run dev ended early (${code})`);
    });
    ended.catch(() => {});
    const until = (check, options) => Promise.race([eventually(check, options), ended]);
    try {
      // `nylorun start` in examples/ linked it before the runner started.
      await until(() => existsSync(join(link, "link.json")), {
        timeout: 300_000,
        message: "the examples Project link",
      });
      const status = JSON.parse((await stack.nylorun(["status", "--json"], { echo: false })).stdout);
      assert.equal(status.runtime.healthy, true);
      const runtime = status.services.find((s) => s.service === "runtime");
      assert.equal(runtime?.state, "running");
      const containerImage = (
        await stack.compose(["ps", "--format", "{{.Image}}", "runtime"])
      ).trim();
      assert.equal(containerImage, images.runtime, "the Tenant runs the images from this checkout");
      const gatewayImage = (
        await stack.compose(["ps", "--format", "{{.Image}}", "gateway"])
      ).trim();
      assert.equal(gatewayImage, images.runtime, "the gateway runs the same Runtime image");

      const { format, tenantId, hostUrl, tenant: linked } = JSON.parse(await readFile(join(link, "link.json"), "utf8"));
      const { applicationKey } = JSON.parse(await readFile(join(link, "credentials.json"), "utf8"));
      assert.equal(hostUrl, status.runtime.url);
      assert.equal(format, 3, "link format 3");
      assert.equal(linked, stack.env.NYLORUN_TENANT, "examples/ is linked to the test Tenant");
      assert.equal(tenantId, (await stack.tenant()).id, "the link names the Tenant's id");
      // The examples' `npm run dev` saves the registry's agents.
      const saves = () => lines.filter((l) => l.includes("Saved agent assistant")).length;
      const savedIds = async () =>
        (await runtimeGet(hostUrl, applicationKey, "/v1/agents")).agents.map((a) => a.manifest.id);
      await until(
        async () => {
          const ids = await savedIds();
          return ["assistant", "analyst"].every((id) => ids.includes(id));
        },
        { timeout: 300_000, message: "the examples' agents to be saved" },
      );

      // The Runtime (in Docker) calls the examples' tools service on this machine: with the
      // fixture model, the assistant's turn calls lookup_order, an HTTP tool, and reports it.
      const { managementKey } = await stack.tenant();
      const seeded = await fetch(`${hostUrl}/v1/tenant/config/seed`, {
        method: "PUT",
        headers: runtimeHeaders(managementKey, { "content-type": "application/json" }),
        body: JSON.stringify({ requestId: randomUUID(), fixtureModel: true }),
        signal: AbortSignal.timeout(15_000),
      });
      assert.ok(seeded.ok, `seeding the fixture model: ${seeded.status} ${await seeded.text()}`);
      const client = createClient({ url: hostUrl, key: applicationKey });
      const session = await client.createSession({ agentId: "assistant", ownerUserId: "dev-smoke" });
      await session.input("Where is demo-123?", { idempotencyKey: randomUUID() });
      await until(
        async () => {
          const { items } = await runtimeGet(hostUrl, applicationKey, `/v1/sessions/${session.id}/items`);
          const text = JSON.stringify(items ?? []);
          return text.includes("Order lookup complete") && text.includes("shipped");
        },
        { timeout: 120_000, message: "the assistant's lookup_order call to reach the tools service" },
      );

      // `nylorun studio`'s login (after `nylorun start`'s own) lands on the linked Tenant.
      const loginUrl = lines.map((l) => /^Studio\s+(http\S+)/.exec(l)?.[1]).findLast(Boolean);
      assert.ok(loginUrl, "nylorun studio prints a Studio login URL");
      const studio = await studioSession(loginUrl);
      assert.equal(studio.location, `/tenants/${tenantId}`);
      const hello = await (await studio.get("/_studio/hello")).json();
      assert.equal(hello.tenant?.id, tenantId);

      // An edit to a host package rebuilds it and restarts the runner.
      const restarts = () => lines.filter((l) => l.includes("Restarting the examples runner")).length;
      await writeFile(edited, `${original}\n// dev smoke ${Date.now()}\n`);
      const savedBefore = saves();
      await until(() => restarts() === 1, { timeout: 180_000, message: "a runner restart" });
      await until(() => saves() > savedBefore, { timeout: 120_000, message: "the restarted runner to save the agents" });
    } finally {
      await writeFile(edited, original);
      controller.abort();
      await app.close();
    }
  });
  console.log(
    "Development smoke passed: npm run dev on a local Tenant (local images), examples linked to it, agents saved, an HTTP tool call to the examples' tools service, Studio login, package rebuild and runner restart.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if ((await readFile(edited, "utf8")) !== original) await writeFile(edited, original);
  await rm(scratch, { recursive: true, force: true });
}
