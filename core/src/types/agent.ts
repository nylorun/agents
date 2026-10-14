import type { AgentBinding } from "../definition/binding.js";
import type { AgentManifest } from "./manifest.js";

/** An agent definition built with Agent(...). Optional `.build()` is a no-op facade. */
export interface BuiltAgent<Info = unknown, Output = string> {
  readonly id: string;
  readonly name?: string;
  readonly manifest: AgentManifest;
  toJSON(): AgentManifest;
  getBinding(): AgentBinding;
}

/**
 * An agent placed in another agent's `tools`: a built agent or an `Agent(...)` builder.
 * It becomes a tool named after the agent's id that takes `{ task: string }`.
 */
export type AgentTool = Pick<BuiltAgent<any, any>, "id" | "manifest" | "getBinding">;
