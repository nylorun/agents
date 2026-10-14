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

test("proxy forwards Environment reads and same-origin writes on the Runtime API, as they are", async () => {
  const seen: { path: string; body: string; headers: Record<string, string | string[] | undefined> }[] = [];
  await withUpstream(
    async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      seen.push({ path: `${req.method} ${req.url}`, body, headers: { ...req.headers } });
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
      const base = `http://127.0.0.1:${address.port}/_studio/runtime`;
      const send = (method: string, path: string, body?: unknown, from = origin) =>
        fetch(base + path, {
          method,
          headers: { origin: from, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      try {
        const recipe = { requestId: "r", kind: "pod", ownerUserId: "alice", network: { allowedHosts: ["pypi.org"] } };
        assert.equal((await send("PUT", "/v1/environments/team%2Fbuild", recipe)).status, 200);
        const secret = { requestId: "r", type: "bearer", url: "https://mcp.example.com/mcp", value: "tok" };
        assert.equal((await send("PUT", "/v1/environments/team%2Fbuild/secrets/github", secret)).status, 200);
        assert.equal((await send("POST", "/v1/environments/team%2Fbuild/stop", {})).status, 200);
        assert.equal((await send("POST", "/v1/environments/team%2Fbuild/reset", {})).status, 200);
        assert.equal((await send("POST", "/v1/environments/team%2Fbuild/snapshot", {})).status, 200);
        assert.equal((await send("POST", "/v1/environments/team%2Fbuild/restore", { requestId: "r", version: 2 })).status, 200);
        assert.equal((await send("DELETE", "/v1/environments/team%2Fbuild/versions/2")).status, 200);
        assert.equal((await send("DELETE", "/v1/environments/team%2Fbuild/secrets/github")).status, 200);
        assert.equal((await send("DELETE", "/v1/environments/team%2Fbuild")).status, 200);
        for (const path of [
          "/v1/environments?limit=50&label=project%3Dbuild",
          "/v1/environments/team%2Fbuild",
          "/v1/environments/team%2Fbuild/events?from=2",
          "/v1/environments/team%2Fbuild/versions",
          "/v1/environments/team%2Fbuild/secrets",
          "/v1/environments/team%2Fbuild/secrets/github",
        ])
          assert.equal((await fetch(base + path)).status, 200, path);
        assert.deepEqual(
          seen.map((entry) => entry.path),
          [
            "PUT /v1/environments/team%2Fbuild",
            "PUT /v1/environments/team%2Fbuild/secrets/github",
            "POST /v1/environments/team%2Fbuild/stop",
            "POST /v1/environments/team%2Fbuild/reset",
            "POST /v1/environments/team%2Fbuild/snapshot",
            "POST /v1/environments/team%2Fbuild/restore",
            "DELETE /v1/environments/team%2Fbuild/versions/2",
            "DELETE /v1/environments/team%2Fbuild/secrets/github",
            "DELETE /v1/environments/team%2Fbuild",
            "GET /v1/environments?limit=50&label=project%3Dbuild",
            "GET /v1/environments/team%2Fbuild",
            "GET /v1/environments/team%2Fbuild/events?from=2",
            "GET /v1/environments/team%2Fbuild/versions",
            "GET /v1/environments/team%2Fbuild/secrets",
            "GET /v1/environments/team%2Fbuild/secrets/github",
          ],
        );
        // The owner guard is the operator's: an Environment write is not a session's owner.
        assert.deepEqual(JSON.parse(seen[0]!.body), recipe);
        assert.deepEqual(JSON.parse(seen[1]!.body), secret);
        for (const { headers } of seen) {
          assert.equal(headers.authorization, "Bearer server-secret");
          assert.equal(headers["nylorun-subject"], undefined);
          assert.equal(headers["nylorun-scopes"], undefined);
        }
        const count = seen.length;
        // Another origin may not change an Environment.
        assert.equal((await send("PUT", "/v1/environments/a", { kind: "virtual" }, "https://evil.example")).status, 403);
        assert.equal((await send("DELETE", "/v1/environments/a", undefined, "https://evil.example")).status, 403);
        assert.equal((await send("POST", "/v1/environments/a/restore", { version: 1 }, "https://evil.example")).status, 403);
        // Nothing else under an Environment, and no protocol-10 sandbox or vault route.
        for (const [method, path] of [
          ["POST", "/v1/environments/a"],
          ["POST", "/v1/environments/a/secrets/x"],
          ["POST", "/v1/environments/a/files"],
          ["GET", "/v1/environments/a/files"],
          ["GET", "/v1/environments/a/versions/1"],
          ["DELETE", "/v1/environments/a/versions"],
          ["DELETE", "/v1/environments/a/versions/latest"],
          ["POST", "/v1/environments/a/versions"],
          ["GET", "/v1/sandboxes"],
          ["GET", "/v1/sandboxes/a"],
          ["GET", "/v1/tenant/vaults"],
          ["POST", "/v1/tenant/vaults"],
          ["GET", "/v1/vaults"],
        ] as const)
          assert.equal((await send(method, path, method === "GET" ? undefined : {})).status, 404, `${method} ${path}`);
        assert.equal(seen.length, count, "refused requests never reach Runtime");
      } finally {
        studio.close();
        await once(studio, "close");
      }
    },
  );
});

test("proxy opens a session as Studio's owner, on the Environment the request names", async () => {
  const bodies: unknown[] = [];
  await withUpstream(
    async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      bodies.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
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
        const opened = await fetch(`http://127.0.0.1:${address.port}/_studio/runtime/v1/sessions/s1`, {
          method: "PUT",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ requestId: "r", agentId: "a", ownerUserId: "alice", environment: "team/build" }),
        });
        assert.equal(opened.status, 200);
        assert.deepEqual(bodies, [
          { requestId: "r", agentId: "a", ownerUserId: "local-developer", environment: "team/build" },
        ]);
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
      const body = JSON.stringify({ url: "https://mcp.example.com/mcp", environmentId: "team/build" });
      try {
        const previewed = await fetch(url, { method: "POST", headers: { origin, "content-type": "application/json" }, body });
        assert.equal(previewed.status, 200);
        assert.equal(seen[0]!.path, "POST /v1/tenant/mcp/preview");
        assert.deepEqual(JSON.parse(seen[0]!.body), { url: "https://mcp.example.com/mcp", environmentId: "team/build" });
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

test("proxy forwards a credential coverage check against an Environment", async () => {
  const seen: { path: string; body: string; headers: Record<string, string | string[] | undefined> }[] = [];
  await withUpstream(
    async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      seen.push({ path: `${req.method} ${req.url}`, body, headers: { ...req.headers } });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ agentId: "triage", environmentId: "team/build", complete: true, entries: [] }));
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
        const checked = await post({ agentId: "triage", environmentId: "team/build" });
        assert.equal(checked.status, 200);
        assert.equal(seen[0]!.path, "POST /v1/tenant/credential-coverage");
        assert.deepEqual(JSON.parse(seen[0]!.body), { agentId: "triage", environmentId: "team/build" });
        assert.equal(seen[0]!.headers.authorization, "Bearer server-secret");
        assert.equal(seen[0]!.headers["nylorun-subject"], undefined);
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
