import assert from "node:assert/strict";
import test from "node:test";
import {
  StudioSignedOutError,
  createTenantClient,
  fetchHello,
  listTenants,
  studioFetch,
  tenantHref,
  tenantRuntime,
  tenantRuntimePath,
  tenantScope,
} from "../web/src/proxy-client.ts";

function recorder(respond = () => Response.json({})) {
  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ url: String(input), init });
    return respond(String(input), init);
  };
  return { calls, fetcher };
}

test("tenantScope maps /tenants/<id>/… to a router basename", () => {
  assert.deepEqual(tenantScope("/tenants/tn_1/agents/a/sessions/s"), {
    tenantId: "tn_1",
    basename: "/tenants/tn_1",
  });
  assert.deepEqual(tenantScope("/tenants/tn%201"), {
    tenantId: "tn 1",
    basename: "/tenants/tn%201",
  });
  for (const path of ["/", "/vault", "/tenants", "/tenants/", "/tenants/%E0%A4%A"])
    assert.equal(tenantScope(path), undefined, path);
  assert.equal(tenantHref("tn 1"), "/tenants/tn%201");
  assert.equal(tenantRuntimePath("tn/1"), "/_studio/tenants/tn%2F1/runtime");
});

test("studioFetch is same-origin only and sends the session cookie", async () => {
  const { calls, fetcher } = recorder();
  await studioFetch("/_studio/tenants", { method: "GET" }, fetcher);
  assert.equal(calls[0].url, "/_studio/tenants");
  assert.equal(calls[0].init.credentials, "same-origin");
  for (const path of ["https://evil.example/", "//evil.example/x", "_studio/x"])
    assert.throws(() => studioFetch(path, undefined, fetcher), /same-origin/);
});

test("tenantRuntime prefixes the Tenant's proxy path and carries no bearer", async () => {
  const { calls, fetcher } = recorder();
  await tenantRuntime("tn_1", fetcher)("/v1/tenant/model", { method: "PUT", body: "{}" });
  assert.equal(calls[0].url, "/_studio/tenants/tn_1/runtime/v1/tenant/model");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(new Headers(calls[0].init.headers).has("authorization"), false);
});

test("createTenantClient strips the SDK bearer and targets the Tenant proxy", async () => {
  const { calls, fetcher } = recorder((url) =>
    url.endsWith("/health")
      ? Response.json({
          protocol: { min: 1, max: 99, features: ["runtime-tenants", "admin-status", "studio-principal"] },
        })
      : Response.json({ agents: [] }),
  );
  const client = createTenantClient("tn_1", { origin: "http://localhost:4170", fetcher });
  await client.listAgents();
  const agents = calls.find((call) => call.url.endsWith("/v1/agents"));
  assert.ok(agents, JSON.stringify(calls.map((call) => call.url)));
  assert.equal(agents.url, "http://localhost:4170/_studio/tenants/tn_1/runtime/v1/agents");
  assert.equal(new Headers(agents.init.headers).has("authorization"), false);
  assert.equal(agents.init.credentials, "same-origin");
});

test("fetchHello and listTenants report a missing session", async () => {
  const signedOut = recorder(() => new Response("{}", { status: 401 }));
  await assert.rejects(fetchHello(signedOut.fetcher), StudioSignedOutError);
  await assert.rejects(listTenants(signedOut.fetcher), StudioSignedOutError);

  const failing = recorder(() => Response.json({ message: "Runtime down" }, { status: 502 }));
  await assert.rejects(listTenants(failing.fetcher), /Runtime down/);

  const ok = recorder((url) =>
    url === "/_studio/tenants"
      ? Response.json({ tenants: [{ id: "tn_1", name: "orders", state: "open" }] })
      : Response.json({ version: "1.0.0", runtime: { compatible: true } }),
  );
  assert.deepEqual(await listTenants(ok.fetcher), [{ id: "tn_1", name: "orders", state: "open" }]);
  assert.deepEqual((await fetchHello(ok.fetcher)).runtime, { compatible: true });
});
