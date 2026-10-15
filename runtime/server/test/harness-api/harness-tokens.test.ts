/**
 * Per-harness tokens (R4.1): `nylorun-operate harness token put <id>` makes a custom harness's
 * own credential for the Harness API listener, bound to its id. A connection with it may say only
 * that id in `hello`, so one harness cannot take another's sessions; the harness token stays
 * ours, bound to `nylorun`.
 */
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { HARNESS_API_VERSION, createChannel, type HarnessChannel } from "@nylorun/core/harness-api";
import { startHarnessListener } from "../../src/harness-api/ws-server.js";
import { wsPort } from "../../src/harness/ws-port.js";
import { EXIT_REFUSED, runOperate } from "../../src/host/operate.js";
import { harnessOfToken } from "../../src/tenant/harness-tokens.js";
import { createTestSessionStore } from "../support/store.js";
import { boot, type Started } from "../host/execution-support.js";

const TOKEN = "ab".repeat(32);
const logger = { info() {}, warn() {} };

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connect(url: string, bearer: string): Promise<HarnessChannel> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${bearer}`, "nylorun-harness-api": "1" } });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("unexpected-response", (_request, response) => reject(new Error(`upgrade ${response.statusCode}`)));
    socket.once("error", reject);
  });
  const channel = createChannel(wsPort(socket), { validate: true });
  cleanups.push(() => channel.close("test over"));
  return channel;
}

const hello = (name: string) => ({ api: HARNESS_API_VERSION, name, version: "0", features: {} });

it("binds a harness's own token to its id, and the harness token to ours", async () => {
  const runtime: Started = await boot({ harness: "remote" });
  cleanups.push(() => runtime.close());
  const store = (runtime.handle as unknown as { ctx: { store: Parameters<typeof harnessOfToken>[0] } }).ctx.store;
  const acmeToken = "cd".repeat(32);
  // As `nylorun-operate harness token put` stores it: the hash only.
  const { putHarnessToken } = await import("../../src/tenant/harness-tokens.js");
  const put = await putHarnessToken(store, "acme-mini");
  expect(put).toMatchObject({ id: "acme-mini", rotated: false });
  const token = (put as { token: string }).token;
  expect(await harnessOfToken(store, token)).toBe("acme-mini");
  expect(await harnessOfToken(store, acmeToken)).toBeUndefined();

  const listener = await startHarnessListener({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [],
    token: TOKEN,
    attach: async () => (channel, peer) => runtime.handle.attachHarness!(channel, peer),
    harnessOfToken: (bearer) => harnessOfToken(store, bearer),
    logger,
  });
  cleanups.push(() => listener.close());

  const acme = await connect(listener.url, token);
  await expect(acme.request("hello", hello("nylorun"))).rejects.toMatchObject({
    code: "invalid",
    message: expect.stringContaining("for the acme-mini harness"),
  });
  await expect(acme.request("hello", hello("acme-mini"))).resolves.toMatchObject({ api: HARNESS_API_VERSION });

  const ours = await connect(listener.url, TOKEN);
  await expect(ours.request("hello", hello("acme-mini"))).rejects.toMatchObject({ code: "invalid" });
  await expect(ours.request("hello", hello("nylorun"))).resolves.toMatchObject({ api: HARNESS_API_VERSION });

  // An unknown token is refused at the upgrade.
  await expect(connect(listener.url, acmeToken)).rejects.toThrow("upgrade 401");
});

it("puts, lists, rotates and removes harness tokens with nylorun-operate", async () => {
  const store = await createTestSessionStore();
  cleanups.push(() => store.close?.());
  const { putHarnessToken, listHarnessTokens, deleteHarnessToken } = await import("../../src/tenant/harness-tokens.js");
  const first = (await putHarnessToken(store, "acme-mini")) as { token: string; rotated: boolean };
  const second = (await putHarnessToken(store, "acme-mini")) as { token: string; rotated: boolean };
  expect(second.rotated).toBe(true);
  expect(await harnessOfToken(store, first.token)).toBeUndefined();
  expect(await harnessOfToken(store, second.token)).toBe("acme-mini");
  expect((await listHarnessTokens(store)).map((token) => token.id)).toEqual(["acme-mini"]);
  expect(await putHarnessToken(store, "nylorun")).toMatchObject({ reason: "invalid_id" });
  expect(await putHarnessToken(store, "Acme")).toMatchObject({ reason: "invalid_id" });
  expect(await deleteHarnessToken(store, "acme-mini")).toBe(true);
  expect(await deleteHarnessToken(store, "acme-mini")).toBe(false);

  // The command refuses what the store refuses, before touching a database.
  const err: string[] = [];
  expect(await runOperate(["harness", "token", "put"], { env: {}, out: () => undefined, err: (line) => err.push(line) })).toBe(
    64
  );
  expect(EXIT_REFUSED).toBe(1);
});
