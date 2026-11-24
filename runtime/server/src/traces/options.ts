/** How spans are made beyond the log: what they say of their source and what content they carry. */
import type { TraceContent } from "./map.js";
import type { TraceResource } from "./otlp.js";

export interface TraceOptions {
  readonly resource: TraceResource;
  readonly content: TraceContent;
}
