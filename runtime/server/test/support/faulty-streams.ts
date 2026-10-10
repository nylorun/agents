/** `DurableStreams` that fail on demand, for relay and failure tests. */
import type {
  AppendOptions,
  AppendResult,
  DurableStreams,
  ReadOptions,
  StreamRecord,
} from "../../src/streams/types.js";

export class FaultyStreams implements DurableStreams {
  /** Every append throws before reaching the streams. */
  down = false;
  /** The next N appends reach the streams, then throw as if the ack was lost. */
  loseAcks = 0;
  appends = 0;
  /** Runs before each append reaches the streams. */
  beforeAppend?: (stream: string) => Promise<void>;

  constructor(private readonly inner: DurableStreams) {}

  async append(
    tenantId: string,
    stream: string,
    records: readonly unknown[],
    options?: AppendOptions,
  ): Promise<AppendResult> {
    this.appends += 1;
    if (this.down) throw new Error("S2 unreachable");
    await this.beforeAppend?.(stream);
    const result = await this.inner.append(tenantId, stream, records, options);
    if (this.loseAcks > 0) {
      this.loseAcks -= 1;
      throw new Error("connection reset before the acknowledgement");
    }
    return result;
  }
  read<T = unknown>(
    tenantId: string,
    stream: string,
    fromSeq: number,
    options?: ReadOptions,
  ): AsyncIterable<StreamRecord<T>> {
    return this.inner.read<T>(tenantId, stream, fromSeq, options);
  }
  tail(tenantId: string, stream: string) {
    return this.inner.tail(tenantId, stream);
  }
  ensureTenant(tenantId: string) {
    return this.inner.ensureTenant(tenantId);
  }
  deleteTenant(tenantId: string, options?: { allGenerations?: boolean }) {
    return this.inner.deleteTenant(tenantId, options);
  }
  deleteStream(tenantId: string, stream: string) {
    return this.inner.deleteStream(tenantId, stream);
  }
  listStreams(tenantId: string, prefix: string) {
    return this.inner.listStreams(tenantId, prefix);
  }
  close() {
    return this.inner.close();
  }
}
