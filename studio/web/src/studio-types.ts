import type { WorkflowManifest } from "@/workflow/types";

/** Agent definition as listed by Runtime (no `kind`, or legacy). */
export type AgentDefinition = {
  id: string;
  name: string;
  kind?: undefined;
  /** The registered definition's hash; a session may be pinned to an older one. */
  manifestHash?: string;
  /** The manifest as the Runtime returned it, for the JSON view. */
  rawManifest?: Record<string, unknown>;
  manifest: {
    id?: string;
    kind?: undefined;
    description?: string;
    /** The agent's own tools (manifest v7 is flat); the full manifest is `rawManifest`. */
    tools?: readonly { name: string; description?: string }[];
  };
};

/** Workflow definition document (`kind: "workflow"`). */
export type WorkflowDefinition = {
  id: string;
  name: string;
  kind: "workflow";
  manifestHash?: string;
  rawManifest?: undefined;
  manifest: WorkflowManifest;
};

export type StudioDefinition = AgentDefinition | WorkflowDefinition;

/** @deprecated Prefer StudioDefinition; kept for existing imports. */
export type AgentManifest = StudioDefinition;

/** One row of the Tenant's session list (`GET /v1/sessions`). */
export type SessionSummary = {
  session: string;
  agentId: string;
  ownerUserId: string;
  status: string;
};

export type Connection = {
  status: "Connecting" | "Running" | "Offline";
  url?: string;
  agents: readonly StudioDefinition[];
  sessions: readonly SessionSummary[];
};
