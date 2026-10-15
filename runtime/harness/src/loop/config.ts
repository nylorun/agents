/**
 * Our engine's loop settings: compaction, and what an agent used as a tool shows its parent when
 * it fails. A harness sets them (`createHarness({ compaction, partialOutputChars })`); a local
 * `run()` and each one left out get the defaults. An invocation hands its settings to the agents
 * it uses as tools.
 */
import { compactionConfigOf, type CompactionConfig } from "./compaction/config.js";

export interface LoopConfig {
  readonly compaction: CompactionConfig;
  /** How many characters of a failed agent-as-tool's last output its parent sees. */
  readonly partialOutputChars: number;
}

/** The characters of a failed agent-as-tool's last output its parent sees, by default. */
export const DEFAULT_PARTIAL_OUTPUT_CHARS = 4_000;

/** `set` over the defaults. */
export function loopConfigOf(
  set: {
    readonly compaction?: Partial<CompactionConfig>;
    readonly partialOutputChars?: number;
  } = {},
): LoopConfig {
  return Object.freeze({
    compaction: compactionConfigOf(set.compaction),
    partialOutputChars: set.partialOutputChars ?? DEFAULT_PARTIAL_OUTPUT_CHARS,
  });
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = loopConfigOf();
