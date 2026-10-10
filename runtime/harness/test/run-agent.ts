import { run, bindingFromAgent } from "../src/run/index.js";
import type { BuiltAgent } from "@nylorun/core/define";
import type { AgentBuilder } from "@nylorun/core/define";
import type { RunOptions } from "../src/types/execution.js";
/** Test-only spelling migration. Production definitions have no executable facade. */
export function runAgent(
  agent: BuiltAgent<any, any> | AgentBuilder<any, any>,
  options: RunOptions<any>,
) {
  return run({ binding: bindingFromAgent("build" in agent ? agent.build() : agent), ...options });
}
