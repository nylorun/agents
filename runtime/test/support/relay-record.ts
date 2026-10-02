/**
 * An in-memory record with a change source that behaves like a logical replication slot:
 * committed transactions are kept until acknowledged and replayed to the next reader, one
 * reader holds the slot at a time, and a dropped slot starts fresh. The relay core's test fake
 * (`streams/relay-core.test.ts`); the real pair is `store/postgres/record.ts` and
 * `adapters/replication/pgoutput.ts`.
 */
import type {
  ChangeHandlers,
  ChangeSource,
  CommittedTx,
  LogHead,
  RecordReader,
  RecordRow,
} from "../../src/streams/relay/types.js";

export class MemoryRecord implements RecordReader {
  /** `tenantId\0sessionId` → rows by seq. */
  private readonly rows = new Map<string, RecordRow[]>();
  private readonly generations = new Map<string, number>();
  /** Committed transactions since the slot's confirmed position. */
  private retained: { lsn: number; tx: CommittedTx }[] = [];
  private lsn = 0;
  private slot: { confirmed: number; reconcilePending: boolean } | undefined;
  private reader: MemoryChangeSource | undefined;

  /** Commits rows as one transaction (the record is written by the Session Store). */
  commit(rows: readonly RecordRow[]): void {
    if (rows.length === 0) return;
    for (const row of rows) {
      const key = keyOf(row.tenantId, row.sessionId);
      let list = this.rows.get(key);
      if (!list) this.rows.set(key, (list = []));
      list[row.seq] = structuredClone(row);
      if (!this.generations.has(row.tenantId)) this.generations.set(row.tenantId, row.generation);
    }
    this.lsn += 1;
    const tx: CommittedTx = { endLsn: lsnText(this.lsn), rows: rows.map((row) => structuredClone(row)) };
    // A slot keeps what was committed after it was created.
    if (this.slot) this.retained.push({ lsn: this.lsn, tx });
    this.reader?.deliver(tx);
  }

  /** Sets a Tenant's basin generation (a reset moves it on). */
  setGeneration(tenantId: string, generation: number): void {
    this.generations.set(tenantId, generation);
  }

  /** Deletes a Tenant's rows, or one session's, as a reset or deletion does. */
  deleteRows(tenantId: string, sessionId?: string): void {
    for (const key of [...this.rows.keys()])
      if (sessionId === undefined ? key.startsWith(`${tenantId}\u0000`) : key === keyOf(tenantId, sessionId))
        this.rows.delete(key);
  }

  /** Forgets a Tenant (deletion). */
  deleteTenant(tenantId: string): void {
    this.deleteRows(tenantId);
    this.generations.delete(tenantId);
  }

  /** Drops the slot, as `max_slot_wal_keep_size` or an operator would. */
  dropSlot(): void {
    this.slot = undefined;
    this.retained = [];
    this.reader?.lost(new Error("replication slot dropped"));
  }

  /** Ends the reader's connection but keeps the slot, as a network failure would. */
  disconnect(): void {
    this.reader?.lost(new Error("replication connection lost"));
  }

  /** A change source over this record; one at a time holds the slot. */
  source(): ChangeSource {
    return new MemoryChangeSource(this);
  }

  async readRange(tenantId: string, sessionId: string, from: number, to: number): Promise<RecordRow[]> {
    const list = this.rows.get(keyOf(tenantId, sessionId)) ?? [];
    return list.slice(from, to).filter(Boolean).map((row) => structuredClone(row));
  }

  async heads(
    after: { tenantId: string; sessionId: string } | undefined,
    limit: number,
  ): Promise<LogHead[]> {
    const heads: LogHead[] = [];
    for (const [key, list] of [...this.rows].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const [tenantId, sessionId] = key.split("\u0000") as [string, string];
      if (after && key <= keyOf(after.tenantId, after.sessionId)) continue;
      const last = list[list.length - 1];
      if (!last) continue;
      heads.push({ tenantId, sessionId, generation: last.generation, head: list.length });
      if (heads.length >= limit) break;
    }
    return heads;
  }

  async generation(tenantId: string): Promise<number | undefined> {
    return this.generations.get(tenantId);
  }

  /** @internal */
  attach(reader: MemoryChangeSource): { fresh: boolean; replay: CommittedTx[] } | undefined {
    if (this.reader && this.reader !== reader) return undefined;
    this.reader = reader;
    if (!this.slot) this.slot = { confirmed: this.lsn, reconcilePending: true };
    return {
      fresh: this.slot.reconcilePending,
      replay: this.retained.map((entry) => entry.tx),
    };
  }

  /** @internal */
  detach(reader: MemoryChangeSource): void {
    if (this.reader === reader) this.reader = undefined;
  }

  /** @internal */
  reconciled(): void {
    if (this.slot) this.slot.reconcilePending = false;
  }

  /** @internal */
  confirm(lsn: string): void {
    const position = Number(lsn.split("/")[1] ?? lsn);
    if (!this.slot || position <= this.slot.confirmed) return;
    this.slot.confirmed = position;
    this.retained = this.retained.filter((entry) => entry.lsn > position);
  }

  /** The slot's confirmed position (tests). */
  confirmed(): number | undefined {
    return this.slot?.confirmed;
  }
}

class MemoryChangeSource implements ChangeSource {
  private handlers: ChangeHandlers | undefined;
  private timer: NodeJS.Timeout | undefined;
  private active = false;
  private stopped = false;

  constructor(private readonly record: MemoryRecord) {}

  start(handlers: ChangeHandlers): void {
    this.handlers = handlers;
    this.tryAttach();
  }

  acknowledge(lsn: string): void {
    if (this.active) this.record.confirm(lsn);
  }

  async reconciled(): Promise<void> {
    this.record.reconciled();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.record.detach(this);
    this.active = false;
  }

  /** @internal */
  deliver(tx: CommittedTx): void {
    if (this.active) this.handlers?.onTx(tx);
  }

  /** @internal */
  lost(error: Error): void {
    if (!this.active) return;
    this.active = false;
    this.record.detach(this);
    this.handlers?.onInactive(error);
    this.retry();
  }

  private tryAttach(): void {
    if (this.stopped) return;
    const attached = this.record.attach(this);
    if (!attached) return this.retry();
    this.active = true;
    this.handlers!.onActive({ fresh: attached.fresh });
    for (const tx of attached.replay) this.handlers!.onTx(tx);
  }

  private retry(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.tryAttach(), 20);
    this.timer.unref?.();
  }
}

const keyOf = (tenantId: string, sessionId: string) => `${tenantId}\u0000${sessionId}`;
/** A Postgres-looking LSN, so positions read the same in logs. */
const lsnText = (n: number) => `0/${n}`;
