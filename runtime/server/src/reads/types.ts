import type {
  ArtifactKind,
  ArtifactPage,
  ModelCallExportPage,
  ModelCallsPage,
  SandboxPage,
  SessionManifestView,
  SessionPage,
  SessionListItem,
  SessionUsageTotals,
} from "@nylorun/core/contracts";

export type ReadAccess = { owner?: string; agents?: readonly string[] };
export type SessionFilters = {
  agentId?: string;
  status?: SessionListItem["status"];
  sandboxId?: string;
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
  sandboxes(
    labels: Record<string, string>,
    page: PageOptions,
    access: ReadAccess,
    grants?: readonly string[],
  ): Promise<SandboxPage>;
  close(): Promise<void>;
}
