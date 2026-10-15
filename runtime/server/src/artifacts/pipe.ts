/**
 * An upload's body as it crosses the artifact seam (protocol 15): chunks handed over one at a
 * time, so nothing is held whole.
 */
import { HarnessApiError } from "@nylorun/core/harness-api";

/**
 * The body of an upload: chunks handed over one at a time. `push` resolves once the store took
 * the chunk, so a harness's next chunk waits for the store (backpressure across frames, nothing
 * held whole); `close` ends the body, `fail` ends it with an error on both sides.
 */
export class Pipe implements AsyncIterable<Uint8Array> {
  private taker?: { resolve(result: IteratorResult<Uint8Array>): void; reject(error: unknown): void };
  private offered?: { bytes: Uint8Array; taken(): void; reject(error: unknown): void };
  private ended = false;
  private error?: { value: unknown };

  push(bytes: Uint8Array): Promise<void> {
    if (this.error) return Promise.reject(this.error.value);
    if (this.ended) return Promise.reject(new HarnessApiError("invalid", "The upload is committing"));
    if (this.taker) {
      const taker = this.taker;
      this.taker = undefined;
      taker.resolve({ value: bytes, done: false });
      return Promise.resolve();
    }
    return new Promise((taken, reject) => {
      this.offered = { bytes, taken, reject };
    });
  }

  close(): void {
    this.ended = true;
    if (this.taker && !this.offered) {
      const taker = this.taker;
      this.taker = undefined;
      taker.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.error) return;
    this.error = { value: error };
    this.offered?.reject(error);
    this.offered = undefined;
    this.taker?.reject(error);
    this.taker = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        if (this.error) return Promise.reject(this.error.value);
        if (this.offered) {
          const { bytes, taken } = this.offered;
          this.offered = undefined;
          taken();
          return Promise.resolve({ value: bytes, done: false });
        }
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.taker = { resolve, reject };
        });
      },
      return: () => {
        this.fail(new HarnessApiError("invalid", "The store stopped reading the upload"));
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
