#!/usr/bin/env node
// Starts the OpenShell test gateway and waits until it answers, or stops it and
// deletes its sandboxes and state with `down`:
//
//   node test/openshell/up.mjs        # npm run test:openshell:up
//   node test/openshell/up.mjs down   # npm run test:openshell:down
//
// Then: NYLORUN_TEST_OPENSHELL=1 npm run test:integration -w @nylorun/runtime
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const compose = fileURLToPath(new URL("./compose.yaml", import.meta.url));
const root = join(realpathSync(tmpdir()), "nylorun-openshell-test");
const env = { ...process.env, OPENSHELL_DATA: join(root, "data"), OPENSHELL_JWT: join(root, "jwt") };

function docker(args, options = {}) {
  const result = spawnSync("docker", args, { stdio: "inherit", env, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure)
    throw new Error(`docker ${args.join(" ")} exited with ${result.status}`);
  return result;
}

if (process.argv[2] === "down") {
  docker(["compose", "-f", compose, "down", "--remove-orphans"], { allowFailure: true });
  // Sandbox containers belong to the gateway, not to the compose project.
  const listed = spawnSync("docker", ["ps", "-aq", "--filter", "name=openshell-default--"], { encoding: "utf8" });
  const ids = listed.stdout.split("\n").filter(Boolean);
  if (ids.length > 0) docker(["rm", "-f", ...ids], { allowFailure: true });
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
}

mkdirSync(env.OPENSHELL_DATA, { recursive: true });
mkdirSync(env.OPENSHELL_JWT, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(join(env.OPENSHELL_JWT, "signing.pem"), privateKey.export({ type: "pkcs8", format: "pem" }), {
  mode: 0o600,
});
writeFileSync(join(env.OPENSHELL_JWT, "public.pem"), publicKey.export({ type: "spki", format: "pem" }));
writeFileSync(join(env.OPENSHELL_JWT, "kid"), randomUUID().slice(0, 8));
docker(["compose", "-f", compose, "up", "-d", "--force-recreate"]);

for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch("http://127.0.0.1:8081/healthz");
    if (response.ok) {
      console.log("OpenShell test gateway: http://127.0.0.1:8080");
      process.exit(0);
    }
  } catch {
    /* not up yet */
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
docker(["compose", "-f", compose, "logs", "--no-color"], { allowFailure: true });
throw new Error("The OpenShell test gateway did not become healthy");
