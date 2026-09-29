/**
 * The OpenShell backend against an in-memory gateway (no Docker): naming, labels, policy,
 * lifecycle mapping, file transfer chunking and the image check.
 */
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
  openshellBackend,
  openshellPolicy,
  sandboxNameOf,
} from "../../src/adapters/sandbox/openshell/backend.js";
import { OpenShell, SandboxPhase, ServiceStatus } from "../../src/adapters/sandbox/openshell/gen/openshell_pb.js";
import { resolveNetwork } from "../../src/sandbox/policy.js";
import type { SandboxSpec } from "../../src/sandbox/types.js";

type Stored = { name: string; labels: Record<string, string>; phase: SandboxPhase; request: any };

/** A gateway whose exec runs a scripted handler; sandboxes become Ready at once. */
function fakeGateway(options: {
  exec?: (script: string, stdin: Uint8Array) => { stdout?: string; exitCode?: number };
  /** What the backend's setup probe (`pwd` and the command check) prints. */
  setup?: string;
  healthy?: boolean;
} = {}) {
  const sandboxes = new Map<string, Stored>();
  const calls: string[] = [];
  const execs: { script: string; stdin: number; workdir: string }[] = [];
  const view = (item: Stored) => ({
    metadata: { name: item.name, labels: item.labels },
    status: { phase: item.phase, conditions: [] },
  });
  const transport = createRouterTransport(({ service }) =>
    service(OpenShell, {
      health: () => ({
        status: options.healthy === false ? ServiceStatus.UNHEALTHY : ServiceStatus.HEALTHY,
        version: "0.1.2",
      }),
      getSandbox: (request) => {
        const item = sandboxes.get(request.name);
        if (!item) throw new ConnectError("sandbox not found", Code.NotFound);
        return { sandbox: view(item) };
      },
      createSandbox: (request) => {
        calls.push(`create ${request.name}`);
        const item = { name: request.name, labels: request.labels, phase: SandboxPhase.READY, request };
        sandboxes.set(request.name, item);
        return { sandbox: view(item) };
      },
      startSandbox: (request) => {
        calls.push(`start ${request.name}`);
        sandboxes.get(request.name)!.phase = SandboxPhase.READY;
        return { sandbox: view(sandboxes.get(request.name)!) };
      },
      stopSandbox: (request) => {
        calls.push(`stop ${request.name}`);
        sandboxes.get(request.name)!.phase = SandboxPhase.STOPPED;
        return { sandbox: view(sandboxes.get(request.name)!) };
      },
      deleteSandbox: (request) => {
        calls.push(`delete ${request.name}`);
        if (!sandboxes.delete(request.name)) throw new ConnectError("sandbox not found", Code.NotFound);
        return {};
      },
      listSandboxes: () => ({ sandboxes: [...sandboxes.values()].map(view), nextPageToken: "" }),
      async *execSandbox(request) {
        const script = request.command[2] ?? "";
        execs.push({ script, stdin: request.stdin.length, workdir: request.workdir });
        const result = script.startsWith("pwd;")
          ? { stdout: options.setup ?? "/sandbox\n" }
          : (options.exec?.(script, request.stdin) ?? {});
        if (result.stdout) yield { payload: { case: "stdout", value: { data: Buffer.from(result.stdout) } } };
        yield { payload: { case: "exit", value: { exitCode: result.exitCode ?? 0 } } };
      },
    })
  );
  return { transport, sandboxes, calls, execs };
}

const spec = (overrides: Partial<SandboxSpec> = {}): SandboxSpec => ({
  key: "nylorun-tn_test-0123456789abcdef",
  cpus: 2,
  memoryMiB: 1024,
  network: resolveNetwork({ network: { preset: "none", allow: ["api.github.com", "*.pythonhosted.org"] } }),
  ...overrides,
});

