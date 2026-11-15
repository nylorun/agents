import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computerBackend } from "../../src/adapters/sandbox/computer.js";
import { localBackend } from "../../src/adapters/sandbox/local.js";
import { checkTicket, computerHandler, ComputerCommands } from "../../src/harness/computer.js";
import { computerAccess, signTicket } from "../../src/sandbox/computer.js";
import type { TenantContext } from "../../src/tenant/context.js";
import type { SandboxHandle } from "../../src/sandbox/types.js";

const NAME = "sbx-ub6g5m7mvjlct6r7-g0";
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

function keys() {
  return generateKeyPairSync("ed25519");
}

async function computer(): Promise<{ url: string; key: ReturnType<typeof keys>["privateKey"]; handle: SandboxHandle; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "computer-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  mkdirSync(join(root, "harness"));
  const { publicKey, privateKey } = keys();
  const handle = await localBackend({ env: { PATH: process.env.PATH }, workspace, harnessRoot: join(root, "harness"), shell: "/bin/sh" }).open({
    key: "computer",
    cpus: 1,
    memoryMiB: 512,
    network: { preset: "none", hosts: [], suffixes: [] },
  });
  const server = createServer((request, response) =>
    void computerHandler({ handle, key: publicKey, name: NAME, ready: () => true })(request, response),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, key: privateKey, handle, root };
}

describe("computer tickets", () => {
  it("holds for its computer until it expires", () => {
    const { publicKey, privateKey } = keys();
    const now = Date.now();
    const token = signTicket(privateKey, NAME, now + 60_000);
    expect(checkTicket(token, publicKey, NAME, now)).toEqual({ ok: true });
    expect(checkTicket(token, publicKey, "sbx-aaaaaaaaaaaaaaaa-g0", now)).toEqual({ ok: false, reason: "subject" });
    expect(checkTicket(token, publicKey, NAME, now + 61_000)).toEqual({ ok: false, reason: "expired" });
    expect(checkTicket(token, keys().publicKey, NAME, now)).toEqual({ ok: false, reason: "signature" });
    expect(checkTicket(undefined, publicKey, NAME, now)).toEqual({ ok: false, reason: "no ticket" });
  });
});

describe("computer commands", () => {
  it("answers running, then the result on attach; a repeated start joins the command", async () => {
    let finish!: (value: { exitCode: number; stdout: string; stderr: string; killed: boolean; timedOut: boolean }) => void;
    let calls = 0;
    const commands = new ComputerCommands({
      exec: () => {
        calls += 1;
        return new Promise((resolve) => (finish = resolve));
      },
    });
    const request = { id: "c1", command: "sleep 1", cwd: "/", timeoutMs: 5_000, waitMs: 10 };
    expect(await commands.start(request)).toEqual({ state: "running" });
    expect(await commands.start(request)).toEqual({ state: "running" });
    expect(calls).toBe(1);
    finish({ exitCode: 0, stdout: "ok", stderr: "", killed: false, timedOut: false });
    expect(await commands.attach("c1", 1_000)).toMatchObject({ state: "done", result: { stdout: "ok" } });
    expect(commands.attach("unknown")).toBeUndefined();
  });
});

