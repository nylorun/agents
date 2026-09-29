/**
 * OpenShell backend: sandboxes provisioned by an OpenShell gateway (Docker, Podman, Kubernetes or
 * microVM, whichever driver the gateway runs). The gateway's supervisor enforces the network
 * policy outside the sandbox. This file and `./gen/` are the only code that speaks OpenShell's API
 * (Sandboxes v3 §7).
 */
import { createHash } from "node:crypto";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client, type Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { OpenShell, SandboxPhase, ServiceStatus, type Sandbox } from "./gen/openshell_pb.js";
import type { SandboxPolicySchema } from "./gen/sandbox_pb.js";
import type {
  ExecRequest,
  ExecResult,
  ResolvedNetwork,
  SandboxBackend,
  SandboxHandle,
  SandboxProbe,
  SandboxSpec,
} from "../../../sandbox/types.js";

export interface OpenShellBackendOptions {
  /** Gateway URL, for example `http://127.0.0.1:8080`. */
  readonly gateway: string;
  /** OpenShell workspace the Runtime's sandboxes live in. Default `default`. */
  readonly workspace?: string;
  /** Replaces the gRPC transport, for tests. */
  readonly transport?: Transport;
  /** How long to wait for a sandbox to become ready. Default 5 minutes. */
  readonly readyTimeoutMs?: number;
}

/** The OpenShell release `./gen/` was generated from (scripts/openshell-client.mjs). */
export const OPENSHELL_VERSION = "0.1.2";
/** OpenShell's workspace on its Docker, Podman and Kubernetes drivers. */
export const OPENSHELL_WORKSPACE = "/sandbox";
/** Stdin per exec request stays under the gateway's 1 MiB gRPC message limit. */
const WRITE_CHUNK_BYTES = 512 * 1024;
/** The sandbox tools run these commands; an image without them cannot serve the tools. */
const REQUIRED_COMMANDS = ["grep", "find", "head", "cat", "mkdir"] as const;
const KEY_LABEL = "nylorun.key";
const MISSING = 44;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * OpenShell sandbox names are short DNS labels (at most 19 characters in 0.1.2), so a sandbox is
 * named by a hash of the Runtime's key; the key itself travels in the `nylorun.key` label.
 */
