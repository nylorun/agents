/**
 * `memory` (track T5, D72): the agent reads and edits its Agent's memory, Markdown files under
 * `/memories` that outlive the session. Offered when the version the session runs sets
 * `harness.memory` (`turn.start.memory`). The tool is Anthropic's memory tool: one `memory` tool
 * whose `command` is view, create, str_replace, insert, delete or rename, with Anthropic's
 * parameters and answers, the shape the T5 experiment found models of every size call well.
 *
 * The Runtime serves it (a `runtime` effect, operation `memory`) in the call's own transaction, so
 * a replayed turn applies a write once, and checks every call: a missing parameter, a path outside
 * `/memories`, a write the agent may not make. A `read_only` agent and an agent used as a tool
 * get `view` only.
 *
 * The index the Runtime renders (one line per memory, newest first) is pinned at the head of the
 * conversation, as user-role context, so a session's prompt prefix stays the same; see
 * `ExecutionState.pinned`. A version that sets `harness.memory.index: false` (ADR-100) has none.
 * The tool and its text are `@nylorun/core/engine`'s (block `memory`).
 */
import type { TurnMemory } from "@nylorun/core/harness-api";
import { memoryRules, memoryToolOf } from "@nylorun/core/engine";
import type { DurableSessionTool } from "../run/durable.js";

export { memoryIndexBlock } from "@nylorun/core/engine";

/**
 * The memory tool for an agent of a session whose version sets `harness.memory`, and the text the
 * model reads with it: our engine's rules, then the agent's own `instructions`. `root` is false
 * for an agent used as a tool, which may only view, as a `read_only` agent may.
 */
export function memoryTool(
  memory: Pick<TurnMemory, "access" | "instructions">,
  root: boolean,
): { tool: DurableSessionTool; instructions: string } {
  const writes = root && memory.access === "read_write";
  return {
    tool: memoryToolOf(writes),
    instructions: [
      memoryRules(writes),
      ...(memory.instructions
        ? [`Memory instructions for this agent:\n${memory.instructions}`]
        : []),
    ].join("\n\n"),
  };
}
