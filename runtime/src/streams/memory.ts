import type {
  AppendOptions,
  AppendResult,
  DurableStreams,
  ReadOptions,
  StreamRecord,
} from "./types.js";

interface StoredRecord {
  seq: number;
  timestamp: number;
  /** JSON text, so readers never share objects with writers. */
  body: string;
}

/**
 * In-memory `DurableStreams` for unit tests and the in-process Runtime before
 * S2 (Wave 2). Not durable. Keeps the seam's sequence, conditional-append and
 * resume semantics.
 */
export class MemoryStreams implements DurableStreams {
  /** tenantId → stream → records. */
  private readonly tenants = new Map<string, Map<string, StoredRecord[]>>();
  /** `tenantId\0stream` → wake-ups for readers waiting at the tail. */
  private readonly waiters = new Map<string, Set<() => void>>();
  private closed = false;

  async append(
    tenantId: string,
    stream: string,
    records: readonly unknown[],
    options: AppendOptions = {},
  ): Promise<AppendResult> {
    if (this.closed) throw new Error("DurableStreams is closed");
    const streams = this.tenants.get(tenantId);
    if (!streams) throw new Error(`Tenant ${tenantId} has no stream basin`);
    if (records.length === 0) throw new Error("append needs at least one record");
    const bodies = records.map((record) => {
      const body = JSON.stringify(record);
      if (body === undefined) throw new Error("Stream records must be JSON");
      return body;
    });
    let log = streams.get(stream);
    const tail = log?.length ?? 0;
    if (options.matchSeq !== undefined && options.matchSeq !== tail)
      return { status: "seq_mismatch", tail };
    if (!log) streams.set(stream, (log = []));
    const timestamp = Date.now();
    for (const body of bodies) log.push({ seq: log.length, timestamp, body });
    this.notify(tenantId, stream);
    return { status: "ok", start: tail, end: log.length };
  }

  read<T = unknown>(
    tenantId: string,
    stream: string,
    fromSeq: number,
    options: ReadOptions = {},
  ): AsyncIterable<StreamRecord<T>> {
    if (!Number.isInteger(fromSeq) || fromSeq < 0)
      throw new Error("fromSeq must be a non-negative integer");
    const follow = options.follow ?? true;
    const signal = options.signal;
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        let next = fromSeq;
        const end = follow ? Infinity : self.log(tenantId, stream)?.length ?? 0;
        while (!signal?.aborted && !self.closed) {
          const log = self.log(tenantId, stream);
          while (log && next < log.length && next < end) {
            const record = log[next++]!;
            yield {
              seq: record.seq,
              timestamp: record.timestamp,
              body: JSON.parse(record.body) as T,
            };
            if (signal?.aborted) return;
          }
          if (next >= end || !self.tenants.has(tenantId)) return;
          await self.waitForAppend(tenantId, stream, signal);
        }
      },
    };
  }

  async tail(tenantId: string, stream: string): Promise<number> {
    return this.log(tenantId, stream)?.length ?? 0;
  }

  async ensureTenant(tenantId: string): Promise<void> {
    if (!this.tenants.has(tenantId)) this.tenants.set(tenantId, new Map());
  }

  async deleteTenant(tenantId: string): Promise<void> {
    const streams = this.tenants.get(tenantId);
    this.tenants.delete(tenantId);
    for (const stream of streams?.keys() ?? []) this.notify(tenantId, stream);
    for (const key of this.waiters.keys())
      if (key.startsWith(`${tenantId}\u0000`)) this.notifyKey(key);
  }

  async deleteStream(tenantId: string, stream: string): Promise<void> {
    this.tenants.get(tenantId)?.delete(stream);
    this.notify(tenantId, stream);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const key of [...this.waiters.keys()]) this.notifyKey(key);
  }

  private log(tenantId: string, stream: string): StoredRecord[] | undefined {
    return this.tenants.get(tenantId)?.get(stream);
  }

  private waitForAppend(
    tenantId: string,
    stream: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const key = `${tenantId}\u0000${stream}`;
    return new Promise<void>((resolve) => {
      let set = this.waiters.get(key);
      if (!set) this.waiters.set(key, (set = new Set()));
      const done = () => {
        set!.delete(done);
        if (set!.size === 0 && this.waiters.get(key) === set)
          this.waiters.delete(key);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      set.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  private notify(tenantId: string, stream: string): void {
    this.notifyKey(`${tenantId}\u0000${stream}`);
  }

  private notifyKey(key: string): void {
    for (const wake of [...(this.waiters.get(key) ?? [])]) wake();
  }
}
