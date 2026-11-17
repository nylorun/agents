import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMPUTER_DISK_TOO_OLD, computerBackend } from "../../src/adapters/sandbox/computer.js";
import { localBackend } from "../../src/adapters/sandbox/local.js";
import { checkTicket, computerHandler, ComputerCommands } from "../../src/harness/computer.js";
import { computerAccess, diskBytesOf, signTicket } from "../../src/sandbox/computer.js";
import { SandboxManager, type SandboxSessionRef } from "../../src/sandbox/manager.js";
import { memorySandboxRecords } from "../../src/sandbox/records.js";
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

describe("a computer's disk operations (disk versions)", () => {
  const access = (c: { url: string; key: ReturnType<typeof keys>["privateKey"] }, url = c.url) => async () => {
    const expiresAt = Date.now() + 10 * 60_000;
    return { url, ticket: signTicket(c.key, NAME, expiresAt), expiresAt };
  };
  const ref: SandboxSessionRef = { id: "disk:computer/one", activeTurnId: null, environmentId: "computer/one" };
  const manager = (backend: ReturnType<typeof computerBackend>) =>
    new SandboxManager({
      scope: "tn_disk",
      records: memorySandboxRecords(),
      backends: [backend],
      preference: "auto",
      ephemeral: false,
      emit: async () => undefined,
    });
  /** A gateway in front of computer `c` that answers some requests itself. */
  async function gateway(c: { url: string }, answer: (path: string, body: string) => { status: number; body: unknown } | undefined) {
    const seen: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push(`${request.url} ${body}`);
      const own = answer(request.url ?? "", body);
      if (own) {
        response.writeHead(own.status, { "content-type": "application/json" });
        return void response.end(JSON.stringify(own.body));
      }
      const forwarded = await fetch(`${c.url}${request.url}`, {
        method: request.method,
        headers: { "x-nylorun-ticket": String(request.headers["x-nylorun-ticket"]), "content-type": "application/json" },
        ...(body ? { body } : {}),
      });
      response.writeHead(forwarded.status, { "content-type": forwarded.headers.get("content-type") ?? "application/json" });
      response.end(Buffer.from(await forwarded.arrayBuffer()));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }

  it("lists, reads and writes the computer's own disk, not a directory of this process", async () => {
    const c = await computer();
    mkdirSync(join(c.root, "workspace", "app"));
    writeFileSync(join(c.root, "workspace", "app", "notes.md"), "on the computer\n");
    writeFileSync(join(c.root, "harness", "volume-id"), "vol-1\n");
    const handle = await computerBackend({ open: access(c) }).open({ key: "x", cpus: 1, memoryMiB: 512, network: { preset: "none", hosts: [], suffixes: [] } });
    // No local roots to fall back to: the disk is the computer's.
    expect(handle.diskRoots).toBeUndefined();

    const sandboxes = manager(computerBackend({ open: access(c) }));
    const signal = new AbortController().signal;
    const listed = await sandboxes.disk(ref, undefined, { list: { maxEntries: 100 } }, signal);
    expect(listed).toMatchObject({ kind: "listed", truncated: false, entries: [{ path: "workspace/app/notes.md", type: "file", size: 16 }] });
    const read = await sandboxes.disk(ref, undefined, { read: { path: "workspace/app/notes.md", offset: 3, length: 100 } }, signal);
    expect(read).toEqual({ kind: "read", bytes: new Uint8Array(Buffer.from("the computer\n")), eof: true });

    // A seed: cleared (the engine's files stay), then written, on the computer.
    expect(await sandboxes.disk(ref, undefined, { clear: true }, signal)).toEqual({ kind: "done" });
    const put = await sandboxes.disk(
      ref,
      undefined,
      {
        put: [
          { path: "workspace/seeded.txt", type: "file", bytes: new TextEncoder().encode("from a "), mode: 0o640 },
          { path: "workspace/seeded.txt", type: "file", bytes: new TextEncoder().encode("version\n"), append: true, mtimeMs: 1_767_323_045_000 },
          { path: "workspace/link", type: "link", target: "seeded.txt" },
        ],
      },
      signal,
    );
    expect(put).toEqual({ kind: "done" });
    expect(readFileSync(join(c.root, "workspace", "seeded.txt"), "utf8")).toBe("from a version\n");
    expect(statSync(join(c.root, "workspace", "seeded.txt")).mode & 0o777).toBe(0o640);
    expect(existsSync(join(c.root, "workspace", "app"))).toBe(false);
    expect(readFileSync(join(c.root, "harness", "volume-id"), "utf8")).toBe("vol-1\n");
    expect(await sandboxes.disk(ref, undefined, { list: { maxEntries: 100 } }, signal)).toMatchObject({
      entries: [
        { path: "workspace/link", type: "link", target: "seeded.txt" },
        { path: "workspace/seeded.txt", type: "file", size: 15, mode: 0o640, mtimeMs: 1_767_323_045_000 },
      ],
    });
    await expect(sandboxes.disk(ref, undefined, { read: { path: "workspace/../etc/passwd", offset: 0, length: 1 } }, signal)).rejects.toThrow(
      "workspace/../etc/passwd is not a plain relative path",
    );
  });

  it("fails clearly on a computer whose agent has no disk route, copying nothing", async () => {
    const c = await computer();
    const old = await gateway(c, (path) => (path === "/v1/disk" ? { status: 404, body: { error: { code: "not_found", message: "No route POST /v1/disk" } } } : undefined));
    const sandboxes = manager(computerBackend({ open: access(c, old.url) }));
    const answer = await sandboxes.disk(ref, undefined, { list: { maxEntries: 10 } }, new AbortController().signal);
    expect(answer).toEqual({ kind: "failed", code: "sandbox.unsupported", message: COMPUTER_DISK_TOO_OLD });
  });

  it("asks a dropped operation again, but an append only after a refused ticket", async () => {
    const c = await computer();
    let drops = 1;
    const flaky = await gateway(c, (path) =>
      path === "/v1/disk" && drops-- > 0 ? { status: 502, body: { error: { code: "computer_unreachable", message: "The computer can't be reached" } } } : undefined,
    );
    const handle = await computerBackend({ open: access(c, flaky.url), retryMs: 5_000 }).open({ key: "x", cpus: 1, memoryMiB: 512, network: { preset: "none", hosts: [], suffixes: [] } });
    const signal = new AbortController().signal;
    expect(await handle.diskOp!({ put: [{ path: "workspace/a.txt", type: "file", bytes: new TextEncoder().encode("a") }] }, signal)).toEqual({ kind: "done" });
    expect(flaky.seen.length).toBe(2);
    drops = 1;
    await expect(
      handle.diskOp!({ put: [{ path: "workspace/a.txt", type: "file", bytes: new TextEncoder().encode("b"), append: true }] }, signal),
    ).rejects.toMatchObject({ status: 502 });
    expect(flaky.seen.length).toBe(3);
    expect(readFileSync(join(c.root, "workspace", "a.txt"), "utf8")).toBe("a");
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

describe("the disk measure before an idle suspend", () => {
  it("sums what du -sk printed, in bytes, and answers nothing for no size", () => {
    expect(diskBytesOf("12\t/workspace\n4\t/skills\n")).toBe(16 * 1024);
    // No /skills: du fails, and the size it printed stands.
    expect(diskBytesOf("2048\t/workspace\n")).toBe(2048 * 1024);
    expect(diskBytesOf("")).toBeUndefined();
    expect(diskBytesOf("du: cannot access '/workspace': No such file or directory\n")).toBeUndefined();
  });
});
