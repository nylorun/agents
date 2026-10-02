import { inProcessModelGate } from "../../src/gates/in-process.js";
import { httpModelGate } from "../../src/gates/http-client.js";
import { startGates } from "../../src/host/gates.js";
import { modelGateContract } from "./model-gate.contract.js";

const quiet = { info() {}, warn() {}, error() {} };

modelGateContract("in-process", async (host) => ({
  gate: inProcessModelGate({
    readHostModel: host.readHostModel,
    writeHostCredential: async () => {},
    settings: host.settings,
  }),
}));

// The loop's client over HTTP to the gates service, which runs in this process: the stubbed
// provider `fetch` serves both.
modelGateContract("http", async (host) => {
  const token = "ab".repeat(32);
  const server = await startGates({
    gates: { listen: { host: "127.0.0.1", port: 0, allowedHosts: [] }, token },
    logger: quiet,
    vaults: {
      open: async () => ({
        root: "/nonexistent-tenant-home",
        readHostModel: host.readHostModel,
        writeHostCredential: async () => {},
      }),
    },
    settings: host.settings,
    drainMs: 0,
  });
  return {
    gate: httpModelGate({ url: server.url, token }),
    dispose: () => server.close(),
  };
});
