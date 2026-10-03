import { existsSync, readFileSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clusterFilePath, readClusterFile, sandboxesDir } from "../../src/sandbox/cluster-file.js";
import { runSandboxCommand } from "../../src/sandbox/commands.js";
import { renderComposeFile } from "../../src/stack/compose-file.js";
import { parsePersisted, renderEnvFile, type StackEnv } from "../../src/stack/env-file.js";
import { stackImages } from "../../src/stack/images.js";
import { stackPaths } from "../../src/stack/paths.js";
import { prepareStack, readStackEnv } from "../../src/stack/prepare.js";
import { fakeDocker, fakeFetch, fakePorts, json, temporaryHome, testDeps } from "../stack/support.js";
import { healthyCluster } from "./support.js";

const images = stackImages({}, { runtime: "0.10.0-beta", studio: "0.9.0-beta" });

/** A Tenant that `nylorun start` prepared under `home`. */
async function startedTenant(home: string) {
  await prepareStack({
    paths: stackPaths(home),
    name: "home-root",
    project: "nylorun-home-root",
    images,
    uid: 1001,
    gid: 1002,
    runtimeVersion: "0.10.0-beta",
    ports: fakePorts(),
  });
}

function setup(home: string) {
  const docker = fakeDocker();
  const hostId = () => (JSON.parse(readFileSync(stackPaths(home).config, "utf8")) as { hostId: string }).hostId;
  const fetch = fakeFetch((url) =>
    url.endsWith("/health") ? json({ status: "ok", version: "0.10.0-beta", hostId: hostId() }) : undefined,
  );
  const kubectl = healthyCluster();
  const stack = testDeps(home, { docker, fetch });
  return { stack, docker, kubectl, deps: { stack, kubectl, pollMs: 1, policyTimeoutMs: 50 } };
}

describe("nylorun sandbox", () => {
  it("needs --context and a context from the kubeconfig", async () => {
    const home = await temporaryHome();
    await startedTenant(home);
    const { deps } = setup(home);
    await expect(runSandboxCommand(["enable"], deps)).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(/needs --context <name>/),
    });
    await expect(runSandboxCommand(["enable", "--context", "prod"], deps)).rejects.toThrow(
      /Context prod is not in your kubeconfig. Contexts: docker-desktop, kind-nylorun/,
    );
    await expect(runSandboxCommand(["enable", "--context", "docker-desktop", "--host-address", "host"], deps)).rejects.toThrow(
      /--host-address must be an IPv4 address/,
    );
    await expect(runSandboxCommand(["frobnicate"], deps)).rejects.toMatchObject({ exitCode: 2 });
  });

  it("enable records the cluster, adds the service to the Tenant and waits for it", async () => {
    const home = await temporaryHome();
    await startedTenant(home);
    const { deps, docker, stack } = setup(home);
    expect(await runSandboxCommand(["enable", "--context", "docker-desktop"], deps)).toBe(0);

    const root = stackPaths(home).root;
    const cluster = await readClusterFile(root);
    expect(cluster).toMatchObject({ context: "docker-desktop", namespace: "nylorun-sbx-home-root", hostAddress: "192.168.65.254" });
    expect((await stat(sandboxesDir(root))).mode & 0o777).toBe(0o700);
    expect((await stat(join(sandboxesDir(root), "token"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(sandboxesDir(root), "token"), "utf8")).toBe("sa-token");

    const persisted = await readStackEnv(stackPaths(home));
    expect(persisted?.sandboxes).toMatchObject({
      image: images.sandboxes,
      harnessPort: 8790,
      gatesPort: 8791,
      egressPort: 8792,
      hostAddress: "192.168.65.254",
      bind: "127.0.0.1",
    });
    expect(persisted?.sandboxes?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(stackPaths(home).compose, "utf8")).toBe(
      renderComposeFile("nylorun-home-root", "home-root", { sandboxes: true }),
    );
    const streamed = docker.streamed.map((args) => args.slice(7).join(" "));
    expect(streamed).toContain("up --detach sandboxes");
    expect(streamed).toContain("up --detach --wait --wait-timeout 120 sandboxes");
    expect(stack.errors.some((line) => line.includes("could not pre-pull ghcr.io/nylorun/runtime:0.10.0-beta"))).toBe(true);
    expect(stack.lines[0]).toMatch(/^Sandboxes home-root {2}enabled on docker-desktop/);

    // `nylorun start` keeps the settings while cluster.json exists, and drops them without it.
    const keep = await prepareStack({
      paths: stackPaths(home), name: "home-root", project: "nylorun-home-root", images,
      uid: 1001, gid: 1002, runtimeVersion: undefined, ports: fakePorts(),
    });
    expect(keep.env.sandboxes?.token).toBe(persisted?.sandboxes?.token);
    await rm(clusterFilePath(root));
    const dropped = await prepareStack({
      paths: stackPaths(home), name: "home-root", project: "nylorun-home-root", images,
      uid: 1001, gid: 1002, runtimeVersion: undefined, ports: fakePorts(),
    });
    expect(dropped.env.sandboxes).toBeUndefined();
    expect(await readFile(stackPaths(home).compose, "utf8")).not.toContain("sandboxes:");
  });

  it("disable removes the service and the cluster files, keeping the namespace", async () => {
    const home = await temporaryHome();
    await startedTenant(home);
    const { deps, docker, stack, kubectl } = setup(home);
    await runSandboxCommand(["enable", "--context", "docker-desktop", "--no-pull"], deps);
    expect(kubectl.calls.some((c) => c.args.includes("nodes"))).toBe(false);
    stack.lines.length = 0;

    expect(await runSandboxCommand(["disable"], deps)).toBe(0);
    expect(docker.calls.map((args) => args.slice(7).join(" "))).toContain("rm --stop --force sandboxes");
    expect(existsSync(sandboxesDir(stackPaths(home).root))).toBe(false);
    expect((await readStackEnv(stackPaths(home)))?.sandboxes).toBeUndefined();
    expect(await readFile(stackPaths(home).compose, "utf8")).not.toContain("sandboxes:");
    expect(stack.lines.join("\n")).toMatch(/Namespace nylorun-sbx-home-root in docker-desktop is kept/);
    expect(kubectl.calls.some((c) => c.args.includes("delete") && c.args.includes("nylorun-sbx-home-root"))).toBe(false);

    expect(await runSandboxCommand(["disable"], deps)).toBe(0);
    expect(stack.lines.at(-1)).toBe("Sandboxes are not enabled for Tenant home-root.");
  });

  it("status reports the recorded cluster and the service's readiness", async () => {
    const home = await temporaryHome();
    await startedTenant(home);
    const { deps, stack } = setup(home);
    expect(await runSandboxCommand(["status", "--json"], deps)).toBe(3);
    expect(JSON.parse(stack.lines.at(-1)!)).toEqual({ enabled: false });

    await runSandboxCommand(["enable", "--context", "docker-desktop", "--no-pull"], deps);
    const info = { namespace: "nylorun-sbx-home-root", apiVersion: "agents.x-k8s.io/v1beta1" };
    deps.stack.docker = fakeDocker({
      respond: (args) =>
        args.includes("node") ? { code: 0, stdout: JSON.stringify(info), stderr: "" } : undefined,
    });
    stack.lines.length = 0;
    expect(await runSandboxCommand(["status", "--json"], deps)).toBe(0);
    const report = JSON.parse(stack.lines.join("\n")) as Record<string, unknown>;
    expect(report).toMatchObject({ enabled: true, ready: true, info, cluster: { context: "docker-desktop" } });
    expect(report.cluster).not.toHaveProperty("caData");
  });
});

