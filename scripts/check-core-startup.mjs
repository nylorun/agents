// Startup only: no sessions, commands, customer functions, or model requests.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEphemeralRuntime } from "@nylorun/runtime/core";
import { Agent, createActionHandler, createClient } from "@nylorun/agents";

const agent = Agent({ id: "startup-only", name: "Startup import check" });
const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-core-startup-"));
let runtime;
let server;
try {
  runtime = await startEphemeralRuntime({
    hostRoot,
    applicationKey: "startup-server-key-onlyyyy",
    baseline: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    },
    retainRoot: true,
  });
  const client = createClient({
    url: runtime.url,
    key: runtime.applicationKey,
    tenant: runtime.tenantId,
  });
  const actions = createActionHandler({ agents: [agent], client });
  server = createServer(actions.node);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/nylorun/actions`;
  let timer;
  try {
    // Registers the endpoint and pings it through the Runtime: a signed delivery reaches the
    // handler, which verifies it with the Tenant's public keys.
    const answers = await Promise.race([
      actions.register({ url, saveDefinitions: false }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Action endpoint registration timed out")),
          10000,
        );
      }),
    ]);
    console.log("/v1/endpoints registered and pinged", answers);
  } finally {
    clearTimeout(timer);
  }
} finally {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await runtime?.close();
  await rm(hostRoot, { recursive: true, force: true });
}
console.log(
  "Action endpoint and ephemeral Runtime shut down cleanly. No functionality checks run.",
);
