// What the network invariant and the red-team suite share (F7.2, S10): a Tenant with sandboxes
// enabled on a cluster, one pod sandbox created through the Tenant API and joined, a busybox
// probe pod in the sandbox namespace (under the same NetworkPolicy as every sandbox pod), and
// tokens minted by the gateway's keys service, as core mints them at join.
//
// Needs kubectl, a context with agent-sandbox v1.0.5 or none, the workspace builds, and the images
// sandbox pods use loaded into the cluster (CI: `kind load docker-image` of the runtime image,
// python:3.13-slim and busybox:1.37.0).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { tenantTokenIssuer } from "@nylorun/core/contracts";
import { run } from "../lib/repo.mjs";
import { ensureImages, runtimeHeaders, withStack } from "../lib/stack.mjs";

/** `runtime/server/src/sandbox/egress-token.ts`. */
export const EGRESS_TOKEN_TYP = "nylorun-egress+jwt";
export const EGRESS_TOKEN_AUD = "nylorun-egress";
/** `runtime/server/src/tenant/run-token.ts`. */
export const RUN_TOKEN_TYP = "nylorun-run+jwt";
export const RUN_TOKEN_AUD = "nylorun-gates";
/** `runtime/server/src/tenant/host-token.ts`: the host token core mints at join (D42). */
export const HOST_TOKEN_TYP = "nylorun-host+jwt";
export const HOST_TOKEN_AUD = "nylorun-harness-api";
/** `runtime/server/src/harness-api/ws-server.ts`: where a pod's engine exchanges its join token. */
export const HOST_JOIN_PATH = "/nylorun/harness/v1/host/join";
/** Where the join Secret is mounted in a sandbox pod (`sandboxes/internal/driver`). */
export const JOIN_TOKEN_FILE = "/run/nylorun/join/token";

export const PROBE_IMAGE = "busybox:1.37.0";
/** In the Tenant's default network ceiling, so a pod spec may allow it. */
export const ALLOWED_HOST = "pypi.org";

