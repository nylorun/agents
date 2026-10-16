import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import {
  bannerField,
  composeServices,
  publicCreatorArguments,
  publicCreatorEnvironment,
  retryUntilServed,
} from "../release/smoke.mjs";
import { execFileSync } from "node:child_process";
import { parse } from "../../cli/create-agent/dist/arguments.js";
import { createProject } from "../../cli/create-agent/dist/project.js";

test("public installation subprocesses cannot inherit publication credentials", () => {
  const env = publicCreatorEnvironment({
    PATH: process.env.PATH,
    NODE_AUTH_TOKEN: "publication-token",
    GH_TOKEN: "github-token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test/oidc",
    OPENAI_API_KEY: "provider-key",
    npm_config_userconfig: "/private/publishing.npmrc",
    NPM_CONFIG_GLOBALCONFIG: "/private/global.npmrc",
    npm_config_cache: "/private/warm-cache",
    NYLORUN_RUNTIME_IMAGE: "nylorun-runtime:local",
    NYLORUN_STUDIO_IMAGE: "nylorun-studio:local",
  }, "/isolated/empty.npmrc", {
    NPM_CONFIG_CACHE: "/isolated/npm-cache",
  });
  const child = JSON.parse(execFileSync(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], { env, encoding: "utf8" }));
  assert.equal(child.NPM_CONFIG_USERCONFIG, "/isolated/empty.npmrc");
  assert.equal(child.NPM_CONFIG_GLOBALCONFIG, "/isolated/empty.npmrc.global");
  assert.equal(child.NPM_CONFIG_CACHE, "/isolated/npm-cache");
  assert.equal(child.NYLORUN_DEV_MODEL, "fixture");
  assert.doesNotMatch(JSON.stringify(child), /publication-token|github-token|oidc-token|provider-key|publishing\.npmrc|https:\/\/example\.test|warm-cache/);
  // The published CLI runs the images it pins, never a local override.
  assert.equal(child.NYLORUN_RUNTIME_IMAGE, undefined);
  assert.equal(child.NYLORUN_STUDIO_IMAGE, undefined);
});

test("the publication smoke creates a project without a terminal and starts nothing", async () => {
  const args = publicCreatorArguments("0.2.0-beta");
  assert.ok(args.includes("--package=@nylorun/create-agent@0.2.0-beta"));
  const options = parse(args.slice(args.indexOf("--") + 2));
  const commands = [];
  await createProject(
    options,
    { core: "1.0.0", cli: "1.0.0", harness: "1.0.0", agents: "1.0.0", admin: "1.0.0", runtime: "1.0.0" },
    {
      currentDirectory: () => resolve(".tmp/release-smoke-test"),
      isInteractive: () => false,
      log: () => {},
      exists: async () => false,
      makeDirectory: async () => {},
      rename: async () => {},
      remove: async () => {},
      write: async () => {},
      run: async (_command, args) => {
        commands.push(args);
        return { status: 0 };
      },
      // The smoke host has Docker with Compose v2 (the prerequisite).
      nodeVersion: process.versions.node,
      checkDocker: async () => ({ ok: true }),
    },
  );
  assert.ok(!args.includes("--no-open"));
  // The creator only installs; the smoke runs nylorun start and npm run dev.
  assert.deepEqual(commands, [["install", "--yes"]]);
});

test("the smoke reads the dev banner and the Tenant's Compose services", () => {
  const banner = [
    "Runtime       http://localhost:4123  (started; stays running)",
    "Studio        http://localhost:4124/login?token=abc&next=%2Ftenants%2Ftn_1",
  ];
  assert.equal(bannerField(banner, "Runtime"), "http://localhost:4123");
  assert.equal(bannerField(banner, "Studio"), "http://localhost:4124/login?token=abc&next=%2Ftenants%2Ftn_1");
  assert.equal(bannerField(banner, "Entry"), undefined);
  const services = [
    { Service: "runtime", Image: "ghcr.io/nylorun/runtime:1.0.0" },
    { Service: "studio", Image: "ghcr.io/nylorun/studio:1.0.0" },
  ];
  const lines = services.map((service) => JSON.stringify(service)).join("\n") + "\n";
  assert.deepEqual(composeServices(lines), services);
  assert.deepEqual(composeServices(JSON.stringify(services)), services);
});

/** A clock that sleep advances, and the attempts' answers in order. */
function scripted(answers) {
  let time = 0;
  const seen = [];
  return {
    seen,
    attempt: async () => {
      seen.push(time);
      return answers[Math.min(seen.length, answers.length) - 1];
    },
    options: { windowMs: 300_000, delayMs: 15_000, now: () => time, sleep: async (ms) => { time += ms; } },
  };
}

const notServed = { code: 1, output: "npm error code ETARGET\nnpm error notarget No matching version found for @nylorun/create-agent@0.15.2-beta." };

test("the publication smoke waits minutes for the CDN to serve a fresh version", async () => {
  const run = scripted([notServed, notServed, notServed, notServed, notServed, { code: 0, output: "" }]);
  assert.equal(await retryUntilServed(run.attempt, run.options), 0);
  // Past the 45 seconds the release of 2026-10-16 gave up after.
  assert.deepEqual(run.seen, [0, 15_000, 30_000, 45_000, 60_000, 75_000]);
});

test("the publication smoke stops waiting when the window ends", async () => {
  const run = scripted([notServed]);
  assert.equal(await retryUntilServed(run.attempt, run.options), 1);
  assert.equal(run.seen.length, 21);
  assert.equal(run.seen.at(-1), 300_000);
});

test("the publication smoke fails at once on anything but a version npm cannot find yet", async () => {
  const run = scripted([{ code: 1, output: "npm error code E403\nnpm error 403 Forbidden" }]);
  assert.equal(await retryUntilServed(run.attempt, run.options), 1);
  assert.equal(run.seen.length, 1);
});
