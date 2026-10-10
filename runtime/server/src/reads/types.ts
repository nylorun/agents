import type {
  ArtifactKind,
  ArtifactPage,
  ModelCallExportPage,
  ModelCallsPage,
  EnvironmentPage,
  ToolCallsPage,
  SessionManifestView,
  SessionPage,
  SessionListItem,
  SessionUsageTotals,
  LiveEvent,
} from "@nylorun/core/contracts";

export type ReadAccess = { owner?: string; agents?: readonly string[] };
export type SessionFilters = {
  agentId?: string;
  status?: SessionListItem["status"];
  environmentId?: string;
  ownerUserId?: string;
};
export type PageOptions = { limit: number; cursor?: string };
export type ArtifactFilters = {
  sessionId?: string;
  kind?: ArtifactKind;
  labels: Record<string, string>;
};
/** Public projections only. No execution-state methods or mutable transactions. */
export interface ReadStore {
  artifacts(filters: ArtifactFilters, page: PageOptions, access: ReadAccess): Promise<ArtifactPage>;
  sessions(filters: SessionFilters, page: PageOptions, access: ReadAccess): Promise<SessionPage>;
  manifest(id: string, access: ReadAccess): Promise<SessionManifestView>;
  usage(id: string, turnId: string | undefined, access: ReadAccess): Promise<SessionUsageTotals>;
  modelCalls(
    id: string,
    turnId: string | undefined,
    page: PageOptions,
    access: ReadAccess,
  ): Promise<ModelCallsPage>;
  exportModel(after: string | undefined, limit: number): Promise<ModelCallExportPage>;
  /** A session's tool calls (R5.2), from the effect journal, in the order they were first sent. */
  toolCalls(
    id: string,
    turnId: string | undefined,
    page: PageOptions,
    access: ReadAccess,
  ): Promise<ToolCallsPage>;
  /**
   * One turn's events (R7.5), in log order: the session's rows whose `turnId` is `turnId`. Empty
   * for a turn the session never had.
   */
  turnEvents(id: string, turnId: string, access: ReadAccess): Promise<LiveEvent[]>;
  environments(
    labels: Record<string, string>,
    page: PageOptions,
    access: ReadAccess,
    grants?: readonly string[],
  ): Promise<EnvironmentPage>;
  close(): Promise<void>;
}
