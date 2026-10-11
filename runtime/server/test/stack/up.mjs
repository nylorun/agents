#!/usr/bin/env node
// Brings the integration test stack up and waits until every service answers,
// or takes it down with `down`:
//
//   node test/stack/up.mjs        # npm run test:stack:up
//   node test/stack/up.mjs down   # npm run test:stack:down
//
// NYLORUN_TEST_PROFILES (comma-separated) adds Compose profiles: `traces` starts the R7 exit
// test's OpenTelemetry Collector, writing to NYLORUN_TEST_OTEL_DIR.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

const compose = fileURLToPath(new URL("./compose.yaml", import.meta.url));
const port = (name, fallback) => Number(process.env[name] ?? fallback);
const endpoints = {
  postgres: port("NYLORUN_TEST_POSTGRES_PORT", 55432),
  restateIngress: `http://127.0.0.1:${port("NYLORUN_TEST_RESTATE_INGRESS_PORT", 58080)}`,
  restateAdmin: `http://127.0.0.1:${port("NYLORUN_TEST_RESTATE_ADMIN_PORT", 59070)}`,
  s2: `http://127.0.0.1:${port("NYLORUN_TEST_S2_PORT", 58090)}`,
  s3: `http://127.0.0.1:${port("NYLORUN_TEST_S3_PORT", 59000)}`,
  otelHealth: `http://127.0.0.1:${port("NYLORUN_TEST_OTEL_HEALTH_PORT", 54133)}`,
};
const profiles = (process.env.NYLORUN_TEST_PROFILES ?? "")
  .split(",")
  .map((profile) => profile.trim())
  .filter(Boolean);
const otelDir = process.env.NYLORUN_TEST_OTEL_DIR ?? "/tmp/nylorun-test-otel";

function docker(args) {
  const profileArgs = profiles.flatMap((profile) => ["--profile", profile]);
  const result = spawnSync("docker", ["compose", "-f", compose, ...profileArgs, ...args], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`docker compose ${args.join(" ")} exited with ${result.status}`);
}

/** Postgres answers an SSLRequest with one byte, `S` or `N`. */
function postgresAnswers(portNumber) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: portNumber });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000, () => done(false));
    socket.on("error", () => done(false));
    socket.on("connect", () => {
      const request = Buffer.alloc(8);
      request.writeInt32BE(8, 0);
      request.writeInt32BE(80877103, 4);
      socket.write(request);
    });
    socket.on("data", (data) => done(data[0] === 0x4e || data[0] === 0x53));
  });
}

async function httpOk(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitReady(timeoutMs = 120_000) {
  const checks = {
    postgres: () => postgresAnswers(endpoints.postgres),
    "restate admin": () => httpOk(`${endpoints.restateAdmin}/health`),
    "restate ingress": () => httpOk(`${endpoints.restateIngress}/restate/health`),
    s2: () => httpOk(`${endpoints.s2}/health`),
    rustfs: () => httpOk(`${endpoints.s3}/health`),
    ...(profiles.includes("traces") ? { "otel collector": () => httpOk(endpoints.otelHealth) } : {}),
  };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const results = await Promise.all(
      Object.entries(checks).map(async ([name, check]) => [name, await check()]),
    );
    const waiting = results.filter(([, ok]) => !ok).map(([name]) => name);
    if (waiting.length === 0) return;
    if (Date.now() > deadline)
      throw new Error(`Test stack not ready: ${waiting.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

try {
  const command = process.argv[2] ?? "up";
  if (command === "up") {
    // The collector runs as its own user: its output directory must be writable for it.
    if (profiles.includes("traces")) {
      mkdirSync(otelDir, { recursive: true });
      chmodSync(otelDir, 0o777);
    }
    docker(["up", "--detach", "--wait", "--wait-timeout", "120"]);
    await waitReady();
    console.log(
      `Test stack ready: postgres 127.0.0.1:${endpoints.postgres}, restate ${endpoints.restateIngress} (admin ${endpoints.restateAdmin}), s2 ${endpoints.s2}, rustfs ${endpoints.s3}`,
    );
  } else if (command === "down") {
    // Every profile's services, started or not.
    docker(["--profile", "traces", "down", "--volumes", "--remove-orphans"]);
  } else {
    throw new Error("Usage: up.mjs [up|down]");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
