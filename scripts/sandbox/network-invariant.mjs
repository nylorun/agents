#!/usr/bin/env node
// The network invariant of sandbox pods (F7.2, D42), on a real cluster:
//
//   npm run test:sandboxes:network -- --context kind-nylorun --host-address 172.17.0.1
//   npm run test:sandboxes:network -- --context docker-desktop
//
// From a probe pod in the sandbox namespace, under the namespace's NetworkPolicy like every
// sandbox pod (`pod-stack.mjs`):
//
// - open: the Harness API, the gates and egress-gate on the host address;
// - closed: Postgres, Restate (8080, 9070), s2, the runtime (4000, 4001) and the gateway's own
//   port on their Compose addresses, the runtime's and Restate's published ports on the host
//   address, another pod in the namespace, the API server (10.96.0.1:443), kube-dns,
//   1.1.1.1:443 and the metadata address 169.254.169.254;
// - egress-gate, with the pod's egress token: CONNECT to the spec's host is admitted; to a host
//   outside the spec, to host.docker.internal:5432, to an IP literal, and to the spec's host on a
//   port other than 443 or 80 is refused; without a token, 407.
import assert from "node:assert/strict";
import { run } from "../lib/repo.mjs";
import { ALLOWED_HOST, podOptions, withPodSandbox } from "./pod-stack.mjs";

const { context, hostAddress } = podOptions();
const step = (message) => console.log(`\n[network] ${message}`);

/** The Compose address of `container` on its project network. */
async function addressOf(container) {
  const out = await run("docker", ["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", container], {
    capture: true,
  }).catch(() => "");
  return out.split(/\s+/).find(Boolean);
}

try {
  await withPodSandbox({ name: "nylorun-sbx-network", context, hostAddress, step }, async (pod) => {
    const { host, ports, reaches, connect, kubectl } = pod;
    step(`open on ${host}: Harness API ${ports.harness}, gates ${ports.gates}, egress-gate ${ports.egress}`);
    for (const [label, port] of [["Harness API", ports.harness], ["gates", ports.gates], ["egress-gate", ports.egress]])
      assert.equal(await reaches(host, port), true, `a sandbox pod reaches the ${label} at ${host}:${port}`);

    step("closed: the stack, other pods, the cluster, the internet and the metadata address");
    const project = pod.stack.project;
    const closed = [];
    const compose = {
      postgres: [5432],
      restate: [8080, 9070, 9080],
      "s2-lite": [80],
      runtime: [4000, 4001, 4200],
      harness: [4300],
      gateway: [4100, 4200],
      sandboxes: [4300],
      rustfs: [9000],
    };
    for (const [service, servicePorts] of Object.entries(compose)) {
      const address = await addressOf(`${project}-${service}`);
      if (address) for (const port of servicePorts) closed.push([`${service}`, address, port]);
    }
    for (const [label, port] of [["runtime (published)", ports.runtime], ["admin (published)", ports.admin], ["Restate admin (published)", ports.restate], ["Postgres", 5432], ["Restate", 8080]])
      if (port) closed.push([label, host, port]);
    const dns = (await kubectl(["get", "service", "kube-dns", "-n", "kube-system", "-o", "jsonpath={.spec.clusterIP}"])).trim();
    closed.push(
      ["another pod", pod.peerIp, 8080],
      ["API server", "10.96.0.1", 443],
      ["kube-dns", dns, 53],
      ["internet", "1.1.1.1", 443],
      ["metadata", "169.254.169.254", 80],
    );
    for (const [label, address, port] of closed)
      assert.equal(await reaches(address, port), false, `a sandbox pod must not reach ${label} at ${address}:${port}`);

    step("egress-gate admits only the spec's hosts");
    const token = await pod.egressToken();
    assert.equal(await connect(`${ALLOWED_HOST}:443`, token), 200, `CONNECT ${ALLOWED_HOST}:443 is admitted`);
    assert.equal(await connect(`${ALLOWED_HOST}:443`), 407, "CONNECT without a token is refused");
    for (const authority of ["example.com:443", "host.docker.internal:5432", "host.docker.internal:443", "1.1.1.1:443", `${host}:${ports.gates}`, `${ALLOWED_HOST}:22`, "169.254.169.254:80"])
      assert.equal(await connect(authority, token), 403, `CONNECT ${authority} is refused`);
    const plain = await pod.http(host, ports.egress, "GET", `http://${ALLOWED_HOST}/`, {
      headers: { "Proxy-Authorization": `Bearer ${token}` },
    });
    assert.equal(plain, 405, "plain HTTP through egress-gate is refused");
    console.log("\n[network] PASS");
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
