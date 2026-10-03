/**
 * The record module (blueprint D27): the one write path into the record. It builds each event
 * on the `nylorun.event/2` envelope, checks it against the event catalog, and holds the only
 * insert into `session_events` and `session_log_heads`, whose Postgres statements it runs
 * through the store's `RecordWriter` (`store/postgres/record-writer.ts`;
 * `scripts/check-boundaries.mjs` refuses an insert anywhere else). Other folders import this
 * file, never the module's own files.
 */
export { buildEvent, InvalidEventError, type EventInput } from "./envelope.js";
export { decodeCursor, encodeCursor } from "./cursor.js";
export { appendEvent, type AppendInput, type RecordWriter } from "./append.js";
export {
  appendSandboxEvent,
  buildSandboxEvent,
  type SandboxAppendInput,
  type SandboxRecordWriter,
} from "./sandbox.js";
