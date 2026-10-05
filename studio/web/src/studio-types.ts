import type { WorkflowManifest } from "@/workflow/types";

export type HookPoint = {
  at: "before" | "after";
  scope: "turn" | "step";
};

/** Agent definition as listed by Runtime (no `kind`, or legacy). */
export type AgentDefinition = {
  id: string;
  name: string;
  kind?: undefined;
  /** The registered definition's hash; a session may be pinned to an older one. */
  manifestHash?: string;
  manifest: {
    id?: string;
    kind?: undefined;
    description?: string;
    capabilities: readonly {
      id: string;
      tools?: readonly { name: string; description?: string }[];
      hooks?: readonly HookPoint[];
      instructions?: string;
    }[];
  };
};

/** Workflow definition document (`kind: "workflow"`). */
export type WorkflowDefinition = {
  id: string;
  name: string;
  kind: "workflow";
  manifestHash?: string;
  manifest: WorkflowManifest;
};

export type StudioDefinition = AgentDefinition | WorkflowDefinition;

/** @deprecated Prefer StudioDefinition; kept for existing imports. */
export type AgentManifest = StudioDefinition;

export type SessionSummary = {
  session: string;
  status: string;
  title?: string;
  startedAt: number;
};

export type Connection = {
  status: "Connecting" | "Running" | "Offline";
  url?: string;
  agents: readonly StudioDefinition[];
  sessionsByAgent: Record<string, SessionSummary[]>;
};