export function podOptions() {
  const { values } = parseArgs({
    options: {
      context: { type: "string", default: process.env.NYLORUN_SANDBOX_CONTEXT ?? "kind-nylorun" },
      "host-address": { type: "string", default: process.env.NYLORUN_SANDBOX_HOST_ADDRESS },
    },
  });
  return { context: values.context, hostAddress: values["host-address"] };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `KEY=value` lines of the Tenant's `docker/.env`. */
async function readEnv(home) {
  const env = {};
  for (const line of (await readFile(join(home, "docker", ".env"), "utf8")).split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
  }
  return env;
}

/** Signs `{typ, claims}` with the Tenant's key through the keys service, from the runtime container. */
const SIGN = String.raw`
const [request] = process.argv.slice(1);
fetch(process.env.NYLORUN_KEYS_URL + "/nylorun/v1/keys/sign", {
  method: "POST",
  headers: { authorization: "Bearer " + process.env.NYLORUN_GATES_TOKEN, "content-type": "application/json" },
  body: JSON.stringify({ args: [JSON.parse(request)] }),
  signal: AbortSignal.timeout(20000),
}).then(async (r) => console.log(await r.text()), (e) => console.log(JSON.stringify({ error: String(e) })));`;

/**
 * Runs `fn(pod)` on a fresh Tenant with sandboxes enabled and one joined pod sandbox whose spec
 * allows `ALLOWED_HOST`. Always deletes the namespace and resets the Tenant.
 */
export async function withPodSandbox({ name, context, hostAddress, step }, fn) {
  const kubectl = async (args, { check = true, timeout = 120_000 } = {}) => {
    try {
      return await run("kubectl", ["--context", context, ...args], { capture: true, timeout });
    } catch (error) {
      if (check) throw error;
      return undefined;
    }
  };
  const images = await ensureImages({ only: ["runtime", "sandboxes"] });
  await withStack({ name, images, startArgs: ["--no-studio"] }, async (stack) => {
    const namespace = `nylorun-sbx-${stack.project}`;
    try {
      step(`nylorun sandbox enable --context ${context}`);
      const enable = ["sandbox", "enable", "--context", context, "--no-pull"];
      if (hostAddress) enable.push("--host-address", hostAddress);
      await stack.nylorun(enable, { timeout: 900_000 });
      const env = await readEnv(stack.home);
      const host = env.NYLORUN_SANDBOX_HOST_ADDRESS;
      const ports = {
        harness: Number(env.NYLORUN_SANDBOX_HARNESS_PORT),
        gates: Number(env.NYLORUN_SANDBOX_GATES_PORT),
        egress: Number(env.NYLORUN_SANDBOX_EGRESS_PORT),
        runtime: Number(env.NYLORUN_PORT),
        restate: Number(env.NYLORUN_RESTATE_PORT),
      };
      assert.ok(host && ports.harness && ports.gates && ports.egress, "enable records the host address and pod-facing ports");
      const tenant = await stack.tenant();

      step(`create pod sandbox net/one (network.allow ${ALLOWED_HOST})`);
      const sandboxId = "net/one";
      const sandboxPath = `/v1/sandboxes/${encodeURIComponent(sandboxId)}`;
      const put = await fetch(`${stack.runtimeUrl}${sandboxPath}`, {
        method: "PUT",
        headers: runtimeHeaders(tenant.key, { "content-type": "application/json" }),
        body: JSON.stringify({ kind: "pod", network: { allow: [ALLOWED_HOST] } }),
      });
      assert.ok(put.ok, `PUT ${sandboxPath}: ${put.status} ${await put.text()}`);

      step("wait for the sandbox pod to run and its engine to join");
      // The row the join wrote: the pod that joined and the host epoch its tokens carry.
      const joinedRow = async () => {
        const [k8sName = "", podUid = "", hostEpoch = "0", observed = ""] = (
          await stack.psql(
            `SELECT k8s_name, coalesce(pod_uid, ''), host_epoch, observed FROM nylorun.sandbox_resources WHERE id = '${sandboxId}'`,
          )
        ).split("|");
        return { k8sName, podUid, epoch: Number(hostEpoch), observed };
      };
      let row = await joinedRow();
      for (let attempt = 0; attempt < 210 && !(row.epoch > 0 && row.podUid && row.observed === "running"); attempt += 1) {
        await sleep(2000);
        row = await joinedRow();
      }
      assert.ok(row.epoch > 0 && row.podUid, `the pod's engine joins (${JSON.stringify(row)})`);
      const { epoch, podUid } = row;
      const pods = JSON.parse(await kubectl(["get", "pods", "-n", namespace, "-l", `nylorun.dev/sandbox=${row.k8sName}`, "-o", "json"]));
      const sandboxPod = pods.items.find((pod) => pod.metadata.uid === podUid && !pod.metadata.deletionTimestamp);
      assert.ok(sandboxPod, "the pod that joined is the Sandbox's pod");

      step(`probe pods in ${namespace}`);
      const idle = ["sh", "-c", "trap 'exit 0' TERM; while :; do sleep 1; done"];
      await kubectl(["run", "nylorun-probe", "-n", namespace, "--image", PROBE_IMAGE, "--restart=Never", "--labels", "nylorun.dev/role=probe", "--command", "--", ...idle]);
      await kubectl(["run", "nylorun-peer", "-n", namespace, "--image", PROBE_IMAGE, "--restart=Never", "--labels", "nylorun.dev/role=probe", "--command", "--", "httpd", "-f", "-p", "8080"]);
      await kubectl(["wait", "-n", namespace, "--for=condition=Ready", "pod/nylorun-probe", "pod/nylorun-peer", "--timeout=120s"], { timeout: 150_000 });
      const peerIp = (await kubectl(["get", "pod", "nylorun-peer", "-n", namespace, "-o", "jsonpath={.status.podIP}"])).trim();
      const probeUid = (await kubectl(["get", "pod", "nylorun-probe", "-n", namespace, "-o", "jsonpath={.metadata.uid}"])).trim();
      /** A shell command in the sandbox pod's workload container. */
      const inSandbox = (command) =>
        kubectl(["exec", "-n", namespace, sandboxPod.metadata.name, "-c", "workload", "--", "sh", "-c", command], { timeout: 60_000 });

      /** A shell command in the probe pod; `undefined` when it exits non-zero. */
      const sh = (command) =>
        kubectl(["exec", "-n", namespace, "nylorun-probe", "--", "sh", "-c", command], { check: false, timeout: 60_000 });
      /** Whether the probe pod opens a TCP connection to `target:port`. */
      const reaches = async (target, port) => (await sh(`nc -w 2 ${target} ${port} </dev/null`)) !== undefined;
      /** Sends raw `request` bytes from the probe pod; the answer's status line. */
      // busybox nc hangs up once its input ends: keep the input open for an answer that takes a
      // moment (a join asks the sandboxes service; a CONNECT resolves and dials first).
      const raw = async (target, port, request) =>
        ((await sh(`{ echo ${Buffer.from(request).toString("base64")} | base64 -d; sleep 4; } | nc -w 5 ${target} ${port} | head -n 1`)) ?? "").trim();
      const status = (line) => Number(/^HTTP\/1\.[01] (\d{3})/.exec(line)?.[1] ?? 0);
      /** An HTTP request from the probe pod; its status (0: no answer). */
      const http = async (target, port, method, path, { headers = {}, body } = {}) => {
        const lines = [`${method} ${path} HTTP/1.1`, `Host: ${target}:${port}`, "Connection: close"];
        for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
        if (body !== undefined) lines.push("Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`);
        return status(await raw(target, port, `${lines.join("\r\n")}\r\n\r\n${body ?? ""}`));
      };
      /** CONNECT `authority` through egress-gate from the probe pod; the answer's status. */
      const connect = async (authority, token) =>
        status(
          await raw(
            host,
            ports.egress,
            `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${token ? `Proxy-Authorization: Bearer ${token}\r\n` : ""}\r\n`,
          ),
        );

      // kindnet programs a new pod's NetworkPolicy late (8a): wait until the internet is closed.
      for (let open = 0; await reaches("1.1.1.1", 443); open += 1) {
        assert.ok(open < 20, "the probe pod's NetworkPolicy takes effect");
        await sleep(1000);
      }

      /** Signs `claims` as `typ` with the Tenant's key, as the keys service signs for core. */
      const sign = async (typ, claims) => {
        const out = await stack.compose(["exec", "-T", "runtime", "node", "-e", SIGN, JSON.stringify({ typ, claims })]);
        const answer = JSON.parse(out.trim().split("\n").at(-1));
        assert.ok(answer.result?.token, `keys.sign: ${JSON.stringify(answer)}`);
        return answer.result.token;
      };
      const iat = () => Math.floor(Date.now() / 1000);
      const issuer = tenantTokenIssuer(tenant.id);
      /** An egress token as core mints it at join (`mintEgressToken`), with `overrides`. */
      const egressToken = (overrides = {}) =>
        sign(EGRESS_TOKEN_TYP, {
          iss: issuer,
          aud: EGRESS_TOKEN_AUD,
          sbx: sandboxId,
          epc: epoch,
          pod: podUid,
          iat: iat(),
          exp: iat() + 600,
          jti: crypto.randomUUID(),
          ...overrides,
        });

      await fn({
        stack,
        kubectl,
        namespace,
        tenant,
        sandboxId,
        sandboxPod,
        podUid,
        probeUid,
        inSandbox,
        epoch,
        host,
        ports,
        peerIp,
        sh,
        reaches,
        http,
        connect,
        sign,
        issuer,
        egressToken,
      });
    } catch (error) {
      await kubectl(["get", "sandbox,pod,pvc,secret,networkpolicy", "-n", namespace, "-o", "wide"], { check: false }).then((out) => out && console.error(out));
      await kubectl(["describe", "pods", "-n", namespace], { check: false }).then((out) => out && console.error(out));
      await stack.compose(["logs", "--tail", "100", "gateway", "sandboxes"], { check: false }).then(console.error, () => {});
      throw error;
    } finally {
      await kubectl(["delete", "namespace", namespace, "--ignore-not-found", "--wait=false"], { check: false });
    }
  });
}
