import type {
  ArtifactKind,
  ArtifactPage,
  ModelCallExportPage,
  ModelCallsPage,
  ToolCallsPage,
  SessionManifestView,
  SessionPage,
  SessionListItem,
  SessionUsageTotals,
  LiveEvent,
} from "@nylorun/core/contracts";
import type { TurnRow } from "../store/types.js";

export type ReadAccess = { owner?: string; agents?: readonly string[] };
export type SessionFilters = {
  agentId?: string;
  status?: SessionListItem["status"];
  /** Sessions that pinned a version of this agent manifest. */
  manifest?: string;
  ownerUserId?: string;
};
export type PageOptions = { limit: number; cursor?: string };
/** A page of the turn change feed: rows in the order they changed, and where to read on. */
export type TurnChangeRows = { turns: TurnRow[]; cursor: string; hasMore: boolean };
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
  /**
   * The turn index's change feed (Host feature `turns`): the turns `access` reaches (of one
   * session with `sessionId`), in the order their transactions changed them, after `changedAfter`
   * (a cursor it returned). Only changes below every transaction still running are read, so a
   * change committed later never lands behind the cursor.
   */
  turnChanges(
    filters: { sessionId?: string },
    page: { limit: number; changedAfter?: string },
    access: ReadAccess,
  ): Promise<TurnChangeRows>;
  close(): Promise<void>;
}
