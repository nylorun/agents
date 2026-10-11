/**
 * The entrypoint. In a sandbox pod (`NYLORUN_SANDBOX_ID` set, or the join file present) it joins
 * with the pod's join token; as a harness container it connects with `NYLORUN_HARNESS_TOKEN`, its
 * own token (`nylorun-operate harness token put <id>`), bound to the id it says in `hello`
 * (`HARNESS_ID`, default `minimal`). When the connection is lost it connects again; SIGTERM gives
 * the run in hand back and exits.
 */
import { existsSync } from "node:fs";
import { connect, serve } from "./harness.js";
import { podHost } from "./pod.js";

const env = process.env;
const need = (name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const log = (message: string, fields: Record<string, unknown> = {}) =>
  console.error(JSON.stringify({ time: new Date().toISOString(), message, ...fields }));

const joinFile = env.NYLORUN_SANDBOX_JOIN_FILE ?? "/run/nylorun/join/token";
const pod =
  env.NYLORUN_SANDBOX_ID || existsSync(joinFile)
    ? podHost({
        sandboxId: need("NYLORUN_SANDBOX_ID"),
        podUid: need("NYLORUN_POD_UID"),
        joinFile,
        harnessUrl: need("NYLORUN_HARNESS_URL"),
        ...(env.NYLORUN_EGRESS_PROXY ? { egressProxy: env.NYLORUN_EGRESS_PROXY } : {}),
        root: env.NYLORUN_HARNESS_ROOT ?? "/harness",
      })
    : undefined;
const options = {
  name: env.HARNESS_ID ?? "minimal",
  gatesUrl: need("NYLORUN_GATES_URL"),
  log,
  ...(pod ? { commandEnv: () => pod.commandEnv() } : {}),
};

const stopping = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stopping.abort());

let attempt = 0;
while (!stopping.signal.aborted) {
  try {
    const token = pod ? await pod.token() : need("NYLORUN_HARNESS_TOKEN");
    const channel = await connect(need("NYLORUN_HARNESS_URL"), token);
    log("connected", { name: options.name, pod: env.NYLORUN_SANDBOX_ID });
    attempt = 0;
    await serve(channel, { ...options, signal: stopping.signal });
    channel.close("harness stopped");
  } catch (error) {
    log("connection failed", { error: error instanceof Error ? error.message : String(error) });
  }
  if (stopping.signal.aborted) break;
  // Back off from 0.5 s to 10 s between attempts.
  await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** attempt++)));
}
pod?.stop();
