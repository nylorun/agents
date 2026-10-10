import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import test from "node:test";
import { proxyRuntime } from "../dist/proxy.js";

async function withProxy(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (url: string) => Promise<void>,
) {
  const upstream = createServer(handler);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const studio = createServer((req, res) => {
    void proxyRuntime(req, res, {
      origin: "https://studio.example",
      runtimeUrl: `http://127.0.0.1:${upstreamAddress.port}`,
      serverKey: "private-studio-key",
    });
  });
  studio.listen(0, "127.0.0.1");
  await once(studio, "listening");
  const address = studio.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}/_studio/runtime`);
  } finally {
    studio.closeAllConnections();
    upstream.closeAllConnections();
    studio.close();
    upstream.close();
  }
}

test(
  "only shipped resource reads reach Runtime, with encoded ids and queries unchanged",
  { timeout: 10000 },
  async () => {
    const seen: string[] = [];
    await withProxy(
      (req, res) => {
        seen.push(`${req.method} ${req.url}`);
        assert.equal(req.headers.authorization, "Bearer private-studio-key");
        res.end("{}");
      },
      async (base) => {
        const reads = [
          "/v1/sandboxes?limit=50&label=project%3Dbuild&cursor=c",
          "/v1/sandboxes/team%2Fa",
          "/v1/sandboxes/team%2Fa/events?from=2",
          "/v1/artifacts?sessionId=s1",
          "/v1/artifacts/a",
          "/v1/artifacts/a/versions/3/tree",
          "/v1/artifacts/a/versions/3/diff?from=2",
        ];
        for (const path of reads)
          assert.equal((await fetch(base + path)).status, 200, path);
        for (const path of [
          "/v1/sandboxes/a/files",
          "/v1/sandboxes/a/snapshot",
          "/v1/artifacts/a/versions",
          "/v1/artifacts/a/versions/0/content",
          "/v1/artifacts/a/versions/2/files/raw/path",
        ])
          assert.equal((await fetch(base + path)).status, 404, path);
        for (const method of ["DELETE", "PUT", "POST"])
          assert.equal(
            (await fetch(base + "/v1/sandboxes/a", { method })).status,
            404,
          );
        assert.deepEqual(
          seen,
          reads.map((path) => `GET ${path}`),
        );
      },
    );
  },
);

test(
  "content is streamed as an attachment, with Range/If-Range and 206/416 headers preserved",
  { timeout: 10000 },
  async () => {
    await withProxy(
      (req, res) => {
        assert.ok(
          String(req.headers["accept-encoding"])
            .split(",")
            .every((value) => value.trim() === "identity"),
        );
        assert.equal(req.headers["if-range"], '"sha"');
        assert.equal(
          req.url,
          "/v1/artifacts/a/versions/2/files/nested%2Fa.html",
        );
        if (req.headers.range === "bytes=99-") {
          res.writeHead(416, { "content-range": "bytes */6" });
          return res.end();
        }
        assert.equal(req.headers.range, "bytes=0-2");
        res.writeHead(206, {
          "content-type": "text/html",
          "content-length": "3",
          "content-range": "bytes 0-2/6",
          "accept-ranges": "bytes",
          etag: '"sha"',
          "content-disposition": 'inline; filename="a.html"',
        });
        res.write("ab");
        res.end("c");
      },
      async (base) => {
        const url = base + "/v1/artifacts/a/versions/2/files/nested%2Fa.html";
        const response = await fetch(url, {
          headers: { range: "bytes=0-2", "if-range": '"sha"' },
        });
        assert.equal(response.status, 206);
        for (const [header, value] of Object.entries({
          "content-length": "3",
          "content-range": "bytes 0-2/6",
          etag: '"sha"',
          "accept-ranges": "bytes",
          "content-disposition": 'attachment; filename="a.html"',
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox; default-src 'none'",
        }))
          assert.equal(response.headers.get(header), value, header);
        assert.equal(await response.text(), "abc");
        const outside = await fetch(url, {
          headers: { range: "bytes=99-", "if-range": '"sha"' },
        });
        assert.equal(outside.status, 416);
        assert.equal(outside.headers.get("content-range"), "bytes */6");
      },
    );
  },
);

test(
  "a download link is minted with authenticated same-origin access; a native capability read forwards no Studio credential",
  { timeout: 10000 },
  async () => {
    const bodies: unknown[] = [];
    await withProxy(
      async (req, res) => {
        if (req.method === "POST") {
          assert.equal(req.headers.authorization, "Bearer private-studio-key");
          let raw = "";
          for await (const chunk of req) raw += chunk;
          bodies.push(JSON.parse(raw));
          res.end('{"path":"/v1/artifact-links/token"}');
        } else {
          assert.equal(req.headers.authorization, undefined);
          res.writeHead(401, { "content-type": "application/json" });
          res.end('{"code":"token_expired"}');
        }
      },
      async (base) => {
        const url = base + "/v1/artifacts/a/links";
        assert.equal(
          (
            await fetch(url, {
              method: "POST",
              headers: {
                origin: "https://evil.example",
                "content-type": "application/json",
              },
              body: '{"version":2}',
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await fetch(url, {
              method: "POST",
              headers: {
                origin: "https://studio.example",
                "content-type": "application/json",
              },
              body: "{}",
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await fetch(url, {
              method: "POST",
              headers: {
                origin: "https://studio.example",
                "content-type": "application/json",
              },
              body: '{"version":2,"file":"nested/a.html","expiresIn":900}',
            })
          ).status,
          200,
        );
        assert.deepEqual(bodies, [
          { version: 2, file: "nested/a.html", expiresIn: 60 },
        ]);
        const expired = await fetch(base + "/v1/artifact-links/token");
        assert.equal(expired.status, 401);
        assert.equal((await expired.json()).code, "token_expired");
      },
    );
  },
);

test("proxied Studio requires a session for metadata and link minting, but accepts only the Runtime capability for download", async () => {
  const { startStudioServer } = await import("../dist/server.js");
  const { PROTOCOL_VERSION, PROTOCOL_FEATURES } =
    await import("@nylorun/agents");
  const seen: string[] = [];
  const upstream = createServer((req, res) => {
    const path = req.url!;
    res.setHeader("content-type", "application/json");
    if (path === "/health")
      return res.end(
        JSON.stringify({
          protocol: {
            min: PROTOCOL_VERSION,
            max: PROTOCOL_VERSION,
            features: [...PROTOCOL_FEATURES],
          },
        }),
      );
    if (path === "/v1/tenant")
      return res.end(
        JSON.stringify({ tenant: { id: "tn_test", name: "Test" } }),
      );
    if (!path.startsWith("/v1/artifact-links/")) return res.end("{}");
    seen.push(path);
    assert.equal(req.headers.authorization, undefined);
    if (path.endsWith("/expired")) {
      res.statusCode = 401;
      return res.end('{"code":"token_expired"}');
    }
    res.setHeader("content-type", "text/html");
    res.end("<p>Export</p>");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const studio = await startStudioServer({
    runtimeUrl: `http://127.0.0.1:${address.port}`,
    adminKey: "e".repeat(64),
    port: 0,
    allowedHosts: ["studio.example"],
    log: () => {},
  });
  const base = studio.url + "/_studio/tenants/tn_test/runtime";
  const headers = { host: "studio.example" };
  const fetchWithHost = (
    url: string,
    options: {
      method?: string;
      headers: Record<string, string>;
      body?: string;
    },
  ) =>
    new Promise<Response>((resolve, reject) => {
      const target = new URL(url);
      const request = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          ...options,
        },
        async (response) => {
          const chunks: Buffer[] = [];
          for await (const chunk of response) chunks.push(Buffer.from(chunk));
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode,
              headers: Object.fromEntries(
                Object.entries(response.headers).filter(
                  ([, value]) => typeof value === "string",
                ),
              ) as Record<string, string>,
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(options.body);
    });
  try {
    assert.equal(
      (await fetchWithHost(base + "/v1/artifacts/a", { headers })).status,
      401,
    );
    assert.equal(
      (
        await fetchWithHost(base + "/v1/artifacts/a/links", {
          method: "POST",
          headers: {
            ...headers,
            origin: "http://studio.example",
            "content-type": "application/json",
          },
          body: '{"version":2}',
        })
      ).status,
      401,
    );
    const download = await fetchWithHost(base + "/v1/artifact-links/valid", {
      headers,
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-disposition"), "attachment");
    assert.equal(await download.text(), "<p>Export</p>");
    assert.equal(
      (await fetchWithHost(base + "/v1/artifact-links/expired", { headers }))
        .status,
      401,
    );
    assert.equal(
      (
        await fetchWithHost(
          base.replace("tn_test", "tn_other") + "/v1/artifact-links/valid",
          { headers },
        )
      ).status,
      404,
    );
    assert.deepEqual(seen, [
      "/v1/artifact-links/valid",
      "/v1/artifact-links/expired",
    ]);
  } finally {
    await studio.close();
    upstream.closeAllConnections();
    upstream.close();
  }
});
