/**
 * The pod's engine (`--service harness` in a sandbox pod), on its own: what `main()` does for that
 * service, without importing the rest of the Host. `scripts/bundle-harness.mjs` bundles this file
 * into one script, which the Runtime image ships as `/engine/harness.mjs` and the sandboxes service
 * copies into each pod instead of `/app` (ADR-92 §5: 12 files instead of about 30,000).
 */
import { baselineEnvironment } from "./environment.js";
import { parseStackConfig } from "./stack-config.js";
import { runHarness } from "../harness/main.js";
import { useHostTuning } from "../tuning.js";
import { useHostIdentity } from "../vault/host-identity.js";
import { useWorkloadToken } from "../vault/workload-token.js";

async function start(): Promise<void> {
  const stack = parseStackConfig(process.env, process.argv.slice(2));
  if (!stack.services.has("harness")) throw new Error("This entry runs only --service harness");
  if (stack.tuning) useHostTuning(stack.tuning.values, stack.tuning.overrides);
  useWorkloadToken(stack.workloadToken ?? {});
  useHostIdentity(stack.modelHostIdentity ?? []);
  await runHarness(stack, baselineEnvironment(process.env));
}

void start().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
