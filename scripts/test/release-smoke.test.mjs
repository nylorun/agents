import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { publicCreatorArguments, publicCreatorEnvironment } from "../release/smoke.mjs";
import { execFileSync } from "node:child_process";
import { parse } from "../../create-agent/dist/arguments.js";
import { createProject } from "../../create-agent/dist/project.js";

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
  }, "/isolated/empty.npmrc", 4123, {
    NYLORUN_HOME: "/tmp/nylorun-host-fixture",
    HOME: "/tmp/nylorun-home-fixture",
  });
  const child = JSON.parse(execFileSync(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], { env, encoding: "utf8" }));
  assert.equal(child.PORT, "4123");
  assert.equal(child.NPM_CONFIG_USERCONFIG, "/isolated/empty.npmrc");
  assert.equal(child.NPM_CONFIG_GLOBALCONFIG, "/isolated/empty.npmrc.global");
  assert.equal(child.NYLORUN_HOME, "/tmp/nylorun-host-fixture");
  assert.doesNotMatch(JSON.stringify(child), /publication-token|github-token|oidc-token|provider-key|publishing\.npmrc|https:\/\/example\.test/);
});

test("the publication smoke creates and starts a project without a terminal or provider calls", async () => {
  const args = publicCreatorArguments("0.2.0-beta");
  assert.ok(args.includes("--package=@nylorun/create-agent@0.2.0-beta"));
  const options = parse(args.slice(args.indexOf("--") + 2));
  const commands = [];
  await createProject(
    options,
    { harness: "1.0.0", agents: "1.0.0", runtime: "1.0.0", studio: "1.0.0" },
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
  assert.deepEqual(commands, [
    ["install", "--yes"],
    ["run", "dev"],
  ]);
});
