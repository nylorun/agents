import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@nylorun/agents";
import { proxyRuntime } from "../dist/proxy.js";

async function withUpstream(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
  run: (upstreamUrl: string) => Promise<void>,
) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("proxy forwards the bearer and Protocol header, names no Tenant, and allows /v1/tenant routes", async () => {
  const seen: { path: string; headers: Record<string, string | string[] | undefined> }[] = [];
  await withUpstream(
    (req, res) => {
      seen.push({ path: req.url ?? "", headers: { ...req.headers } });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
    async (upstreamUrl) => {
      const studio = createServer((req, res) => {
        void proxyRuntime(req, res, {
          origin: "http://127.0.0.1:4161",
          runtimeUrl: upstreamUrl,
          serverKey: "server-secret",
        });
      });
      studio.listen(0, "127.0.0.1");
      await once(studio, "listening");
      const address = studio.address();
      assert.ok(address && typeof address === "object");
      const origin = `http://127.0.0.1:${address.port}`;
      try {
        const response = await fetch(
          `${origin}/_studio/runtime/v1/tenant/model`,
          {
            headers: { host: `127.0.0.1:${address.port}` },
          },
        );
        assert.equal(response.status, 200);
        assert.equal(seen.length, 1);
        assert.equal(seen[0]!.path, "/v1/tenant/model");
        assert.equal(seen[0]!.headers.authorization, "Bearer server-secret");
        assert.equal(seen[0]!.headers["nylorun-tenant"], undefined);
        // Management routes: Studio's key acts as itself, for no subject (AP15).
        assert.equal(seen[0]!.headers["nylorun-subject"], undefined);
        assert.equal(seen[0]!.headers["nylorun-scopes"], undefined);
        assert.equal(
          seen[0]!.headers[PROTOCOL_HEADER.toLowerCase()],
          String(PROTOCOL_VERSION),
        );
      } finally {
        studio.close();
        await once(studio, "close");
      }
    },
  );
});

test("proxy rejects legacy /v1/host model routes", async () => {
  await withUpstream(
    (_req, res) => {
      res.writeHead(200);
      res.end("{}");
    },
    async (upstreamUrl) => {
      const studio = createServer((req, res) => {
        void proxyRuntime(req, res, {
          origin: "http://127.0.0.1:4161",
          runtimeUrl: upstreamUrl,
          serverKey: "server-secret",
        });
      });
      studio.listen(0, "127.0.0.1");
      await once(studio, "listening");
      const address = studio.address();
      assert.ok(address && typeof address === "object");
      try {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/_studio/runtime/v1/host/model`,
        );
        assert.equal(response.status, 404);
        const body = (await response.json()) as { message: string };
        assert.match(body.message, /Unsupported/);
      } finally {
        studio.close();
        await once(studio, "close");
      }
    },
  );
});

test("proxy allows /health for SDK compatibility checks", async () => {
  let hit = false;
  await withUpstream(
    (req, res) => {
      hit = req.url === "/health";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "nylorun-runtime",
          version: "0.9.0-beta",
          protocol: { min: 2, max: 2, features: ["runtime-tenants", "admin-status"] },
          coreVersion: "0.4.0-beta",
          hostId: "host_1",
          pid: 1,
        }),
      );
    },
    async (upstreamUrl) => {
      const studio = createServer((req, res) => {
        void proxyRuntime(req, res, {
          origin: "http://127.0.0.1:4161",
          runtimeUrl: upstreamUrl,
          serverKey: "server-secret",
        });
      });
      studio.listen(0, "127.0.0.1");
      await once(studio, "listening");
      const address = studio.address();
      assert.ok(address && typeof address === "object");
      try {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/_studio/runtime/health`,
        );
        assert.equal(response.status, 200);
        assert.equal(hit, true);
      } finally {
        studio.close();
        await once(studio, "close");
      }
    },
  );
});

test("proxy requires explicit installation vaults on the Management API and lists them without an owner", async () => {
  const seen: { path: string; body: string; headers: Record<string, string | string[] | undefined> }[] = [];
  await withUpstream(
    async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      seen.push({ path: req.url ?? "", body, headers: { ...req.headers } });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
    async (upstreamUrl) => {
      const origin = "http://127.0.0.1:4161";
      const studio = createServer((req, res) => {
        void proxyRuntime(req, res, { origin, runtimeUrl: upstreamUrl, serverKey: "server-secret" });
      });
      studio.listen(0, "127.0.0.1");
      await once(studio, "listening");
      const address = studio.address();
      assert.ok(address && typeof address === "object");
      try {
        const created = await fetch(`http://127.0.0.1:${address.port}/_studio/runtime/v1/tenant/vaults`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ requestId: "r", idempotencyKey: "k", name: "GitHub", scope: "installation" }),
        });
        assert.equal(created.status, 200);
        assert.deepEqual(JSON.parse(seen[0]!.body), {
          requestId: "r",
          idempotencyKey: "k",
          name: "GitHub",
          scope: "installation",
        });
        const listed = await fetch(`http://127.0.0.1:${address.port}/_studio/runtime/v1/tenant/vaults`);
        assert.equal(listed.status, 200);
        assert.equal(seen[1]!.path, "/v1/tenant/vaults");
        for (const { headers } of seen) {
          assert.equal(headers["nylorun-subject"], undefined);
          assert.equal(headers["nylorun-scopes"], undefined);
        }
        for (const body of [{ name: "Old defaults" }, { name: "Personal", ownerUserId: "someone" }, { name: "Conflicting", scope: "installation", ownerUserId: "someone" }]) {
          const response = await fetch(`http://127.0.0.1:${address.port}/_studio/runtime/v1/tenant/vaults`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          assert.equal(response.status, 400);
        }
        const personal = await fetch(`http://127.0.0.1:${address.port}/_studio/runtime/v1/tenant/vaults?ownerUserId=local-developer`);
        assert.equal(personal.status, 400);
        // The protocol-7 vault paths are not Studio's any more.
        const legacy = await fetch(`http://127.0.0.1:${address.port}/_studio/runtime/v1/vaults`);
        assert.equal(legacy.status, 404);
        assert.equal(seen.length, 2, "unsupported owner requests and old paths never reach Runtime");
      } finally {
        studio.close();
        await once(studio, "close");
      }
    },
  );
});

