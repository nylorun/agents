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
  // Saves a definition (the Runtime runs no code of the app's) and reads it back.
  await client.saveAgent(agent, { requestId: "startup-only" });
  const { agents } = await client.listAgents();
  assert.ok(
    agents.some((saved) => saved.manifest?.id === agent.id),
    "the saved agent is listed",
  );
  console.log("/v1/agents saved and listed", agent.id);
} finally {
  await runtime?.close();
  await rm(hostRoot, { recursive: true, force: true });
}
console.log("Agent saved and ephemeral Runtime shut down cleanly. No functionality checks run.");