describe("openshell backend", () => {
  it("names sandboxes by a short hash and keeps the key in a label", () => {
    const name = sandboxNameOf("nylorun-tn_test-0123456789abcdef");
    expect(name).toMatch(/^nl-[0-9a-f]{16}$/);
    expect(name.length).toBeLessThanOrEqual(19);
  });

  it("turns the resolved network into one rule, and none into no egress", () => {
    const policy = openshellPolicy(spec().network);
    expect(policy.networkPolicies?.nylorun?.endpoints).toEqual([
      { host: "api.github.com", ports: [443, 80] },
      { host: "*.pythonhosted.org", ports: [443, 80] },
    ]);
    expect(policy.filesystem?.readOnly).toContain("/usr");
    expect(openshellPolicy(resolveNetwork({ network: { preset: "none" } })).networkPolicies).toEqual({});
    expect(() => openshellPolicy(resolveNetwork({ network: { preset: "open" } }))).toThrow(/cannot open all egress/);
  });

  it("creates a sandbox with its policy and size, and reports the workspace", async () => {
    const gateway = fakeGateway();
    const backend = openshellBackend({ gateway: "http://gateway", transport: gateway.transport });
    const handle = await backend.open(spec());
    expect(handle).toMatchObject({ workspace: "/sandbox", created: true });
    const stored = [...gateway.sandboxes.values()][0]!;
    expect(stored.labels).toEqual({ "nylorun.key": "nylorun-tn_test-0123456789abcdef" });
    expect(stored.request.spec.template.resources).toEqual({ limits: { cpu: "2", memory: "1024Mi" } });
    expect(stored.request.spec.template.image).toBe("");
    expect(await backend.list("nylorun-tn_test-")).toEqual(["nylorun-tn_test-0123456789abcdef"]);
    expect(await backend.list("nylorun-other-")).toEqual([]);
  });

  it("starts a stopped sandbox, and replaces one in error", async () => {
    const gateway = fakeGateway();
    const backend = openshellBackend({ gateway: "http://gateway", transport: gateway.transport });
    const first = await backend.open(spec());
    await first.stop();
    const second = await backend.open(spec());
    expect(second.created).toBe(false);
    [...gateway.sandboxes.values()][0]!.phase = SandboxPhase.ERROR;
    const third = await backend.open(spec());
    expect(third.created).toBe(true);
    const name = sandboxNameOf(spec().key);
    expect(gateway.calls).toEqual([
      `create ${name}`,
      `stop ${name}`,
      `start ${name}`,
      `delete ${name}`,
      `create ${name}`,
    ]);
    await backend.remove(spec().key);
    await backend.remove(spec().key);
    expect(gateway.sandboxes.size).toBe(0);
  });

  it("writes large files in chunks and reads a missing file as undefined", async () => {
    const gateway = fakeGateway({
      exec: (script) => (script.startsWith("[ -f") ? { exitCode: 44 } : {}),
    });
    const backend = openshellBackend({ gateway: "http://gateway", transport: gateway.transport });
    const handle = await backend.open(spec());
    await handle.writeFile("/sandbox/big.txt", "x".repeat(1_200_000));
    const writes = gateway.execs.filter((item) => item.script.startsWith("cat >"));
    expect(writes.map((item) => item.script.split(" ")[1])).toEqual([">", ">>", ">>"]);
    expect(Math.max(...writes.map((item) => item.stdin))).toBeLessThanOrEqual(512 * 1024);
    expect(await handle.readFile("/sandbox/missing.txt")).toBeUndefined();
    await handle.exec({ command: "ls", cwd: "/sandbox", timeoutMs: 5_000 }, new AbortController().signal);
    expect(gateway.execs.at(-1)).toMatchObject({ script: "ls", workdir: "/sandbox" });
  });

  it("refuses an image without the commands the tools need", async () => {
    const gateway = fakeGateway({ setup: "/sandbox\nmissing:grep\nmissing:find\n" });
    const backend = openshellBackend({ gateway: "http://gateway", transport: gateway.transport });
    await expect(backend.open(spec({ image: "distroless" }))).rejects.toThrow(
      "the image distroless lacks grep, find, which the sandbox tools need"
    );
  });

  it("reports an unhealthy or unreachable gateway as unavailable", async () => {
    const unhealthy = openshellBackend({ gateway: "http://gateway", transport: fakeGateway({ healthy: false }).transport });
    expect(await unhealthy.probe()).toMatchObject({ available: false, reason: expect.stringContaining("unhealthy") });
    const healthy = openshellBackend({ gateway: "http://gateway", transport: fakeGateway().transport });
    expect(await healthy.probe()).toMatchObject({ available: true, version: "0.1.2", isolation: "container" });
    const down = openshellBackend({ gateway: "http://127.0.0.1:1" });
    expect(await down.probe()).toMatchObject({ available: false, reason: expect.stringContaining("did not answer") });
  });
});
