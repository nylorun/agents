/**
 * `@nylorun/agents/ag-ui`: serve the Tenant's agents to AG-UI clients from the app's own
 * server. The handler forwards to the Runtime's AG-UI endpoint for each signed-in person; it
 * loads no AG-UI package itself.
 */
export { createAgUiHandler } from "./handler.js";
export type {
  AgUiHandler,
  AgUiHandlerOptions,
  AgUiSessionOptions,
} from "./handler.js";
export { toNodeListener } from "./node.js";