export function sandboxNameOf(key: string): string {
  return `nl-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/**
 * OpenShell's default filesystem access (docs: "Default Policy"), stated explicitly: a policy
 * without network rules would otherwise get only the workspace, not the system paths.
 */
const FILESYSTEM = {
  includeWorkdir: true,
  readOnly: ["/bin", "/usr", "/lib", "/proc", "/dev/urandom", "/etc", "/var/log"],
  readWrite: ["/tmp", "/dev/null"],
};

/** One network rule for every program: the resolved hosts, on ports 80 and 443. */
export function openshellPolicy(network: ResolvedNetwork): MessageInitShape<typeof SandboxPolicySchema> {
  if (network.preset === "open")
    throw new Error("the openshell backend cannot open all egress; list hosts in network.allow");
  const hosts = [...network.hosts, ...network.suffixes.map((suffix) => `*${suffix}`)];
  return {
    version: 1,
    filesystem: FILESYSTEM,
    landlock: { compatibility: "best_effort" },
    networkPolicies:
      hosts.length === 0
        ? {}
        : ({
            nylorun: {
              name: "nylorun",
              endpoints: hosts.map((host) => ({ host, ports: [443, 80] })),
              binaries: [{ path: "/**" }],
            },
          }),
  };
}

export function openshellBackend(options: OpenShellBackendOptions): SandboxBackend {
  let client: Client<typeof OpenShell> | undefined;
  const rpc = () =>
    (client ??= createClient(
      OpenShell,
      options.transport ?? createGrpcTransport({ baseUrl: options.gateway })
    ));
  const workspaceScope = {
    selection: { case: "workspace" as const, value: options.workspace ?? "default" },
  };
  const readyTimeoutMs = options.readyTimeoutMs ?? 5 * 60_000;

  async function get(name: string): Promise<Sandbox | undefined> {
    try {
      return (await rpc().getSandbox({ workspaceScope, name })).sandbox;
    } catch (error) {
      if (ConnectError.from(error).code === Code.NotFound) return undefined;
      throw error;
    }
  }

  async function waitFor(
    name: string,
    done: (sandbox: Sandbox | undefined) => boolean,
    what: string,
    timeoutMs: number
  ): Promise<Sandbox | undefined> {
    const deadline = Date.now() + timeoutMs;
    let delay = 200;
    for (;;) {
      const sandbox = await get(name);
      if (done(sandbox)) return sandbox;
      if (sandbox?.status?.phase === SandboxPhase.ERROR) {
        const reason = sandbox.status.conditions.map((item) => `${item.reason} ${item.message}`.trim()).join("; ");
        throw new Error(`OpenShell sandbox '${name}' failed${reason ? `: ${reason}` : ""}`);
      }
      if (Date.now() >= deadline) throw new Error(`OpenShell sandbox '${name}' did not become ${what} in time`);
      await sleep(delay);
      delay = Math.min(delay * 2, 2000);
    }
  }

  /** Run `sh -c script` and collect its output; `signal` cancels the stream and the command. */
  async function run(
    name: string,
    script: string,
    signal: AbortSignal,
    extra: { cwd?: string; stdin?: Uint8Array } = {}
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let exitCode: number | undefined;
    const stream = rpc().execSandbox(
      {
        workspaceScope,
        sandbox: name,
        command: ["/bin/sh", "-c", script],
        workdir: extra.cwd ?? "",
        environment: {},
        stdin: extra.stdin ?? new Uint8Array(),
        tty: false,
        noLoginShell: true,
      },
      { signal }
    );
    for await (const event of stream) {
      if (event.payload.case === "stdout") stdout.push(event.payload.value.data);
      else if (event.payload.case === "stderr") stderr.push(event.payload.value.data);
      else if (event.payload.case === "exit") exitCode = event.payload.value.exitCode;
    }
    if (exitCode === undefined) throw new Error("OpenShell exec ended without an exit code");
    const text = (parts: Uint8Array[]) => Buffer.concat(parts).toString("utf8");
    return { exitCode, stdout: text(stdout), stderr: text(stderr) };
  }

  return {
    name: "openshell",
    isolation: "container",

    async probe(): Promise<SandboxProbe> {
      const base = { name: "openshell" as const, isolation: "container" as const };
      try {
        const health = await rpc().health({}, { timeoutMs: 5_000 });
        const healthy = health.status === ServiceStatus.HEALTHY;
        return {
          ...base,
          available: healthy,
          version: health.version,
          reason: healthy
            ? `OpenShell gateway ${options.gateway} (${health.version})`
            : `OpenShell gateway ${options.gateway} is ${ServiceStatus[health.status]?.toLowerCase() ?? "not healthy"}`,
        };
      } catch (error) {
        return {
          ...base,
          available: false,
          reason: `OpenShell gateway ${options.gateway} did not answer: ${ConnectError.from(error).rawMessage}`,
        };
      }
    },

    unmet(spec: SandboxSpec) {
      if (spec.network.preset === "open")
        return "the openshell backend cannot open all egress; list hosts in network.allow";
      return undefined;
    },

    async open(spec: SandboxSpec): Promise<SandboxHandle> {
      const name = sandboxNameOf(spec.key);
      let sandbox = await get(name);
      if (sandbox?.status?.phase === SandboxPhase.ERROR) {
        await rpc().deleteSandbox({ workspaceScope, name }).catch(() => undefined);
        await waitFor(name, (found) => found === undefined, "deleted", 60_000);
        sandbox = undefined;
      }
      const created = sandbox === undefined;
      if (created) {
        await rpc().createSandbox({
          workspaceScope,
          name,
          labels: { [KEY_LABEL]: spec.key },
          spec: {
            environment: {},
            providers: [],
            command: [],
            tty: false,
            policy: openshellPolicy(spec.network),
            template: {
              ...(spec.image === undefined ? {} : { image: spec.image }),
              resources: { limits: { cpu: String(spec.cpus), memory: `${spec.memoryMiB}Mi` } },
            },
          },
          serviceExposures: [],
        });
      } else if (
        sandbox!.status?.phase === SandboxPhase.STOPPED ||
        sandbox!.status?.phase === SandboxPhase.STOPPING
      ) {
        await waitFor(name, (found) => found?.status?.phase === SandboxPhase.STOPPED, "stopped", 60_000);
        await rpc().startSandbox({ workspaceScope, name });
      }
      await waitFor(
        name,
        (found) => found?.status?.phase === SandboxPhase.READY,
        "ready",
        readyTimeoutMs
      );

      const setup = await run(
        name,
        `pwd; for c in ${REQUIRED_COMMANDS.join(" ")}; do command -v $c >/dev/null || echo "missing:$c"; done`,
        AbortSignal.timeout(60_000)
      );
      const lines = setup.stdout.split("\n").filter(Boolean);
      const missing = lines.filter((line) => line.startsWith("missing:")).map((line) => line.slice(8));
      if (missing.length > 0)
        throw new Error(
          `the image ${spec.image ?? "(gateway default)"} lacks ${missing.join(", ")}, which the sandbox tools need`
        );
      const workspace = lines[0]?.startsWith("/") ? lines[0] : OPENSHELL_WORKSPACE;

      return {
        workspace,
        created,
        async exec(request: ExecRequest, signal: AbortSignal): Promise<ExecResult> {
          const controller = new AbortController();
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, request.timeoutMs);
          const onAbort = () => controller.abort();
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) controller.abort();
          try {
            const result = await run(name, request.command, controller.signal, { cwd: request.cwd });
            return { ...result, killed: false, timedOut: false };
          } catch (error) {
            if (!controller.signal.aborted) throw error;
            // Cancelling the stream stops the command in the sandbox.
            return {
              exitCode: timedOut ? 124 : 130,
              stdout: "",
              stderr: "",
              killed: true,
              timedOut,
            };
          } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
          }
        },
        async readFile(path: string) {
          const result = await run(
            name,
            `[ -f ${quote(path)} ] || exit ${MISSING}; cat ${quote(path)}`,
            AbortSignal.timeout(120_000)
          );
          if (result.exitCode === MISSING) return undefined;
          if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `cannot read ${path}`);
          return result.stdout;
        },
        async writeFile(path: string, content: string) {
          const bytes = Buffer.from(content, "utf8");
          let offset = 0;
          do {
            const chunk = bytes.subarray(offset, offset + WRITE_CHUNK_BYTES);
            const result = await run(
              name,
              `cat ${offset === 0 ? ">" : ">>"} ${quote(path)}`,
              AbortSignal.timeout(120_000),
              { stdin: chunk }
            );
            if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `cannot write ${path}`);
            offset += WRITE_CHUNK_BYTES;
          } while (offset < bytes.length);
        },
        async stop() {
          await rpc().stopSandbox({ workspaceScope, name });
          await waitFor(
            name,
            (found) => found === undefined || found.status?.phase === SandboxPhase.STOPPED,
            "stopped",
            120_000
          );
        },
      };
    },

    async remove(key: string) {
      const name = sandboxNameOf(key);
      try {
        await rpc().deleteSandbox({ workspaceScope, name });
      } catch (error) {
        if (ConnectError.from(error).code === Code.NotFound) return;
        throw error;
      }
      await waitFor(name, (found) => found === undefined, "deleted", 120_000);
    },

    async list(prefix: string) {
      const keys: string[] = [];
      let pageToken = "";
      do {
        const page = await rpc().listSandboxes({ workspaceScope, pageSize: 500, pageToken });
        for (const sandbox of page.sandboxes) {
          const key = sandbox.metadata?.labels[KEY_LABEL];
          if (key?.startsWith(prefix)) keys.push(key);
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      return keys;
    },
  };
}
