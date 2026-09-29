import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runStackCommand } from "../../src/stack/commands.js";
import { parseEnvLines } from "../../src/stack/env-file.js";
import { renderGatewayConfig } from "../../src/stack/openshell.js";
import { stackPaths } from "../../src/stack/paths.js";
import { fakeDocker, fakeFetch, json, temporaryHome, testDeps } from "./support.js";

function hostId(home: string): string {
  return JSON.parse(readFileSync(stackPaths(home).config, "utf8")).hostId;
}

/** A stack whose Runtime is healthy and whose OpenShell gateway answers /healthz. */
function healthy(home: string, gatewayUp = true) {
  return fakeFetch((url) => {
    if (url.endsWith("/healthz")) return gatewayUp ? new Response("ok") : undefined;
    if (url.endsWith("/health")) return json({ status: "ok", version: "0.10.0-beta", hostId: hostId(home) });
    if (url.endsWith("/v1/admin/status")) return json({ tenants: [{ id: "a" }] });
    return undefined;
  });
}

const compose = (home: string) => [
  "compose",
  "--project-name",
  "nylorun",
  "--file",
  join(stackPaths(home).stack, "compose.yaml"),
  "--env-file",
  join(stackPaths(home).stack, ".env"),
];

describe("nylorun start --sandbox openshell", () => {
  it("starts the gateway first, waits for it, and points the Runtime at it", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, fetch: healthy(home) });
    expect(await runStackCommand("start", ["--no-studio", "--sandbox", "openshell"], deps)).toBe(0);
    expect(docker.streamed[0]).toEqual([...compose(home), "up", "--detach", "openshell-gateway"]);
    expect(docker.streamed[1]).toEqual([
      ...compose(home),
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "300",
      "postgres",
      "restate",
      "s2",
      "runtime",
    ]);
    const env = parseEnvLines(readFileSync(stackPaths(home).env, "utf8"));
    expect(env.get("NYLORUN_STACK_SANDBOX")).toBe("openshell");
    expect(env.get("COMPOSE_PROFILES")).toBe("openshell");
    expect(env.get("NYLORUN_OPENSHELL_GATEWAY")).toBe("http://openshell-gateway:18080");
    expect(env.get("NYLORUN_OPENSHELL_TELEMETRY")).toBe("true");
    expect(deps.errors.some((line) => line.includes("anonymous usage counts to NVIDIA"))).toBe(true);
    const paths = stackPaths(home);
    expect(readFileSync(paths.openshellConfig, "utf8")).toBe(renderGatewayConfig("nylorun"));
    expect(statSync(join(paths.openshellJwt, "signing.pem")).mode & 0o777).toBe(0o600);
    expect(existsSync(paths.openshellData)).toBe(true);
  });

  it("keeps the choice for later starts, and turns telemetry off on request", async () => {
    const home = await temporaryHome();
    const deps = testDeps(home, { fetch: healthy(home) });
    await runStackCommand("start", ["--no-studio", "--sandbox", "openshell"], deps);
    const key = readFileSync(join(stackPaths(home).openshellJwt, "signing.pem"), "utf8");
    deps.errors.length = 0;
    await runStackCommand("start", ["--no-studio", "--openshell-telemetry", "off"], deps);
    const env = parseEnvLines(readFileSync(stackPaths(home).env, "utf8"));
    expect(env.get("NYLORUN_STACK_SANDBOX")).toBe("openshell");
    expect(env.get("NYLORUN_OPENSHELL_TELEMETRY")).toBe("false");
    expect(deps.errors.some((line) => line.includes("anonymous usage counts"))).toBe(false);
    // The signing key is created once.
    expect(readFileSync(join(stackPaths(home).openshellJwt, "signing.pem"), "utf8")).toBe(key);
  });

  it("stops the gateway when switched back to virtual", async () => {
    const home = await temporaryHome();
    const docker = fakeDocker();
    const deps = testDeps(home, { docker, fetch: healthy(home) });
    await runStackCommand("start", ["--no-studio", "--sandbox", "openshell"], deps);
    docker.calls.length = 0;
    await runStackCommand("start", ["--no-studio", "--sandbox", "virtual"], deps);
    expect(docker.calls).toContainEqual([
      ...compose(home),
      "--profile",
      "openshell",
      "rm",
      "--stop",
      "--force",
      "openshell-gateway",
    ]);
    const env = parseEnvLines(readFileSync(stackPaths(home).env, "utf8"));
    expect(env.get("COMPOSE_PROFILES")).toBe("");
    expect(env.get("NYLORUN_OPENSHELL_GATEWAY")).toBe("");
  });

  it("reset removes this project's sandbox containers and volumes", async () => {
    const home = await temporaryHome();
    const namespace = "label=openshell.ai/sandbox-namespace=nylorun";
    const docker = fakeDocker({
      respond: (args) =>
        args.includes(namespace)
          ? { code: 0, stdout: args[0] === "ps" ? "c1\nc2\n" : "v1\n", stderr: "" }
          : undefined,
    });
    const deps = testDeps(home, { docker, fetch: healthy(home) });
    await runStackCommand("start", ["--no-studio", "--sandbox", "openshell"], deps);
    docker.calls.length = 0;
    expect(await runStackCommand("reset", ["--yes"], deps)).toBe(0);
    expect(docker.calls).toContainEqual(["rm", "--force", "c1", "c2"]);
    expect(docker.calls).toContainEqual(["volume", "rm", "--force", "v1"]);
    expect(existsSync(stackPaths(home).openshellData)).toBe(false);
  });

  it("fails with the logs command when the gateway never becomes healthy", async () => {
    const home = await temporaryHome();
    const deps = testDeps(home, { fetch: healthy(home, false) });
    await expect(runStackCommand("start", ["--no-studio", "--sandbox", "openshell"], deps)).rejects.toThrow(
      /OpenShell gateway is not healthy on 127\.0\.0\.1:18081.*nylorun logs openshell-gateway/
    );
  });

  it("refuses unknown values", async () => {
    const home = await temporaryHome();
    const deps = testDeps(home);
    await expect(runStackCommand("start", ["--sandbox", "vm"], deps)).rejects.toThrow(
      "--sandbox must be virtual or openshell, not vm"
    );
    await expect(runStackCommand("start", ["--openshell-telemetry", "maybe"], deps)).rejects.toThrow(
      "--openshell-telemetry must be on or off, not maybe"
    );
  });
});
