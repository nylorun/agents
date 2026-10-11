/**
 * The pod's join against a fake Harness API listener: the join with the mounted token and the
 * volume's id, a renewal with the host token, a join again once a renewal is refused, and the
 * proxy and trust bundle every command gets.
 */
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { podHost } from "../src/pod.js";

const cleanups: (() => unknown)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

it("joins, renews, joins again when refused, and gives commands the proxy and the CA", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-minimal-pod-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const joinFile = join(root, "join-token");
  writeFileSync(joinFile, "join-1\n");
  const seen: { path: string; authorization?: string; body?: any }[] = [];
  let refuse = false;
  let n = 0;
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    seen.push({
      path: request.url!,
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      ...(text ? { body: JSON.parse(text) } : {}),
    });
    if (refuse && request.url!.endsWith("/renew")) return void response.writeHead(401).end();
    n += 1;
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        hostToken: `host-${n}`,
        egressToken: `egress-${n}`,
        sandboxId: "sbx",
        epoch: 1,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        caCertificate: "-----BEGIN CERTIFICATE-----\nEGRESS\n-----END CERTIFICATE-----",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  const { port } = server.address() as { port: number };
  const pod = podHost({
    sandboxId: "sbx",
    podUid: "pod-1",
    joinFile,
    harnessUrl: `http://127.0.0.1:${port}`,
    egressProxy: "http://10.0.0.1:4200",
    root,
  });
  cleanups.push(() => pod.stop());

  expect(pod.commandEnv()).toEqual({});
  expect(await pod.token()).toBe("host-1");
  const volumeId = readFileSync(join(root, "volume-id"), "utf8").trim();
  expect(seen[0]).toEqual({
    path: "/nylorun/harness/v1/host/join",
    body: { sandboxId: "sbx", podUid: "pod-1", joinToken: "join-1", volumeId },
  });
  expect(await pod.token()).toBe("host-2");
  expect(seen[1]).toEqual({
    path: "/nylorun/harness/v1/host/renew",
    authorization: "Bearer host-1",
  });

  refuse = true;
  writeFileSync(joinFile, "join-2\n");
  expect(await pod.token()).toBe("host-3");
  expect(seen.slice(2).map((call) => call.path)).toEqual([
    "/nylorun/harness/v1/host/renew",
    "/nylorun/harness/v1/host/join",
  ]);
  expect(seen[3]!.body).toMatchObject({ joinToken: "join-2", volumeId });

  const env = pod.commandEnv();
  expect(env.HTTPS_PROXY).toBe("http://nylorun:egress-3@10.0.0.1:4200");
  expect(env.SSL_CERT_FILE).toBe(join(root, "egress-ca-bundle.pem"));
  expect(readFileSync(env.SSL_CERT_FILE!, "utf8")).toMatch(/EGRESS\n-----END CERTIFICATE-----\n$/);
});
