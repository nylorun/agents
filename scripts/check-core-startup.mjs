// Startup only: no sessions, commands, customer functions, or model requests.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEphemeralRuntime } from "@nylorun/runtime/core";
import { Agent, connectAgents } from "@nylorun/agents";

const agent = Agent({ id: "startup-only", name: "Startup import check" });
const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-core-startup-"));
let runtime;
let connection;
try {
  runtime = await startEphemeralRuntime({
    hostRoot,
    applicationKey: "startup-server-key-onlyyyy",
    baseline: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    },
    retainRoot: true,
  });
  const headers = {
    authorization: `Bearer ${runtime.applicationKey}`,
    "Nylorun-Tenant": runtime.tenantId,
    "Nylorun-Protocol": "2",
    "content-type": "application/json",
  };
  const listed = await fetch(`${runtime.url}/v1/executors`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      executors: [
        {
          token: "startup-executor-key-only",
          agentId: agent.id,
          implementationVersion: "dev",
        },
      ],
    }),
  });
  if (!listed.ok)
    throw new Error(
      `/v1/executors failed: ${listed.status} ${await listed.text()}`,
    );
  console.log("/v1/executors", listed.status, await listed.json());
  connection = connectAgents({
    agents: [agent],
    runtime: {
      url: runtime.url,
      key: "startup-executor-key-only",
      tenant: runtime.tenantId,
    },
  });
  let timer;
  try {
    await Promise.race([
      connection.ready,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Idle SSE startup timed out")),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  console.log(
    "Idle authenticated SSE connected and initial empty discovery completed.",
  );
} finally {
  await connection?.close();
  await runtime?.close();
  await rm(hostRoot, { recursive: true, force: true });
}
console.log(
  "Executor and ephemeral Runtime shut down cleanly. No functionality checks run.",
);
