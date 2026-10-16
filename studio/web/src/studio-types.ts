import type { WorkflowManifest } from "@/workflow/types";

/**
 * What a session runs (protocol 16): the loop manifest it pinned when it opened, which is its
 * Agent's manifest version's harness section (`GET /v1/sessions/{id}/manifest`), named by the
 * agent manifest. No `kind`: an agent's loop.
 */
export type AgentDefinition = {
  id: string;
  name: string;
  kind?: undefined;
  /** The hash of the loop manifest the session pinned. */
  manifestHash?: string;
  /** The manifest as the Runtime returned it, for the JSON view. */
  rawManifest?: Record<string, unknown>;
  manifest: {
    id?: string;
    kind?: undefined;
    description?: string;
    /** The agent's own tools (flat); the full manifest is `rawManifest`. */
    tools?: readonly { name: string; description?: string }[];
  };
};

/** A flow's loop manifest (`kind: "workflow"`). */
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
  /** The Agent the session runs on. */
  agentId: string;
  ownerUserId: string;
  status: string;
  /** When the session opened (ISO); null when the Runtime lists no times (no `session-reads`). */
  createdAt: string | null;
  /** When its last event was committed (ISO), else null. */
  lastEventAt: string | null;
};

/** The Tenant's sessions, as the Runtime last listed them. */
export type Connection = {
  status: "Connecting" | "Running" | "Offline";
  url?: string;
  sessions: readonly SessionSummary[];
};
