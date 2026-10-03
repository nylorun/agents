/**
 * The transcripts of recent sessions, each at the record position (`cursor`) it was folded or
 * settled at. A warm run whose `turn.start` names the cached cursor needs no `transcript.read`.
 * Least recently used sessions are dropped past the byte budget (JSON size, estimated).
 */
export class TranscriptCache {
  private readonly entries = new Map<
    string,
    { cursor: number; transcript: readonly unknown[]; bytes: number }
  >();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  /** The transcript of `sessionId` at `cursor`, or undefined. */
  get(sessionId: string, cursor: number): readonly unknown[] | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.cursor !== cursor) return undefined;
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
    return entry.transcript;
  }

  /** Bytes of the cached transcript of `sessionId`, for estimating an edited one. */
  bytesOf(sessionId: string): number | undefined {
    return this.entries.get(sessionId)?.bytes;
  }

  put(sessionId: string, cursor: number, transcript: readonly unknown[], bytes?: number): void {
    this.delete(sessionId);
    const size = bytes ?? JSON.stringify(transcript).length;
    if (size > this.maxBytes) return;
    this.entries.set(sessionId, { cursor, transcript, bytes: size });
    this.bytes += size;
    for (const [id, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(id);
      this.bytes -= entry.bytes;
    }
  }

  delete(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    this.bytes -= entry.bytes;
  }

  get size(): number {
    return this.entries.size;
  }
}
