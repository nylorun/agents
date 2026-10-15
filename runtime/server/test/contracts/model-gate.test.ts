import { inProcessModelGate } from "../../src/gates/in-process.js";
import { httpModelGate } from "../../src/gates/http-client.js";
import { startGates } from "../../src/host/gates.js";
import { modelGateContract } from "./model-gate.contract.js";
import { runFixture, type RunFixture } from "../support/run-tokens.js";
import { modelCallLimits } from "../support/limits.js";
import { writeLimitsConfig } from "../../src/tenant/runtime-limits.js";

const quiet = { info() {}, warn() {}, error() {} };

modelGateContract("in-process", async (host) => ({
  gate: inProcessModelGate({
    readHostModel: host.readHostModel,
    writeHostCredential: async () => {},
    settings: host.settings,
  }),
}));

// The loop's client over HTTP to the gates service, which runs in this process: the stubbed
// provider `fetch` serves both. The calls are one session's, under its run token (F5).
let runs: Promise<RunFixture> | undefined;
modelGateContract("http", async (host) => {
  runs ??= runFixture().then(async (fixture) => {
    await fixture.run("session-1", { agentId: "bot", turnId: "turn-1" });
    return fixture;
  });
  const fixture = await runs;
  // The gates service reads the Tenant's Runtime limits `model*` for each call.
  await fixture.store.tx((t) => writeLimitsConfig(t, { limits: modelCallLimits(host.settings) }));
  const token = "ab".repeat(32);
  const server = await startGates({
    gates: { listen: { host: "127.0.0.1", port: 0, allowedHosts: [] }, token },
    logger: quiet,
    vaults: {
      open: async () =>
        ({
          tenantId: fixture.tenantId,
          store: fixture.store,
          root: "/nonexistent-tenant-home",
          readHostModel: host.readHostModel,
          writeHostCredential: async () => {},
        }) as never,
    },
    drainMs: 0,
  });
  return {
    gate: httpModelGate({ url: server.url, runTokens: fixture.grants }),
    scope: { tenantId: fixture.tenantId, sessionId: "session-1", turnId: "turn-1", agentId: "bot" },
    dispose: () => server.close(),
  };
});
