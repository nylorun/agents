#!/usr/bin/env node
// The sandboxes service on a real cluster (F7.2 8a), driven directly, with busybox pods:
//
//   npm run test:sandboxes:service -- --context kind-nylorun --host-address 172.17.0.1
//   npm run test:sandboxes:service -- --context docker-desktop
//
// Starts a Tenant under a temporary Host root (`nylorun start --no-studio`), runs
// `nylorun sandbox enable` (agent-sandbox install when absent, namespace, RBAC, the
// NetworkPolicy probe, cluster.json, the service), then through the runtime container,
// which holds the service's token:
//
// - create a Sandbox, repeat its opId (no-op), wait Ready; the join token and pod UID reach
//   the pod;
// - the namespace's NetworkPolicy keeps the pod from the API server, kube-dns and the
//   internet;
// - suspend, resume (data kept on the volume, new pod), each with the sandboxes container
//   restarted mid-operation (`docker restart`), then retried with the same opId;
// - delete: Sandbox, pod, claim and join Secret gone;
// - enable again (the probe runs again; ports and token kept); `nylorun sandbox status`;
// - no container of the Tenant and no pod mounts docker.sock or a host path;
// - `nylorun sandbox disable --delete-namespace`, then `nylorun reset`.
//
// Needs kubectl, a context that runs agent-sandbox v1.0.5 or none, and the workspace builds
// (`npm run build`). Images: NYLORUN_RUNTIME_IMAGE and NYLORUN_SANDBOXES_IMAGE when set
// (CI), else built from this checkout. Only the named context is touched; the namespaces
// this suite creates are deleted.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { run } from "../lib/repo.mjs";
import { ensureImages, withStack } from "../lib/stack.mjs";

const { values: options } = parseArgs({
  options: {
    context: { type: "string", default: process.env.NYLORUN_SANDBOX_CONTEXT ?? "kind-nylorun" },
    "host-address": { type: "string", default: process.env.NYLORUN_SANDBOX_HOST_ADDRESS },
  },
});
const context = options.context;
const step = (message) => console.log(`\n[sandboxes] ${message}`);

/** kubectl on the named context only. */
async function kubectl(args, { check = true } = {}) {
  try {
    return await run("kubectl", ["--context", context, ...args], { capture: true, timeout: 120_000 });
  } catch (error) {
    if (check) throw error;
    return undefined;
  }
}

/** The Sandbox name core computes (driver.Name in Go; fixed vector checked below). */
function sandboxName(tenant, id, volumeGen) {
  const digest = createHash("sha256").update(`${tenant}/${id}`).digest();
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `sbx-${out.slice(0, 16)}-g${volumeGen}`;
}

/** Calls the service from the runtime container, the only holder of its token. */
const CALL = String.raw`
const [method, path, body] = process.argv.slice(1);
fetch(process.env.NYLORUN_SANDBOXES_URL + path, {
  method,
  headers: { authorization: "Bearer " + process.env.NYLORUN_SANDBOXES_TOKEN, "content-type": "application/json" },
  ...(body ? { body } : {}),
  signal: AbortSignal.timeout(45000),
}).then(
  async (r) => console.log(JSON.stringify({ status: r.status, body: await r.text() })),
  (e) => console.log(JSON.stringify({ status: 0, body: String(e) })),
);`;

const TERM_LOOP = ["sh", "-c", "trap 'exit 0' TERM; while :; do sleep 1; done"];

