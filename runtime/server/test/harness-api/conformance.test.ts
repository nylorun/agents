/**
 * The harness conformance suite (`@nylorun/harness-conformance`, R4.7) run for real, container
 * profile, against both harnesses on one Runtime: ours (`nylorun`, a harness service over a
 * loopback WebSocket) and the example (`examples/harness-minimal`, `minimal`, over the Harness API
 * listener with its own per-harness token). The suite drives the Runtime only through its public
 * Runtime and Management APIs; every required check must pass for both. The example's restart
 * checks run too: its connection is dropped mid-command and opened again, as a container restart
 * does.
 */
import { afterEach, expect, it, vi } from "vitest";
import { startHarnessListener } from "../../src/harness-api/ws-server.js";
import { putHarnessToken } from "../../src/tenant/harness-tokens.js";
import type { SessionStore } from "../../src/store/types.js";
import { connect, serve } from "../../../../examples/harness-minimal/src/harness.js";
import { runConformance, type ConformanceReport } from "../../../../conformance/src/index.js";
import { boot, type Started } from "../host/execution-support.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

/** The example, connected with `token` until stopped; `restart` drops its connection and connects again. */
function runExample(url: string, token: string, gatesUrl: string) {
  let current: { stop(): Promise<void> } | undefined;
  const start = async () => {
    const channel = await connect(url, token);
    const stopping = new AbortController();
    const served = serve(channel, { name: "minimal", gatesUrl, signal: stopping.signal });
    current = {
      async stop() {
        stopping.abort();
        channel.close("stopped");
        await served.catch(() => undefined);
      },
    };
  };
  return {
    start,
    async restart() {
      // As a killed container: the connection goes with its run in hand, then a new one comes.
      await current?.stop();
      await start();
    },
    stop: () => current?.stop(),
  };
}

async function start(): Promise<{ runtime: Started; example: ReturnType<typeof runExample>; token: string }> {
  vi.stubEnv("NYLORUN_TEST_MODEL_GATE", "http");
  const runtime = await boot({ harness: "ws" });
  cleanups.push(() => runtime.close());
  const store = (runtime.handle as unknown as { ctx: { store: SessionStore } }).ctx.store;
  const { token } = (await putHarnessToken(store, "minimal")) as { token: string };
  const listener = await startHarnessListener({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [],
    attach: async () => (channel, peer) => runtime.handle.attachHarness!(channel, peer),
    harnessOfToken: (bearer) => runtime.handle.harnessOfToken!(bearer),
    logger: { info() {}, warn() {} },
  });
  cleanups.push(() => listener.close());
  const example = runExample(listener.url, token, runtime.gate!.url);
  await example.start();
  cleanups.push(() => example.stop());
  return { runtime, example, token };
}

const failures = (report: ConformanceReport) =>
  report.results.filter((result) => !result.ok).map((result) => `${result.id}: ${result.detail}`);

it("passes every required check, for our harness and for the example, side by side", async () => {
  const { runtime, example, token } = await start();
  const common = { runtime: runtime.url, key: runtime.applicationKey, manageKey: runtime.managementKey };

  const minimal = await runConformance({
    ...common,
    harness: "minimal",
    restart: () => example.restart(),
    secrets: [token],
  });
  expect(failures(minimal)).toEqual([]);
  const status = Object.fromEntries(minimal.results.map((result) => [result.id, result.status]));
  expect(status).toMatchObject({ HC07: "pass", HC08: "pass", HC10: "skipped", HC15: "n/a", HC16: "n/a", HC17: "n/a" });
  for (const id of ["HC01", "HC02", "HC03", "HC04", "HC05", "HC06", "HC09", "HC11", "HC12", "HC13", "HC14", "HC18", "HC19"])
    expect(status[id], id).toBe("pass");

  // Ours serves workspaces, so its optional workspace check runs too.
  const ours = await runConformance({ ...common, harness: "nylorun", workspace: true });
  expect(failures(ours)).toEqual([]);
  const oursStatus = Object.fromEntries(ours.results.map((result) => [result.id, result.status]));
  expect(oursStatus).toMatchObject({ HC07: "skipped", HC08: "skipped", HC16: "pass", HC17: "n/a" });
  expect(ours.results.filter((result) => result.class === "required" && result.status === "pass")).toHaveLength(14 - 3 + 2);
}, 300_000);
