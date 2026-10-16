// Startup only: no sessions, commands, customer functions, or model requests. The Tenant lives
// in Postgres: NYLORUN_DATABASE_URL, or the runtime test stack's database
// (npm run test:stack:up -w @nylorun/runtime).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEphemeralRuntime } from "@nylorun/runtime/core";
import { Agent, createClient } from "@nylorun/agents";

const agent = Agent({ id: "startup-only", name: "Startup import check" }).build();
const database =
  process.env.NYLORUN_DATABASE_URL ?? "postgres://nylorun:nylorun@127.0.0.1:55432/nylorun";
const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-core-startup-"));
let runtime;
try {
  runtime = await startEphemeralRuntime({
    hostRoot,
    applicationKey: "startup-server-key-onlyyyy",
    baseline: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    },
    retainRoot: true,
    database,
  });
  const client = createClient({
    url: runtime.url,
    key: runtime.applicationKey,
    tenant: runtime.tenantId,
  });
  // Saves an agent manifest (the Runtime runs no code of the app's), makes its Agent and reads
  // both back.
  await client.agentManifests.save({ agent }, { requestId: "startup-only" });
  await client.agents.put(agent.id, { manifest: agent.id });
  assert.ok(
    (await client.agentManifests.list()).some((saved) => saved.name === agent.id),
    "the saved manifest is listed",
  );
  assert.ok(
    (await client.agents.list()).some((made) => made.id === agent.id && made.kind === "none"),
    "the Agent is listed",
  );
  console.log("/v1/agent-manifests saved and /v1/agents made and listed", agent.id);
} finally {
  await runtime?.close();
  await rm(hostRoot, { recursive: true, force: true });
}
console.log("Agent manifest saved, Agent made and ephemeral Runtime shut down cleanly. No functionality checks run.");
