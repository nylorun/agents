/**
 * `npm run dev` smoke: the contributor loop on the Docker stack, after
 * `npm run setup`:
 *
 *   npm run test:dev
 *
 * Runs scripts/lib/development.mjs against a temporary NYLORUN_HOME and a
 * unique stack (NYLORUN_STACK), with the images from scripts/lib/stack.mjs.
 * Checks that the stack starts on those images, `nylorun start` links the
 * examples Project to the stack's Tenant, its Action endpoints answer, the printed Studio login works, and that an edit to
 * a host package rebuilds it and restarts the examples runner. The stack is
 * reset afterwards.
 *
 * The examples run from a temporary copy of the files git tracks under
 * examples/, with examples/node_modules linked in, so the developer's local,
 * git-ignored state there (.env files, the .nylorun/ link, .data/) neither
 * affects the smoke nor is read or changed by it.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { develop, workspaceCommands } from "./lib/development.mjs";
import { root, run } from "./lib/repo.mjs";
import { ensureImages, eventually, runtimeHeaders, studioSession, withStack } from "./lib/stack.mjs";

const scratch = await mkdtemp(join(tmpdir(), "nylorun-dev-smoke-"));
const examples = join(scratch, "examples");
const link = join(examples, ".nylorun");
const edited = join(root, "cli/src/baseline.ts");
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
      assert.equal(containerImage, images.runtime, "the stack runs the images from this checkout");
      const gatewayImage = (
        await stack.compose(["ps", "--format", "{{.Image}}", "gateway"])
      ).trim();
      assert.equal(gatewayImage, images.runtime, "the gateway runs the same Runtime image");

      const { tenantId, hostUrl, stack: linked } = JSON.parse(await readFile(join(link, "link.json"), "utf8"));
      const { applicationKey } = JSON.parse(await readFile(join(link, "credentials.json"), "utf8"));
      assert.equal(hostUrl, status.runtime.url);
      assert.equal(linked, stack.env.NYLORUN_STACK, "examples/ is linked to the test stack");
      assert.equal(tenantId, (await stack.tenant()).id, "the link names the stack's Tenant");
      // The examples serve their agents as Action endpoints; the Runtime (in Docker) reaches
      // them when a ping through it answers 200.
      const connected = async () => {
        for (const id of ["assistant", "analyst"]) {
          const response = await fetch(`${hostUrl}/v1/endpoints/${id}/ping`, {
            method: "POST",
            headers: runtimeHeaders(applicationKey),
            signal: AbortSignal.timeout(15_000),
          });
          if (response.status !== 200) return false;
        }
        return true;
      };
      await until(connected, { timeout: 300_000, message: "the examples' Action endpoints to answer" });

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
      await until(() => restarts() === 1, { timeout: 180_000, message: "a runner restart" });
      await until(connected, { timeout: 120_000, message: "the Action endpoints to answer again" });
    } finally {
      await writeFile(edited, original);
      controller.abort();
      await app.close();
    }
  });
  console.log(
    "Development smoke passed: npm run dev on the stack (local images), examples linked to its Tenant, Action endpoints, Studio login, package rebuild and runner restart.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if ((await readFile(edited, "utf8")) !== original) await writeFile(edited, original);
  await rm(scratch, { recursive: true, force: true });
}
