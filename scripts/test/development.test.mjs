import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  develop,
  developmentOptions,
  packageOf,
  rebuildPlan,
} from "../lib/development.mjs";

test("options: --no-studio implies --no-open; unknown and repeated flags fail", () => {
  assert.deepEqual(developmentOptions([]), { studio: true, open: true, watch: true });
  assert.deepEqual(developmentOptions(["--no-studio"]), { studio: false, open: false, watch: true });
  assert.deepEqual(developmentOptions(["--no-open", "--no-watch"]), {
    studio: true,
    open: false,
    watch: false,
  });
  assert.throws(() => developmentOptions(["--port", "4200"]), /Unknown option/);
  assert.throws(() => developmentOptions(["--no-open", "--no-open"]), /Repeated option/);
});

test("an edit rebuilds its dependents and the images built from it", () => {
  assert.deepEqual(rebuildPlan(["harness"]), { packages: ["harness", "runtime"], images: ["runtime"] });
  assert.deepEqual(rebuildPlan(["core"]), {
    packages: ["core", "harness", "agents", "admin", "runtime", "nylorun", "cli"],
    images: ["runtime", "studio"],
  });
  assert.deepEqual(rebuildPlan(["agents"]), { packages: ["agents", "cli"], images: ["studio"] });
  assert.deepEqual(rebuildPlan(["cli"]), { packages: ["cli"], images: [] });
  assert.deepEqual(rebuildPlan(["nylorun"]), { packages: ["nylorun"], images: [] });
  assert.deepEqual(rebuildPlan(["studio"]), { packages: [], images: ["studio"] });
  assert.deepEqual(rebuildPlan(["studio"], { studio: false }), { packages: [], images: [] });
});

test("only package sources are watched", () => {
  const repo = "/repo";
  assert.equal(packageOf(repo, "/repo/harness/src/engine.ts"), "harness");
  assert.equal(packageOf(repo, "/repo/studio/web/app.tsx"), "studio");
  assert.equal(packageOf(repo, "/repo/studio/src/server.ts"), "studio");
  assert.equal(packageOf(repo, "/repo/runtime/test/x.test.ts"), undefined);
  assert.equal(packageOf(repo, "/repo/harness/dist/index.js"), undefined);
  assert.equal(packageOf(repo, "/repo/examples/src/main.ts"), undefined);
});

test(
  "edits rebuild and restart; a failed build keeps the stack and runner and recovers",
  { timeout: 60_000 },
  async () => {
    const repo = await mkdtemp(join(tmpdir(), "nylorun-dev-test-"));
    const logs = [];
    const calls = [];
    let runners = 0;
    let failing = false;
    const commands = {
      async buildPackage(_group, name) {
        calls.push(`build ${name}`);
        if (failing) throw new Error(`${name} failed to build.`);
      },
      async prepareImages() {
        calls.push("images");
      },
      async buildImage(name) {
        calls.push(`image ${name}`);
      },
      async startStack() {
        calls.push("start");
      },
      async openStudio(_group, { open }) {
        calls.push(`studio open=${open}`);
      },
      startRunner(group) {
        runners += 1;
        calls.push("runner");
        return group.start("examples", process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
      },
    };
    const controller = new AbortController();
    let app;
    try {
      for (const name of ["core", "harness", "agents", "admin", "runtime", "nylorun", "cli", "studio"])
        await mkdir(join(repo, name, "src"), { recursive: true });
      app = await develop(
        { studio: true, open: true, watch: true },
        {
          repo,
          commands,
          log: (line) => logs.push(line),
          signal: controller.signal,
          debounceMs: 50,
          watchOptions: { usePolling: true, interval: 25 },
        },
      );
      assert.deepEqual(calls, [
        "build core",
        "build harness",
        "build agents",
        "build admin",
        "build runtime",
        "build nylorun",
        "build cli",
        "images",
        "start",
        "studio open=true",
        "runner",
      ]);
      const until = async (check) => {
        for (let i = 0; i < 200; i++) {
          if (check()) return;
          await delay(50);
        }
        assert.fail(`${calls.join("\n")}\n${logs.join("\n")}`);
      };

      calls.length = 0;
      await writeFile(join(repo, "harness/src/engine.ts"), "export {};");
      await until(() => runners === 2);
      assert.deepEqual(calls, [
        "build harness",
        "build runtime",
        "image runtime",
        "start",
        "runner",
      ]);

      calls.length = 0;
      failing = true;
      await writeFile(join(repo, "cli/src/cli.ts"), "export const broken = ;");
      await until(() => logs.some((line) => line.includes("were retained")));
      assert.deepEqual(calls, ["build cli"]);
      assert.equal(runners, 2, "the runner keeps running");

      calls.length = 0;
      failing = false;
      await writeFile(join(repo, "cli/src/cli.ts"), "export const fixed = 1;");
      await until(() => runners === 3);
      assert.deepEqual(calls, ["build cli", "runner"]);

      controller.abort();
      assert.equal(await app.done, 0);
    } finally {
      await app?.close();
      await rm(repo, { recursive: true, force: true });
    }
  },
);

test("a runner that exits on its own ends development with its code", { timeout: 30_000 }, async () => {
  const repo = await mkdtemp(join(tmpdir(), "nylorun-dev-test-"));
  try {
    const app = await develop(
      { studio: false, open: false, watch: false },
      {
        repo,
        built: true,
        log: () => {},
        commands: {
          prepareImages: async () => {},
          startStack: async () => {},
          startRunner: (group) => group.start("examples", process.execPath, ["-e", "process.exit(3)"]),
        },
      },
    );
    assert.equal(await app.done, 3);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
