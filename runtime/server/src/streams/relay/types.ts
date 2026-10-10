/**
 * Contracts of the stream relay (Durable Streams §7): what it reads committed events from,
 * and how it reads the record back to refill and reconcile. Postgres implements both with
 * logical replication (`adapters/replication/pgoutput.ts`) and the record tables
 * (`store/postgres/record.ts`); the relay core's unit tests use an in-memory pair
 * (`test/support/relay-record.ts`).
 */

/** One committed row of the record: a session event and the basin generation it goes to. */
export interface RecordRow {
  tenantId: string;
  sessionId: string;
  seq: number;
  generation: number;
  /** The event, as stored. */
  body: unknown;
}

/** One committed transaction's record rows, in commit order. */
export interface CommittedTx {
  /** Where the source resumes after this transaction once it is acknowledged. */
  readonly endLsn: string;
  readonly rows: readonly RecordRow[];
}

export interface ChangeHandlers {
  /**
   * This process now reads the source (the slot is ours). `fresh` while the source has no
   * history to replay for rows committed before it existed (a new or lost slot): the record
   * must be reconciled with S2, then `reconciled()` called.
   */
  onActive(state: { fresh: boolean }): void;
  /** A committed transaction, in commit order. Replayed after a restart until acknowledged. */
  onTx(tx: CommittedTx): void;
  /**
   * The source asks how far it may move on: return the position to acknowledge (the
   * server's `lsn` when nothing is pending), or undefined to acknowledge nothing new.
   */
  onKeepalive(lsn: string): string | undefined;
  /** This process stopped reading the source (connection lost); it tries again. */
  onInactive(error?: unknown): void;
}

/**
 * Committed record rows in commit order, kept by the source until acknowledged: a
 * transaction not acknowledged before a crash is delivered again.
 */
export interface ChangeSource {
  /** Starts reading; keeps trying (another process may hold the source) until `stop`. */
  start(handlers: ChangeHandlers): void;
  /** Everything up to `lsn` is delivered; the source may forget it. */
  acknowledge(lsn: string): void;
  /**
   * The relay reconciled the record after a fresh start. Until this is called, every process
   * that becomes active is told `fresh` again (the reconciliation may have been cut short).
   */
  reconciled(): Promise<void>;
  stop(): Promise<void>;
  /** How far the source is behind, in bytes, when known. */
  lag?(): Promise<number | undefined>;
}

/** A session's log head: the next `seq` to allocate. */
export interface LogHead {
  tenantId: string;
  sessionId: string;
  generation: number;
  head: number;
}

/** Reads the record back (refill and reconciliation). */
export interface RecordReader {
  /** Rows `[from, to)` of a session, in `seq` order. */
  readRange(tenantId: string, sessionId: string, from: number, to: number): Promise<RecordRow[]>;
  /** Log heads with `head > 0`, in (Tenant, session) order, after `after`, at most `limit`. */
  heads(
    after: { tenantId: string; sessionId: string } | undefined,
    limit: number,
  ): Promise<LogHead[]>;
  /** The Tenant's current basin generation; undefined when the Tenant is gone. */
  generation(tenantId: string): Promise<number | undefined>;
}
