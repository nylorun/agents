/**
 * On Agent Substrate a pod's commands reach keyed hosts through Substrate's egress, which ends TLS
 * with its own CA (ADR-142). With no egress proxy, the engine still writes a trust bundle (the
 * public roots, the join's CA and Substrate's egress CA) and names it in the trust variables; with
 * neither the CA file nor a proxy it sets nothing, as before.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { podHost } from "../../src/harness/pod.js";

const SUBSTRATE_CA = "-----BEGIN CERTIFICATE-----\nU1VCU1RSQVRF\n-----END CERTIFICATE-----";
const quiet = { info: () => undefined, warn: () => undefined };

function joinAnswer(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({ hostToken: "h", egressToken: "e", epoch: 3, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
}

describe("the engine's trust bundle on Agent Substrate", () => {
  it("names a bundle with Substrate's egress CA in the trust variables, with no proxy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nylorun-pod-trust-"));
    const joinFile = join(dir, "join");
    await writeFile(joinFile, "join-token");
    const caFile = join(dir, "egress.pem");
    await writeFile(caFile, `${SUBSTRATE_CA}\n`);
    const bundle = join(dir, "bundle.pem");
    const host = podHost({ sandboxId: "local/probe", podUid: "uid", joinFile, httpUrl: "http://edge", blocked: [] }, quiet, {
      fetch: joinAnswer(),
      caBundleFile: bundle,
      extraCaFile: caFile,
    });
    await host.token();
    const env = host.proxyEnv();
    expect(env.SSL_CERT_FILE).toBe(bundle);
    expect(env.CURL_CA_BUNDLE).toBe(bundle);
    expect(env.HTTPS_PROXY).toBeUndefined();
    const written = await readFile(bundle, "utf8");
    expect(written).toContain("U1VCU1RSQVRF");
    expect(written.split("BEGIN CERTIFICATE").length).toBeGreaterThan(10);
    host.stop();
  });

  it("sets nothing with no proxy and no Substrate CA", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nylorun-pod-trust-"));
    const joinFile = join(dir, "join");
    await writeFile(joinFile, "join-token");
    const host = podHost({ sandboxId: "local/probe", podUid: "uid", joinFile, httpUrl: "http://edge", blocked: [] }, quiet, {
      fetch: joinAnswer(),
      caBundleFile: join(dir, "bundle.pem"),
    });
    await host.token();
    expect(host.proxyEnv()).toEqual({});
    host.stop();
  });
});
