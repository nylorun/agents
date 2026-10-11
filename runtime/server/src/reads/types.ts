import type {
  ModelCallExportPage,
  ModelCallsPage,
  EnvironmentPage,
  ToolCallsPage,
  SessionManifestView,
  SessionPage,
  SessionListItem,
  SessionUsageTotals,
} from "@nylorun/core/contracts";

export type ReadAccess = { owner?: string; agents?: readonly string[] };
export type SessionFilters = {
  agentId?: string;
  status?: SessionListItem["status"];
  environmentId?: string;
  ownerUserId?: string;
};
export type PageOptions = { limit: number; cursor?: string };
/** Public projections only. No execution-state methods or mutable transactions. */
export interface ReadStore {
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
  environments(
    labels: Record<string, string>,
    page: PageOptions,
    access: ReadAccess,
    grants?: readonly string[],
  ): Promise<EnvironmentPage>;
  close(): Promise<void>;
}
