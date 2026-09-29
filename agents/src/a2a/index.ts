/**
 * `@nylorun/agents/a2a`: serve the Tenant's agents to A2A clients through the app's own server
 * (gateway mode). The handler forwards A2A requests to the Runtime, which speaks the protocol;
 * this entry point loads no A2A package.
 */
export { createA2aHandler } from "./handler.js";
export type {
  A2aCaller,
  A2aCardOptions,
  A2aHandler,
  A2aHandlerOptions,
} from "./handler.js";
export { toNodeListener } from "../ag-ui/node.js";