describe("the computer backend through the computer's routes", () => {
  it("runs commands and moves files with a ticket", async () => {
    const c = await computer();
    let opened = 0;
    const backend = computerBackend({
      open: async () => {
        opened += 1;
        const expiresAt = Date.now() + 10 * 60_000;
        return { url: c.url, ticket: signTicket(c.key, NAME, expiresAt), expiresAt };
      },
    });
    const handle = await backend.open({ key: "x", cpus: 1, memoryMiB: 512, network: { preset: "none", hosts: [], suffixes: [] } });
    const result = await handle.exec({ command: "echo hello; echo oops >&2; exit 3", cwd: c.handle.workspace!, timeoutMs: 10_000 }, new AbortController().signal);
    expect(result).toMatchObject({ exitCode: 3, stdout: "hello\n", stderr: "oops\n" });
    const file = join(c.handle.workspace!, "a.txt");
    await handle.writeFile(file, "contents");
    expect(await handle.readFile(file)).toBe("contents");
    expect(await handle.readFile(join(c.handle.workspace!, "missing"))).toBeUndefined();
    await expect(handle.readBytes!(file, 2)).rejects.toThrow(/bytes/);
    const listed = await handle.listFiles!(c.handle.workspace!, 100);
    expect(listed?.entries.map((entry) => entry.path)).toEqual(["a.txt"]);
    expect(opened).toBe(1);
  });

  it("refuses a request without the computer's ticket", async () => {
    const c = await computer();
    const answer = await fetch(`${c.url}/v1/info`, { headers: { "x-nylorun-ticket": signTicket(c.key, "sbx-aaaaaaaaaaaaaaaa-g0", Date.now() + 60_000) } });
    expect(answer.status).toBe(401);
    const ready = await fetch(`${c.url}/ready`);
    expect(ready.status).toBe(200);
  });

  it("asks for a new ticket once the computer refuses one", async () => {
    const c = await computer();
    let opened = 0;
    const backend = computerBackend({
      open: async () => {
        opened += 1;
        // The first ticket is another computer's: refused, then asked for again.
        const subject = opened === 1 ? "sbx-aaaaaaaaaaaaaaaa-g0" : NAME;
        const expiresAt = Date.now() + 10 * 60_000;
        return { url: c.url, ticket: signTicket(c.key, subject, expiresAt), expiresAt };
      },
      retryMs: 5_000,
    });
    const handle = await backend.open({ key: "x", cpus: 1, memoryMiB: 512, network: { preset: "none", hosts: [], suffixes: [] } });
    const result = await handle.exec({ command: "echo again", cwd: c.handle.workspace!, timeoutMs: 10_000 }, new AbortController().signal);
    expect(result.stdout).toBe("again\n");
    expect(opened).toBe(2);
  });
});

describe("computer access", () => {
  // A Tenant with one running computer whose service reports `drainedAt`.
  const context = (recorded: string | undefined, reported: string | undefined) => {
    const pod = { desired: "running", observed: "running", k8sName: NAME, hostEpoch: 1, podUid: "uid-1", rev: 1, drainedAt: recorded };
    const signals: unknown[] = [];
    const t = {
      environment: async () => ({ id: "local/probe", pod }),
      updateEnvironmentPod: async () => undefined,
      agentEvent: async () => undefined,
    };
    const ctx = {
      store: { tx: async (fn: (tx: typeof t) => unknown) => fn(t) },
      pods: {
        client: { status: async () => ({ ready: true, podUID: "uid-1", ...(reported ? { drainedAt: reported } : {}) }) },
        computer: { gatewayUrl: "http://sandbox-gateway:4400", ticketKey: keys().privateKey, ttlMs: 600_000 },
      },
      sandboxSignal: async (id: string, signal: unknown) => void signals.push({ id, signal }),
    } as unknown as TenantContext;
    return { ctx, signals };
  };

  it("asks the reconcile to record a drain it hasn't yet", async () => {
    const { ctx, signals } = context(undefined, "2026-11-15T16:54:40Z");
    const access = await computerAccess(ctx, "local/probe");
    expect(access.url).toBe(`http://sandbox-gateway:4400/${NAME}`);
    expect(signals).toEqual([{ id: "local/probe", signal: { kind: "reconcile" } }]);
  });

  it("leaves a recorded drain, and no drain, alone", async () => {
    for (const [recorded, reported] of [["2026-11-15T16:54:40Z", "2026-11-15T16:54:40Z"], [undefined, undefined]] as const) {
      const { ctx, signals } = context(recorded, reported);
      await computerAccess(ctx, "local/probe");
      expect(signals).toEqual([]);
    }
  });
});
