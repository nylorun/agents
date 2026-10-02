import { inProcessModelGate } from "../../src/gates/in-process.js";
import { modelGateContract } from "./model-gate.contract.js";

modelGateContract("in-process", async (host) => ({
  gate: inProcessModelGate({
    readHostModel: host.readHostModel,
    writeHostCredential: async () => {},
    settings: host.settings,
  }),
}));
