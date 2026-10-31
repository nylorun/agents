/**
 * `@nylorun/agents/a2a`: serve the Tenant's agents to A2A clients through the app's own server
 * (gateway mode), and call A2A agents with the Nylorun profile v2 (the client, push
 * verification, the extensions' readers and the change feed). The handler forwards A2A requests
 * to the Runtime, which speaks the protocol; this entry point loads no A2A package.
 */
export { createA2aHandler } from "./handler.js";
export type {
  A2aCaller,
  A2aCardOptions,
  A2aHandler,
  A2aHandlerOptions,
} from "./handler.js";
export { toNodeListener } from "../ag-ui/node.js";
export * from "./client-api.js";
// A2A 1.0 wire types; from the package root as the namespace `A2a` (`A2a.Task`).
export type {
  AgentCapabilities,
  AgentCard,
  AgentExtension,
  AgentInterface,
  AgentSkill,
  Artifact,
  ListTasksResult,
  Message,
  Metadata,
  Part,
  PushNotificationConfig,
  Role,
  StreamResponse,
  Task,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatus,
  TaskStatusUpdateEvent,
} from "./types.js";
