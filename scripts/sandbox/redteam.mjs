#!/usr/bin/env node
// Red-team of a sandbox pod's credentials (F7.2, D42), on a real cluster:
//
//   npm run test:sandboxes:redteam -- --context kind-nylorun --host-address 172.17.0.1
//   npm run test:sandboxes:redteam -- --context docker-desktop
//
// A pod holds bearer tokens its workload can read: the host token (Harness API only), the egress
// token (egress-gate only), and per lease a run token (the gates only). From a probe pod in the
// sandbox namespace (`pod-stack.mjs`), with tokens minted as core mints them for the joined pod,
// each is presented where it must not work:
//
// - egress-gate: a run token, a host token, another sandbox's egress token, a stale host epoch
//   (before and after the current one), another Tenant's, an expired one → 407;
// - the gates: the keys service and deliveries with a run, host or egress token, model calls with
//   a host or egress token → 401;
// - the Harness API listener: the Tenant and Admin APIs' routes with a host or run token → never
//   answered.
import assert from "node:assert/strict";
import { newTenantId } from "@nylorun/core/compatibility";
import { subjectTokenIssuer } from "@nylorun/core/contracts";
import {
  ALLOWED_HOST,
  HOST_TOKEN_TYP,
  RUN_TOKEN_AUD,
  RUN_TOKEN_TYP,
  podOptions,
  withPodSandbox,
} from "./pod-stack.mjs";

const { context, hostAddress } = podOptions();
const step = (message) => console.log(`\n[redteam] ${message}`);

try {
  await withPodSandbox({ name: "nylorun-sbx-redteam", context, hostAddress, step }, async (pod) => {
    const { host, ports, connect, http, sign, issuer, egressToken, epoch, sandboxId, podUid } = pod;
    const now = () => Math.floor(Date.now() / 1000);
    const runToken = await sign(RUN_TOKEN_TYP, {
      iss: issuer, aud: RUN_TOKEN_AUD, sub: "redteam-session", trn: "turn-1", agt: "bot", epc: 1,
      iat: now(), exp: now() + 600, jti: crypto.randomUUID(),
    });
    const hostToken = await sign(HOST_TOKEN_TYP, {
      iss: issuer, aud: "nylorun-harness", sbx: sandboxId, epc: epoch, pod: podUid,
      iat: now(), exp: now() + 600, jti: crypto.randomUUID(),
    });
    const egress = await egressToken();
    assert.equal(await connect(`${ALLOWED_HOST}:443`, egress), 200, "the pod's own egress token is admitted");

    step("egress-gate refuses every other token");
    const refusedAtEgress = {
      "a run token": runToken,
      "a host token": hostToken,
      "another sandbox's egress token": await egressToken({ sbx: "sbx_other" }),
      "a later host epoch": await egressToken({ epc: epoch + 1 }),
      ...(epoch > 1 ? { "an earlier host epoch": await egressToken({ epc: epoch - 1 }) } : {}),
      "another Tenant's": await egressToken({ iss: subjectTokenIssuer(newTenantId()) }),
      "an expired one": await egressToken({ iat: now() - 900, exp: now() - 120 }),
    };
    for (const [label, token] of Object.entries(refusedAtEgress))
      assert.equal(await connect(`${ALLOWED_HOST}:443`, token), 407, `egress-gate refuses ${label}`);

    step("the gates refuse a pod's tokens on core's routes, and host and egress tokens on model calls");
    const bearer = (token) => ({ headers: { Authorization: `Bearer ${token}` } });
    for (const [label, token] of [["run", runToken], ["host", hostToken], ["egress", egress]]) {
      const keys = await http(host, ports.gates, "POST", "/nylorun/v1/keys/sign", {
        ...bearer(token),
        body: JSON.stringify({ args: [{ typ: RUN_TOKEN_TYP, claims: {} }] }),
      });
      assert.equal(keys, 401, `the keys service refuses a ${label} token`);
      const deliveries = await http(host, ports.gates, "POST", "/nylorun/v1/deliveries", { ...bearer(token), body: "{}" });
      assert.equal(deliveries, 401, `deliveries refuse a ${label} token`);
    }
    for (const [label, token] of [["host", hostToken], ["egress", egress]])
      assert.equal(
        await http(host, ports.gates, "POST", "/nylorun/v1/model-calls", { ...bearer(token), body: "{}" }),
        401,
        `model calls refuse a ${label} token`,
      );

    step("the Harness API listener serves neither the Tenant API nor the Admin API");
    for (const [label, token] of [["host", hostToken], ["run", runToken]])
      for (const path of ["/v1/sessions", "/v1/tenant", "/v1/admin/status", "/nylorun/v1/keys/sign"]) {
        const status = await http(host, ports.harness, "GET", path, bearer(token));
        assert.ok(!(status >= 200 && status < 400), `GET ${path} with a ${label} token on the Harness API answered ${status}`);
      }
    console.log("\n[redteam] PASS");
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
