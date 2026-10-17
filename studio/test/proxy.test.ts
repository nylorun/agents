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

test("proxy forwards Agent and agent manifest reads and same-origin writes on the Runtime API, as they are", async () => {
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
      const send = (method: string, path: string, body?: unknown, from = origin, extra: Record<string, string> = {}) =>
        fetch(base + path, {
          method,
          headers: { origin: from, ...extra, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      try {
        const agent = { requestId: "r", manifest: "triage@2", owner: "alice", labels: { team: "a" } };
        assert.equal((await send("PUT", "/v1/agents/team%2Fbuild", agent)).status, 200);
        const secret = { requestId: "r", type: "bearer", url: "https://mcp.example.com/mcp", value: "tok" };
        assert.equal((await send("PUT", "/v1/agents/team%2Fbuild/secrets/github", secret)).status, 200);
        assert.equal((await send("POST", "/v1/agents/team%2Fbuild/stop", {})).status, 200);
        assert.equal((await send("POST", "/v1/agents/team%2Fbuild/restart", { requestId: "r", retry: true })).status, 200);
        assert.equal((await send("POST", "/v1/agents/team%2Fbuild/reset", {})).status, 200);
        assert.equal((await send("POST", "/v1/agents/team%2Fbuild/snapshot", {})).status, 200);
        assert.equal((await send("POST", "/v1/agents/team%2Fbuild/restore", { requestId: "r", version: 2 })).status, 200);
        assert.equal((await send("DELETE", "/v1/agents/team%2Fbuild/versions/2")).status, 200);
        assert.equal((await send("DELETE", "/v1/agents/team%2Fbuild/secrets/github")).status, 200);
        assert.equal((await send("DELETE", "/v1/agents/team%2Fbuild")).status, 200);
        assert.equal((await send("POST", "/v1/agents/team%2Fbuild/fork", { requestId: "r", id: "team/next" }, origin, { "if-match": "9" })).status, 200);
        const manifest = { requestId: "r", manifestSchemaVersion: 8, name: "triage", harness: {} };
        assert.equal((await send("PUT", "/v1/agent-manifests/triage?dryRun=true", manifest, origin, { "if-match": "2" })).status, 200);
        assert.equal((await send("PUT", "/v1/agent-manifests/triage", manifest, origin, { "if-match": "2" })).status, 200);
        for (const path of [
          "/v1/agents",
          "/v1/agents?limit=50&state=failing&manifest=triage&label=team%3Da",
          "/v1/agents/team%2Fbuild",
          "/v1/agents/team%2Fbuild/events?from=2",
          "/v1/agents/team%2Fbuild/versions",
          "/v1/agents/team%2Fbuild/secrets",
          "/v1/agents/team%2Fbuild/secrets/github",
          "/v1/agent-manifests",
          "/v1/agent-manifests/triage",
          "/v1/agent-manifests/triage/versions",
          "/v1/agent-manifests/triage/versions/2",
        ])
          assert.equal((await fetch(base + path)).status, 200, path);
        assert.deepEqual(
          seen.map((entry) => entry.path),
          [
            "PUT /v1/agents/team%2Fbuild",
            "PUT /v1/agents/team%2Fbuild/secrets/github",
            "POST /v1/agents/team%2Fbuild/stop",
            "POST /v1/agents/team%2Fbuild/restart",
            "POST /v1/agents/team%2Fbuild/reset",
            "POST /v1/agents/team%2Fbuild/snapshot",
            "POST /v1/agents/team%2Fbuild/restore",
            "DELETE /v1/agents/team%2Fbuild/versions/2",
            "DELETE /v1/agents/team%2Fbuild/secrets/github",
            "DELETE /v1/agents/team%2Fbuild",
            "POST /v1/agents/team%2Fbuild/fork",
            "PUT /v1/agent-manifests/triage?dryRun=true",
            "PUT /v1/agent-manifests/triage",
            "GET /v1/agents",
            "GET /v1/agents?limit=50&state=failing&manifest=triage&label=team%3Da",
            "GET /v1/agents/team%2Fbuild",
            "GET /v1/agents/team%2Fbuild/events?from=2",
            "GET /v1/agents/team%2Fbuild/versions",
            "GET /v1/agents/team%2Fbuild/secrets",
            "GET /v1/agents/team%2Fbuild/secrets/github",
            "GET /v1/agent-manifests",
            "GET /v1/agent-manifests/triage",
            "GET /v1/agent-manifests/triage/versions",
            "GET /v1/agent-manifests/triage/versions/2",
          ],
        );
        // A manifest save names the version it was made over; nothing else carries If-Match.
        assert.equal(seen[10]!.headers["if-match"], undefined);
        assert.equal(seen[11]!.headers["if-match"], "2");
        assert.equal(seen[12]!.headers["if-match"], "2");
        // The owner guard is the operator's: an Agent write is not a session's owner.
        assert.deepEqual(JSON.parse(seen[0]!.body), agent);
        assert.deepEqual(JSON.parse(seen[1]!.body), secret);
        assert.deepEqual(JSON.parse(seen[3]!.body), { requestId: "r", retry: true });
        for (const { headers } of seen) {
          assert.equal(headers.authorization, "Bearer server-secret");
          assert.equal(headers["nylorun-subject"], undefined);
          assert.equal(headers["nylorun-scopes"], undefined);
        }
        const count = seen.length;
        // Another origin may not change an Agent.
        assert.equal((await send("PUT", "/v1/agents/a", { manifest: "m" }, "https://evil.example")).status, 403);
        assert.equal((await send("DELETE", "/v1/agents/a", undefined, "https://evil.example")).status, 403);
        assert.equal((await send("POST", "/v1/agents/a/restore", { version: 1 }, "https://evil.example")).status, 403);
        assert.equal((await send("POST", "/v1/agents/a/restart", {}, "https://evil.example")).status, 403);
        assert.equal((await send("POST", "/v1/agents/a/fork", { id: "b" }, "https://evil.example")).status, 403);
        assert.equal((await send("PUT", "/v1/agent-manifests/m", { name: "m" }, "https://evil.example")).status, 403);
        // Nothing else under an Agent, no protocol-15 Environment route, no protocol-10 sandbox or vault.
        for (const [method, path] of [
          ["POST", "/v1/agents/a"],
          ["POST", "/v1/agents/a/secrets/x"],
          ["POST", "/v1/agents/a/files"],
          ["GET", "/v1/agents/a/files"],
          ["GET", "/v1/agents/a/versions/1"],
          ["DELETE", "/v1/agents/a/versions"],
          ["DELETE", "/v1/agents/a/versions/latest"],
          ["POST", "/v1/agents/a/versions"],
          // A manifest is saved, never deleted, from Studio.
          ["DELETE", "/v1/agent-manifests/m"],
          ["POST", "/v1/agent-manifests/m"],
          ["GET", "/v1/agent-manifests/m/versions/latest"],
          ["GET", "/v1/environments"],
          ["GET", "/v1/environments/a"],
          ["PUT", "/v1/environments/a"],
          ["GET", "/v1/environment-manifests"],
          ["PUT", "/v1/environment-manifests/m"],
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

test("proxy opens a session as Studio's owner, on the Agent the request names", async () => {
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
          body: JSON.stringify({ requestId: "r", agent: "team/build", ownerUserId: "alice" }),
        });
        assert.equal(opened.status, 200);
        assert.deepEqual(bodies, [
          { requestId: "r", agent: "team/build", ownerUserId: "local-developer" },
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
      const body = JSON.stringify({ url: "https://mcp.example.com/mcp", agentId: "team/build" });
      try {
        const previewed = await fetch(url, { method: "POST", headers: { origin, "content-type": "application/json" }, body });
        assert.equal(previewed.status, 200);
        assert.equal(seen[0]!.path, "POST /v1/tenant/mcp/preview");
        assert.deepEqual(JSON.parse(seen[0]!.body), { url: "https://mcp.example.com/mcp", agentId: "team/build" });
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

test("proxy forwards an Agent's credential coverage check", async () => {
  const seen: { path: string; body: string; headers: Record<string, string | string[] | undefined> }[] = [];
  await withUpstream(
    async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      seen.push({ path: `${req.method} ${req.url}`, body, headers: { ...req.headers } });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ agentId: "team/build", complete: true, entries: [] }));
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
        const checked = await post({ agentId: "team/build" });
        assert.equal(checked.status, 200);
        assert.equal(seen[0]!.path, "POST /v1/tenant/credential-coverage");
        assert.deepEqual(JSON.parse(seen[0]!.body), { agentId: "team/build" });
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

test("proxy forwards a session's pinned manifest and usage reads and nothing else under the session", async () => {
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
        assert.equal((await fetch(`${base}/v1/sessions/s1/usage`)).status, 200);
        assert.equal((await fetch(`${base}/v1/sessions/s1/calls/model?limit=50&cursor=c1`)).status, 200);
        assert.equal((await fetch(`${base}/v1/sessions/s1/calls/tool`)).status, 404);
        assert.equal((await fetch(`${base}/v1/sessions/s1/turns/t1/trace`)).status, 404);
        assert.equal((await fetch(`${base}/v1/sessions/s1/manifest`, { method: "DELETE" })).status, 404);
        assert.equal((await fetch(`${base}/v1/sessions/s1/usage`, { method: "POST" })).status, 404);
        assert.deepEqual(seen, [
          "GET /v1/sessions/s1/manifest",
          "GET /v1/sessions/s1/usage",
          "GET /v1/sessions/s1/calls/model?limit=50&cursor=c1",
        ]);
      } finally {
        studio.close();
        await once(studio, "close");
      }
    },
  );
});

test("proxy streams a same-origin attachment upload into a session that exists, with its type and length", async () => {
  const seen: { line: string; body: Buffer; headers: Record<string, string | string[] | undefined> }[] = [];
  await withUpstream(
    async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      seen.push({ line: `${req.method} ${req.url}`, body: Buffer.concat(chunks), headers: { ...req.headers } });
      if (req.method === "GET")
        return req.url === "/v1/sessions/s1"
          ? (res.writeHead(200, { "content-type": "application/json" }), res.end("{}"))
          : (res.writeHead(404, { "content-type": "application/json" }), res.end("{}"));
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ artifact: { artifactId: "art_1" }, version: { version: 1 } }));
    },
    async (upstreamUrl) => {
      const origin = "http://127.0.0.1:4161";
      const studio = createServer((req, res) => {
        void proxyRuntime(req, res, { origin, runtimeUrl: upstreamUrl, serverKey: "server-secret", maxUploadBytes: 16 });
      });
      studio.listen(0, "127.0.0.1");
      await once(studio, "listening");
      const address = studio.address();
      assert.ok(address && typeof address === "object");
      const base = `http://127.0.0.1:${address.port}/_studio/runtime/v1/artifacts`;
      const post = (query: string, body: BodyInit, headers: Record<string, string> = {}) =>
        fetch(`${base}${query}`, { method: "POST", headers: { origin, ...headers }, body });
      try {
        const uploaded = await post(
          "?name=chart.png&sessionId=s1&label=team%3Dops",
          new Uint8Array([137, 80, 78, 71]),
          { "content-type": "image/png" },
        );
        assert.equal(uploaded.status, 201);
        assert.deepEqual(
          seen.map((s) => s.line),
          ["GET /v1/sessions/s1", "POST /v1/artifacts?name=chart.png&sessionId=s1"],
          "only name and sessionId reach the Runtime",
        );
        const forwarded = seen[1]!;
        assert.deepEqual([...forwarded.body], [137, 80, 78, 71]);
        assert.equal(forwarded.headers["content-type"], "image/png");
        assert.equal(forwarded.headers["content-length"], "4");
        assert.equal(forwarded.headers.authorization, "Bearer server-secret");
        // No type: bytes.
        assert.equal((await post("?name=a.bin&sessionId=s1", new Blob([new Uint8Array([1])]))).status, 201);
        assert.equal(seen.at(-1)!.headers["content-type"], "application/octet-stream");
        const count = seen.length;
        // Refused before anything is forwarded.
        assert.equal((await post("?name=a.png", new Uint8Array([1]))).status, 400);
        assert.equal((await post("?sessionId=s1", new Uint8Array([1]))).status, 400);
        assert.equal(
          (await fetch(`${base}?name=a.png&sessionId=s1`, { method: "POST", headers: { origin: "https://evil.example" }, body: new Uint8Array([1]) })).status,
          403,
        );
        assert.equal((await post("?name=a.png&sessionId=s1", new Uint8Array(17))).status, 413);
        assert.equal(seen.length, count, "refused uploads never reach the Runtime");
        // A stream with no length.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.close();
          },
        });
        const unsized = await fetch(`${base}?name=a.png&sessionId=s1`, {
          method: "POST",
          headers: { origin },
          body: stream,
          duplex: "half",
        } as RequestInit);
        assert.equal(unsized.status, 411);
        assert.equal(seen.length, count);
        // A session that does not exist: checked, nothing uploaded.
        const missing = await post("?name=a.png&sessionId=s-missing", new Uint8Array([1]));
        assert.equal(missing.status, 404);
        assert.deepEqual(seen.slice(count).map((s) => s.line), ["GET /v1/sessions/s-missing"]);
      } finally {
        studio.close();
        await once(studio, "close");
      }
    },
  );
});

test("proxy forwards a same-origin model inputs change on the Management API", async () => {
  const seen: { line: string; body: string }[] = [];
  await withUpstream(
    async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      seen.push({ line: `${req.method} ${req.url}`, body });
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
      const url = `http://127.0.0.1:${address.port}/_studio/runtime/v1/tenant/models/inputs`;
      const body = JSON.stringify({ provider: "openai", model: "gpt-5", inputs: ["pdf"] });
      try {
        const put = (from: string) =>
          fetch(url, { method: "PUT", headers: { origin: from, "content-type": "application/json" }, body });
        assert.equal((await put(origin)).status, 200);
        assert.equal((await put("https://evil.example")).status, 403);
        assert.deepEqual(seen, [{ line: "PUT /v1/tenant/models/inputs", body }]);
      } finally {
        studio.close();
        await once(studio, "close");
      }
    },
  );
});

test("a JSON write past the default request body is read up to the Tenant's requestBodyBytes (B15c)", async () => {
  let limit = 2 * 1024 * 1024;
  const seen: string[] = [];
  await withUpstream(
    async (req, res) => {
      for await (const _ of req);
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/v1/tenant/limits" ? { limits: { requestBodyBytes: limit } } : { ok: true }));
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
      const put = (labels: Record<string, string>) =>
        fetch(`http://127.0.0.1:${address.port}/_studio/runtime/v1/agents/big`, {
          method: "PUT",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ requestId: "r", labels }),
        });
      try {
        // Within the default: no question to the Runtime.
        assert.equal((await put({ a: "small" })).status, 200);
        assert.deepEqual(seen, ["PUT /v1/agents/big"]);
        // Past it: the Tenant's limit decides.
        const big = { a: "x".repeat(1536 * 1024) };
        assert.equal((await put(big)).status, 200);
        assert.deepEqual(seen.slice(1), ["GET /v1/tenant/limits", "PUT /v1/agents/big"]);
        limit = 1024 * 1024;
        assert.equal((await put(big)).status, 413);
      } finally {
        studio.close();
        await once(studio, "close");
      }
    },
  );
});