test("proxy forwards a same-origin MCP tool preview and refuses one from another origin", async () => {
  const seen: { path: string; body: string; headers: Record<string, string | string[] | undefined> }[] = [];
  await withUpstream(
    async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      seen.push({ path: `${req.method} ${req.url}`, body, headers: { ...req.headers } });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tools: [], renamed: [] }));
    },
    async (upstreamUrl) => {
      const origin = "http://127.0.0.1:4161";
      const studio = createServer((req, res) => {
        void proxyRuntime(req, res, { origin, runtimeUrl: upstreamUrl, serverKey: "server-secret" });
      });
      studio.listen(0, "127.0.0.1");
      await once(studio, "listening");
      const address = studio.address();
      assert.ok(address && typeof address === "object");
      const url = `http://127.0.0.1:${address.port}/_studio/runtime/v1/tenant/mcp/preview`;
      const body = JSON.stringify({ url: "https://mcp.example.com/mcp", vaultId: "v1" });
      try {
        const previewed = await fetch(url, { method: "POST", headers: { origin, "content-type": "application/json" }, body });
        assert.equal(previewed.status, 200);
        assert.equal(seen[0]!.path, "POST /v1/tenant/mcp/preview");
        assert.deepEqual(JSON.parse(seen[0]!.body), { url: "https://mcp.example.com/mcp", vaultId: "v1" });
        assert.equal(seen[0]!.headers.authorization, "Bearer server-secret");
        const foreign = await fetch(url, {
          method: "POST",
          headers: { origin: "https://evil.example", "content-type": "application/json" },
          body,
        });
        assert.equal(foreign.status, 403);
        const read = await fetch(url);
        assert.equal(read.status, 404);
        assert.equal(seen.length, 1);
      } finally {
        studio.close();
        await once(studio, "close");
      }
    },
  );
});

test("proxy forwards a credential coverage check against installation vaults only", async () => {
  const seen: { path: string; body: string; headers: Record<string, string | string[] | undefined> }[] = [];
  await withUpstream(
    async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      seen.push({ path: `${req.method} ${req.url}`, body, headers: { ...req.headers } });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ agentId: "triage", vaultIds: ["v1"], complete: true, entries: [] }));
    },
    async (upstreamUrl) => {
      const origin = "http://127.0.0.1:4161";
      const studio = createServer((req, res) => {
        void proxyRuntime(req, res, { origin, runtimeUrl: upstreamUrl, serverKey: "server-secret" });
      });
      studio.listen(0, "127.0.0.1");
      await once(studio, "listening");
      const address = studio.address();
      assert.ok(address && typeof address === "object");
      const url = `http://127.0.0.1:${address.port}/_studio/runtime/v1/tenant/credential-coverage`;
      const post = (body: unknown, from = origin) =>
        fetch(url, { method: "POST", headers: { origin: from, "content-type": "application/json" }, body: JSON.stringify(body) });
      try {
        const checked = await post({ agentId: "triage", vaultIds: ["v1"] });
        assert.equal(checked.status, 200);
        assert.equal(seen[0]!.path, "POST /v1/tenant/credential-coverage");
        assert.deepEqual(JSON.parse(seen[0]!.body), { agentId: "triage", vaultIds: ["v1"] });
        assert.equal(seen[0]!.headers.authorization, "Bearer server-secret");
        // Studio manages no person's vault, so it checks none.
        assert.equal((await post({ agentId: "triage", ownerUserId: "local-developer" })).status, 400);
        assert.equal((await post({ agentId: "triage" }, "https://evil.example")).status, 403);
        assert.equal((await fetch(url)).status, 404);
        assert.equal(seen.length, 1);
      } finally {
        studio.close();
        await once(studio, "close");
      }
    },
  );
});

test("proxy forwards a session's pinned manifest read and nothing else under the session", async () => {
  const seen: string[] = [];
  await withUpstream(
    (req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    },
    async (upstreamUrl) => {
      const studio = createServer((req, res) => {
        void proxyRuntime(req, res, {
          origin: "http://127.0.0.1:4161",
          runtimeUrl: upstreamUrl,
          serverKey: "server-secret",
        });
      });
      studio.listen(0, "127.0.0.1");
      await once(studio, "listening");
      const address = studio.address();
      assert.ok(address && typeof address === "object");
      const base = `http://127.0.0.1:${address.port}/_studio/runtime`;
      try {
        assert.equal((await fetch(`${base}/v1/sessions/s1/manifest`)).status, 200);
        assert.equal((await fetch(`${base}/v1/sessions/s1/usage`)).status, 404);
        assert.equal((await fetch(`${base}/v1/sessions/s1/manifest`, { method: "DELETE" })).status, 404);
        assert.deepEqual(seen, ["GET /v1/sessions/s1/manifest"]);
      } finally {
        studio.close();
        await once(studio, "close");
      }
    },
  );
});
