/** Execution contracts are owned by Harness. */
export type { JsonValue, JsonObject, MessageInput, UserContentPart, PromptContentPart, PromptItem, ModelCall as RuntimeModelCall, ModelCandidate as RuntimeModelCandidate, ModelAdapter as RuntimeModelAdapter, ModelAdapterContext as RuntimeModelContext, InputEvent as RuntimeInputEvent } from "@nylorun/core/define";
export type { ExecutionInput as RuntimeInput, RunResult as RuntimeCompletion, ExecutionEvent as RuntimeEvent, Session, Turn, Event, Result, InputAccepted, AgentIdentity } from "@nylorun/harness";
export type {
  RunBinding,
  BoundRunOptions,
} from "@nylorun/harness/run";
export type RuntimeAgent = import("@nylorun/core/define").BuiltAgent<any, any>;