try {
  assert.equal(sandboxName("shop", "sbx_01", 0), "sbx-ub6g5m7mvjlct6r7-g0", "TS and Go name sandboxes alike");
  const images = await ensureImages({ only: ["runtime", "sandboxes"] });
  await withStack(
    { name: "nylorun-sbx-suite", images, startArgs: ["--no-studio"] },
    async (stack) => {
      const runtime = `${stack.project}-runtime`;
      const service = `${stack.project}-sandboxes`;
      const namespace = `nylorun-sbx-${stack.project}`;
      const api = async (method, path, body) => {
        const out = await run("docker", ["exec", runtime, "node", "-e", CALL, method, path, ...(body ? [JSON.stringify(body)] : [])], {
          capture: true,
          timeout: 60_000,
        });
        const answer = JSON.parse(out.trim().split("\n").at(-1));
        return { status: answer.status, body: answer.body ? JSON.parse(answer.body) : undefined };
      };
      const waitReady = async () => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const ready = await api("GET", "/ready").catch(() => ({ status: 0 }));
          if (ready.status === 200) return;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        throw new Error("the sandboxes service did not become ready");
      };
      /** GET ?wait= until met (each call waits up to 30 s). */
      const waitFor = async (name, state, rounds = 8) => {
        for (let round = 0; round < rounds; round += 1) {
          const answer = await api("GET", `/v1/pods/${name}?wait=${state}&timeoutMs=30000`);
          assert.equal(answer.status, 200, JSON.stringify(answer.body));
          if (answer.body.met) return answer.body;
        }
        throw new Error(`${name} did not become ${state}`);
      };
      const exec = async (name, command) =>
        (await kubectl(["exec", "-n", namespace, name, "-c", "workload", "--", ...command])).trim();
      const reaches = async (name, host, port) =>
        (await kubectl(["exec", "-n", namespace, name, "-c", "workload", "--", "sh", "-c", `nc -w 3 ${host} ${port} </dev/null`], {
          check: false,
        })) !== undefined;

      try {
        step(`nylorun sandbox enable --context ${context}`);
        const enableArgs = ["sandbox", "enable", "--context", context, "--no-pull"];
        if (options["host-address"]) enableArgs.push("--host-address", options["host-address"]);
        await stack.nylorun(enableArgs, { timeout: 900_000 });
        const env = await stack.compose(["exec", "-T", "runtime", "printenv", "NYLORUN_SANDBOXES_URL"]);
        assert.equal(env.trim(), "http://sandboxes:4300");
        assert.equal((await stack.compose(["exec", "-T", "runtime", "ls", "-A", "/nylorun/sandboxes"])).trim(), "",
          "the runtime cannot read the cluster credentials");

        const info = await api("GET", "/v1/info");
        assert.equal(info.status, 200);
        assert.equal(info.body.namespace, namespace);
        assert.equal(info.body.networkPolicy.enforced, true);
        const unauthorized = await run("docker", ["exec", runtime, "node", "-e",
          "fetch(process.env.NYLORUN_SANDBOXES_URL+'/v1/info').then(r=>console.log(r.status))"], { capture: true });
        assert.equal(unauthorized.trim(), "401", "the API needs the bearer token");

        const name = sandboxName(stack.project, "sbx_suite", 0);
        const spec = (opId, mode) => ({
          opId, mode, image: "busybox:1.37.0", command: TERM_LOOP, stopGraceSeconds: 2,
          storageGiB: 1, cpus: 0.5, memoryMiB: 128, joinToken: "join-suite-1",
        });

        step(`create ${name}`);
        const created = await api("PUT", `/v1/pods/${name}`, spec("op-1", "Running"));
        assert.equal(created.status, 200, JSON.stringify(created.body));
        assert.equal(created.body.opId, "op-1");
        const repeated = await api("PUT", `/v1/pods/${name}`, spec("op-1", "Running"));
        assert.equal(repeated.status, 200);
        assert.equal(repeated.body.opId, "op-1", "a repeated opId is a no-op");
        const ready = await waitFor(name, "ready", 12);
        assert.ok(ready.podUID, "a ready sandbox reports its pod UID");
        assert.equal(ready.volume, "present");
        assert.equal(await exec(name, ["cat", "/run/nylorun/join/token"]), "join-suite-1");
        assert.equal(await exec(name, ["sh", "-c", "echo $NYLORUN_POD_UID"]), ready.podUID);
        await exec(name, ["sh", "-c", "echo kept > /workspace/marker"]);

        step("the namespace's NetworkPolicy: no API server, DNS or internet from a sandbox");
        // kindnet programs a new pod's policy asynchronously: egress can be open for a moment
        // after the pod starts (seen for about 1 s on Docker Desktop, once for 5 s). Wait up to
        // 20 s for each target to close, report any opening, then require it stays closed.
        const dns = (await kubectl(["get", "service", "kube-dns", "-n", "kube-system", "-o", "jsonpath={.spec.clusterIP}"])).trim();
        for (const [host, port] of [["10.96.0.1", 443], [dns, 53], ["1.1.1.1", 443]]) {
          let open = 0;
          while (await reaches(name, host, port)) {
            open += 1;
            assert.ok(open < 20, `a sandbox must not reach ${host}:${port}`);
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          if (open) console.warn(`[sandboxes] WARNING: ${host}:${port} was reachable ${open} time(s) after the pod started`);
          assert.equal(await reaches(name, host, port), false, `a sandbox must not reach ${host}:${port}`);
        }

        step("suspend, with the service restarted mid-operation");
        assert.equal((await api("PUT", `/v1/pods/${name}`, spec("op-2", "Suspended"))).status, 200);
        await run("docker", ["restart", "--time", "0", service], { capture: true });
        await waitReady();
        assert.equal((await api("PUT", `/v1/pods/${name}`, spec("op-2", "Suspended"))).body.opId, "op-2");
        const suspended = await waitFor(name, "suspended");
        assert.equal(suspended.podUID, undefined);
        assert.equal(suspended.volume, "present", "suspend keeps the volume");

        step("resume, with the service restarted while a wait is in flight");
        assert.equal((await api("PUT", `/v1/pods/${name}`, spec("op-3", "Running"))).status, 200);
        const inFlight = api("GET", `/v1/pods/${name}?wait=ready&timeoutMs=30000`).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await run("docker", ["restart", "--time", "0", service], { capture: true });
        await inFlight;
        await waitReady();
        assert.equal((await api("PUT", `/v1/pods/${name}`, spec("op-3", "Running"))).body.opId, "op-3");
        const resumed = await waitFor(name, "ready", 12);
        assert.notEqual(resumed.podUID, ready.podUID, "resume runs a new pod");
        assert.equal(await exec(name, ["cat", "/workspace/marker"]), "kept", "the workspace survives suspend");

        step("no docker.sock, no host paths");
        const ids = (await run("docker", ["ps", "--quiet", "--filter", `label=com.docker.compose.project=${stack.project}`], { capture: true }))
          .split(/\s+/).filter(Boolean);
        assert.ok(ids.length >= 5, "the Tenant's containers are running");
        const mounts = await run("docker", ["inspect", "--format", "{{.Name}} {{json .Mounts}}", ...ids], { capture: true });
        assert.doesNotMatch(mounts, /docker\.sock/, "no container mounts docker.sock");
        const pods = JSON.parse(await kubectl(["get", "pods", "-n", namespace, "-o", "json"]));
        for (const pod of pods.items)
          for (const volume of pod.spec.volumes ?? [])
            assert.equal(volume.hostPath, undefined, `${pod.metadata.name} mounts no host path`);

        step("delete");
        const deleted = await api("DELETE", `/v1/pods/${name}?opId=op-4`);
        assert.equal(deleted.status, 200);
        await waitFor(name, "gone", 6);
        assert.equal(await kubectl(["get", "secret", `${name}-join`, "-n", namespace], { check: false }), undefined);
        assert.equal((await api("DELETE", `/v1/pods/${name}?opId=op-4`)).status, 200, "deleting again succeeds");

        step("enable again: the probe runs again; ports and token are kept");
        const before = await stack.compose(["exec", "-T", "runtime", "printenv", "NYLORUN_SANDBOXES_TOKEN"]);
        await stack.nylorun(enableArgs, { timeout: 900_000 });
        assert.equal(await stack.compose(["exec", "-T", "runtime", "printenv", "NYLORUN_SANDBOXES_TOKEN"]), before);
        const status = JSON.parse((await stack.nylorun(["sandbox", "status", "--json"])).stdout);
        assert.equal(status.ready, true);
        assert.equal(status.info.apiVersion, "agents.x-k8s.io/v1beta1");

        step("disable");
        await stack.nylorun(["sandbox", "disable", "--delete-namespace"]);
        const left = await run("docker", ["ps", "--all", "--quiet", "--filter", `name=^${service}$`], { capture: true });
        assert.equal(left.trim(), "", "disable removes the sandboxes container");
        console.log("\n[sandboxes] PASS");
      } catch (error) {
        await kubectl(["get", "sandbox,pod,pvc,secret,networkpolicy", "-n", namespace, "-o", "wide"], { check: false }).then((o) => o && console.error(o));
        await kubectl(["describe", "pods", "-n", namespace], { check: false }).then((o) => o && console.error(o));
        await run("docker", ["logs", "--tail", "200", service], { capture: true }).then(console.error, () => {});
        throw error;
      } finally {
        await kubectl(["delete", "namespace", namespace, "--ignore-not-found", "--wait=false"], { check: false });
      }
    },
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