describe(".env and compose.yaml with sandboxes", () => {
  const env: StackEnv = {
    runtimePort: 8787, adminPort: 8788, studioPort: 4161, restatePort: 9070,
    postgresPassword: "0123456789abcdef0123456789abcdef", gatesToken: "ab".repeat(32),
    restateIdentityKey: "publickeyv1_x", uid: 501, gid: 20, hostRoot: "/h", runtimeImage: "r",
    studioImage: "s", studioFrameAncestors: "", studioAnalyticsId: "", tenantName: "shop",
    derivedPrincipals: "project",
  };
  const sandboxes = {
    token: "cd".repeat(32), image: "ghcr.io/nylorun/sandboxes:0.10.0-beta", harnessPort: 8790,
    gatesPort: 8791, egressPort: 8792, hostAddress: "172.17.0.1", bind: "172.17.0.1",
  };

  it("round-trips the sandboxes section and omits it when disabled", () => {
    expect(parsePersisted(renderEnvFile({ ...env, sandboxes })).sandboxes).toEqual(sandboxes);
    expect(renderEnvFile(env)).not.toContain("SANDBOX");
    expect(parsePersisted(renderEnvFile({ ...env, sandboxes: { ...sandboxes, hostAddress: "x" } })).sandboxes).toBeUndefined();
  });

  it("adds the service, the runtime's URL and token, and hides the credentials from the runtime", () => {
    const plain = renderComposeFile("nylorun-shop", "shop");
    const compose = renderComposeFile("nylorun-shop", "shop", { sandboxes: true });
    expect(plain).not.toMatch(/sandboxes/i);
    const service = compose.slice(compose.indexOf("  sandboxes:"), compose.indexOf("networks:"));
    expect(service).toContain("container_name: nylorun-shop-sandboxes");
    expect(service).toContain("${NYLORUN_HOST_ROOT:?run nylorun start}/sandboxes:/run/nylorun/sandboxes:ro");
    expect(service).toContain('test: ["CMD", "/sandboxes", "healthcheck"]');
    expect(service).not.toMatch(/ports:|docker\.sock/);
    const runtime = compose.slice(compose.indexOf("  runtime:"), compose.indexOf("  studio:"));
    expect(runtime).toContain("NYLORUN_SANDBOXES_URL: http://sandboxes:4300");
    expect(runtime).toContain("target: /nylorun/sandboxes");
    const gateway = compose.slice(compose.indexOf("  gateway:"), compose.indexOf("  runtime:"));
    expect(gateway).not.toContain("sandboxes");
  });
});
