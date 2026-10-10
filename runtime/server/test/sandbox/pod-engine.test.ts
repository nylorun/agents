/**
 * The engine's side of a pod sandbox (F7.2): it stays off the network until a known-blocked
 * address refuses (the NetworkPolicy is in force), and its `local` backend runs commands in the
 * pod's workspace with the egress proxy and none of the engine's own variables.
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { rootCertificates } from "node:tls";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localBackend } from "../../src/adapters/sandbox/local.js";
import { podHost } from "../../src/harness/pod.js";
import { createCertificateAuthority } from "../../src/keys/x509.js";
import { awaitNetworkPolicy, blockedAddresses } from "../../src/sandbox/pods/network-gate.js";
import { runSandboxTool } from "../../src/sandbox/tools.js";
import { resolveNetwork } from "../../src/sandbox/policy.js";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function listening(): Promise<Server & { port: number }> {
  const server = createServer((socket) => socket.end());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return Object.assign(server, { port: (server.address() as { port: number }).port });
}

describe("the network gate", () => {
  it("probes the API server's service address by default", () => {
    expect(blockedAddresses({ KUBERNETES_SERVICE_HOST: "10.96.0.1", KUBERNETES_SERVICE_PORT: "443" })).toEqual([
      { host: "10.96.0.1", port: 443 },
    ]);
    expect(blockedAddresses({})).toEqual([{ host: "10.96.0.1", port: 443 }]);
  });

  it("waits while a blocked address still answers, and passes once it refuses", async () => {
    const server = await listening();
    const logs: unknown[] = [];
    const gate = awaitNetworkPolicy({
      addresses: [{ host: "127.0.0.1", port: server.port }],
      attemptMs: 200,
      pauseMs: 50,
      timeoutMs: 10_000,
      log: (_message, fields) => logs.push(fields),
    });
    let passed = false;
    void gate.then(() => (passed = true));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(passed).toBe(false);
    // The policy comes into force: the address no longer answers.
    await new Promise((resolve) => server.close(resolve));
    servers.splice(0);
    const { waitedMs } = await gate;
    expect(waitedMs).toBeGreaterThanOrEqual(400);
    expect(logs[0]).toMatchObject({ address: `127.0.0.1:${server.port}` });
    expect((logs[0] as { openedBefore: number }).openedBefore).toBeGreaterThan(0);
  });

  it("gives up while the policy is never in force", async () => {
    const server = await listening();
    await expect(
      awaitNetworkPolicy({ addresses: [{ host: "127.0.0.1", port: server.port }], attemptMs: 100, pauseMs: 20, timeoutMs: 300 }),
    ).rejects.toThrow(/NetworkPolicy is not in force/);
  });
});

describe("the local backend", () => {
  it("runs the sandbox tools in the workspace with the proxy and without the engine's variables", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "nylorun-local-")));
    dirs.push(workspace);
    const backend = localBackend({
      workspace,
      env: { PATH: process.env.PATH, NYLORUN_SANDBOX_JOIN_FILE: "/run/nylorun/join/token", HTTPS_PROXY: "http://stale" },
      proxyEnv: () => ({ HTTPS_PROXY: "http://nylorun:tok@egress:4200" }),
    });
    expect((await backend.probe()).available).toBe(true);
    const handle = await backend.open({ key: "k", cpus: 1, memoryMiB: 128, network: resolveNetwork(undefined) });
    const signal = new AbortController().signal;
    const run = (name: "bash" | "write" | "read" | "glob", input: Record<string, unknown>) =>
      runSandboxTool(handle, name, input, signal, () => undefined);
    expect(await run("write", { path: "notes/a.txt", content: "hello" })).toMatchObject({ kind: "completed" });
    expect(await readFile(join(workspace, "notes/a.txt"), "utf8")).toBe("hello");
    const env = await run("bash", { command: "pwd; echo $HTTPS_PROXY; echo [$NYLORUN_SANDBOX_JOIN_FILE]" });
    expect(env).toMatchObject({ kind: "completed", output: { exitCode: 0, stdout: `${workspace}\nhttp://nylorun:tok@egress:4200\n[]\n` } });
    expect(await run("read", { path: "notes/a.txt" })).toMatchObject({ kind: "completed", output: "1\thello" });
    expect(JSON.stringify(await run("glob", { pattern: "*.txt" }))).toContain("notes/a.txt");
    const slow = await run("bash", { command: "sleep 5; echo never", timeout: 0.3 });
    expect(slow).toMatchObject({ kind: "completed", output: { exitCode: 124, timedOut: true } });
    expect(await handle.readFile(join(workspace, "missing"))).toBeUndefined();
  });
});

describe("credentials for skills in a pod (R2c)", () => {
  it("gives every command the session's variables, and the proxy wins over them", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "nylorun-local-")));
    dirs.push(workspace);
    const backend = localBackend({
      workspace,
      env: { PATH: process.env.PATH },
      proxyEnv: () => ({ HTTPS_PROXY: "http://nylorun:tok@egress:4200" }),
    });
    const handle = await backend.open({ key: "k", cpus: 1, memoryMiB: 128, network: resolveNetwork(undefined) });
    const result = await runSandboxTool(
      handle,
      "bash",
      { command: "echo $GH_TOKEN $REGION $HTTPS_PROXY" },
      new AbortController().signal,
      () => undefined,
      { GH_TOKEN: "nylorun-managed", REGION: "eu-west-1", HTTPS_PROXY: "http://elsewhere" },
    );
    expect(result).toMatchObject({
      kind: "completed",
      output: { exitCode: 0, stdout: "nylorun-managed eu-west-1 http://nylorun:tok@egress:4200\n" },
    });
  });

  it("writes the public roots and the egress CA to a bundle every CLI is pointed at", async () => {
    const root = await mkdtemp(join(tmpdir(), "nylorun-pod-"));
    dirs.push(root);
    const joinFile = join(root, "join");
    await writeFile(joinFile, "join-token\n");
    const ca = createCertificateAuthority({ commonName: "Nylorun egress CA (test)" }).certificate;
    const answer = { hostToken: "h", egressToken: "e", epoch: 1, expiresAt: new Date(Date.now() + 900_000).toISOString(), caCertificate: ca };
    const caBundleFile = join(root, "egress-ca-bundle.pem");
    const host = podHost(
      { sandboxId: "sbx_1", podUid: "uid-1", joinFile, httpUrl: "http://listener", egressProxy: "http://egress:4200", blocked: [] },
      { info: () => undefined, warn: () => undefined },
      { fetch: async () => new Response(JSON.stringify(answer)), caBundleFile },
    );
    try {
      expect(host.proxyEnv()).toEqual({});
      await host.token();
      const bundle = await readFile(caBundleFile, "utf8");
      expect(bundle.startsWith(rootCertificates[0]!)).toBe(true);
      expect(bundle.trimEnd().endsWith(ca.trim())).toBe(true);
      const env = host.proxyEnv();
      for (const name of ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "AWS_CA_BUNDLE"])
        expect(env[name]).toBe(caBundleFile);
      expect(env.HTTPS_PROXY).toBe("http://nylorun:e@egress:4200");
    } finally {
      host.stop();
    }
  });
});
