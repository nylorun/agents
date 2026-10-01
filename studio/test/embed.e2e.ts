/**
 * Embedding end to end (Studio §8), in Chromium and WebKit: a fixture embedder
 * on another origin frames the real dashboard, gets login tokens from a stub
 * "Babai service" that holds the admin key, and speaks the message protocol.
 *
 * Run with `npm run test:embed` (builds first). Not part of `npm run check`:
 * it needs Playwright's browsers (`npx playwright install chromium webkit`).
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Browser, type BrowserType, type Frame, type Page } from "playwright";
import { PROTOCOL_FEATURES, PROTOCOL_VERSION } from "@nylorun/agents";
import { startStudioServer } from "../dist/server.js";

const ADMIN_KEY = "e".repeat(64);
const TENANT = "tn_00000000000000000000000001";
const AGENT = "a1";
const SESSION = "s1";
const WEB_ROOT = fileURLToPath(new URL("../dist/web", import.meta.url));

async function listen(server: Server, port = 0): Promise<number> {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

/**
 * Just enough Runtime for the dashboard to open one session. `listsMissing`
 * answers `{}` where the dashboard expects provider and vault lists.
 */
async function fakeRuntime({ listsMissing = false } = {}) {
  const session = {
    id: SESSION,
    agentId: AGENT,
    ownerUserId: "local-developer",
    manifestHash: "h",
    implementationVersion: "1",
    status: "idle",
    activeTurnId: null,
    vaultIds: [],
    credentialSelections: [],
    sandboxOwnerId: null,
    sandbox: null,
    mcpSnapshot: null,
    mcpDiagnostics: [],
    actions: [],
    uncertainEffects: [],
  };
  const server = createServer(async (req, res) => {
    for await (const _ of req) void _;
    const path = (req.url ?? "").split("?")[0];
    res.setHeader("content-type", "application/json");
    if (path === "/health")
      return res.end(
        JSON.stringify({
          status: "ok",
          protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION, features: [...PROTOCOL_FEATURES, "derived-principals"] },
        }),
      );
    if (path === "/v1/admin/tenants")
      return res.end(JSON.stringify([{ id: TENANT, name: "orders", state: "open", envelope: null }]));
    if (path === "/v1/agents")
      return res.end(
        JSON.stringify({
          agents: [
            { agentId: AGENT, manifest: { id: AGENT, name: "Agent One", capabilities: [] }, manifestHash: "h", implementationVersion: "1" },
          ],
        }),
      );
    if (path === "/v1/sessions")
      return res.end(JSON.stringify({ sessions: [{ id: SESSION, agentId: AGENT, ownerUserId: "local-developer", status: "idle", activeTurnId: null }] }));
    if (path === `/v1/sessions/${SESSION}`) return res.end(JSON.stringify(session));
    if (path.endsWith("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return; // held open, like a live stream
    }
    if (path.endsWith("/items")) return res.end(JSON.stringify({ items: [], cursor: null }));
    if (listsMissing && ["/v1/tenant/providers", "/v1/tenant/models", "/v1/vaults"].includes(path))
      return res.end(JSON.stringify({}));
    if (path === "/v1/tenant/providers" || path === "/v1/tenant/models")
      return res.end(JSON.stringify({ providers: [] }));
    if (path === "/v1/vaults") return res.end(JSON.stringify({ vaults: [] }));
    if (path === "/v1/tenant/model") return res.end(JSON.stringify({ configured: false }));
    res.end(JSON.stringify({}));
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, close: () => (server.closeAllConnections(), server.close()) };
}

/** The fixture embedder: a page that frames Studio, and a stub service that mints tokens. */
async function embedder(studioUrl: string, port = 0) {
  const server = createServer(async (req, res) => {
    if (req.url === "/mint") {
      const minted = await fetch(`${studioUrl}/_studio/login-tokens`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ tenant: TENANT, subject: "user_1" }),
      });
      res.setHeader("content-type", "application/json");
      return res.end(await minted.text());
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>embedder</title>
<iframe id="studio" style="width:1000px;height:700px" src="${studioUrl}/tenants/${TENANT}/sessions/${SESSION}?embed=1"></iframe>
<script>
  const studioOrigin = ${JSON.stringify(new URL(studioUrl).origin)};
  const frame = document.getElementById("studio");
  window.__messages = [];
  const env = (kind, payload) => ({ type: "nylorun.studio", protocol: 1, kind, ...payload });
  const mint = () => fetch("/mint").then((r) => r.json()).then((b) => b.token);
  window.__post = (kind, payload) => frame.contentWindow.postMessage(env(kind, payload), studioOrigin);
  window.addEventListener("message", async (event) => {
    if (event.source !== frame.contentWindow || event.origin !== studioOrigin) return;
    window.__messages.push(event.data);
    if (event.data.kind === "ready")
      window.__post("init", { token: await mint(), theme: { mode: "light" } });
    if (event.data.kind === "token.expiring")
      window.__post("token.refresh", { token: await mint() });
  });
</script>`);
  });
  const bound = await listen(server, port);
  return { origin: `http://127.0.0.1:${bound}`, close: () => (server.closeAllConnections(), server.close()) };
}

type Message = { kind: string; route?: string; [key: string]: unknown };

const messages = (page: Page) => page.evaluate(() => (window as unknown as { __messages: Message[] }).__messages);

async function waitForMessage(page: Page, match: (message: Message) => boolean, what: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await messages(page)).some(match)) return;
    await page.waitForTimeout(100);
  }
  assert.fail(`No ${what} message; got ${JSON.stringify(await messages(page))}; page errors: ${JSON.stringify((page as Page & { __errors?: string[] }).__errors ?? [])}`);
}

function studioFrame(page: Page, studioUrl: string): Frame {
  const frame = page.frames().find((f) => f.url().startsWith(studioUrl));
  assert.ok(frame, "Studio frame not found");
  return frame;
}

async function withStack(
  run: (context: { studioUrl: string; embedderOrigin: string; clock: { offset: number } }) => Promise<void>,
  options: { listsMissing?: boolean } = {},
) {
  const runtime = await fakeRuntime(options);
  // Embedder origins are only known once its port is; reserve it first.
  const reserve = createServer();
  const embedPort = await listen(reserve);
  reserve.close();
  await once(reserve, "close");
  const embedderOrigin = `http://127.0.0.1:${embedPort}`;
  const clock = { offset: 0 };
  const studio = await startStudioServer({
    runtimeUrl: runtime.url,
    adminKey: ADMIN_KEY,
    port: 0,
    webRoot: WEB_ROOT,
    frameAncestors: [embedderOrigin],
    now: () => Date.now() + clock.offset,
    log: () => {},
  });
  const app = await embedder(studio.url, embedPort);
  try {
    await run({ studioUrl: studio.url, embedderOrigin, clock });
  } finally {
    app.close();
    await studio.close();
    runtime.close();
  }
}

for (const [name, browserType] of [
  ["chromium", chromium],
  ["webkit", webkit],
] as [string, BrowserType][]) {
  test(`${name}: an allowlisted app embeds Studio, deep-linked and signed in by message`, async () => {
    const browser: Browser = await browserType.launch();
    try {
      await withStack(async ({ studioUrl, embedderOrigin, clock }) => {
        const page = await browser.newPage();
        const pageErrors: string[] = [];
        (page as Page & { __errors?: string[] }).__errors = pageErrors;
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const studioRequests: { url: string; authorization?: string }[] = [];
        page.on("request", (request) => {
          if (request.url().startsWith(`${studioUrl}/_studio/`))
            studioRequests.push({ url: request.url(), authorization: request.headers().authorization });
        });
        await page.goto(embedderOrigin);

        // Handshake, then the session route replaces itself with the agent's.
        await waitForMessage(page, (m) => m.kind === "ready", "ready");
        await waitForMessage(page, (m) => m.kind === "session", "session");
        const fullRoute = `/tenants/${TENANT}/agents/${AGENT}/sessions/${SESSION}`;
        await waitForMessage(page, (m) => m.kind === "route.changed" && m.route === fullRoute, "route.changed");
        // The page Studio was opened on is reported once signed in, before the redirect.
        const routes = (await messages(page)).filter((m) => m.kind === "route.changed").map((m) => m.route);
        assert.ok(
          routes.includes(`/tenants/${TENANT}/sessions/${SESSION}`) || routes[0] === fullRoute,
          JSON.stringify(routes),
        );
        const session = (await messages(page)).find((m) => m.kind === "session")!;
        assert.equal(session.tenant, TENANT);
        assert.equal(session.subject, "user_1");

        // Every API call carried the bearer; none relied on a cookie.
        const api = studioRequests.filter((r) => !r.url.endsWith("/_studio/sessions"));
        assert.ok(api.length > 0);
        for (const request of api) assert.match(request.authorization ?? "", /^Bearer v2\./, request.url);

        // Embed mode: no Studio branding or Tenant switcher.
        const frame = studioFrame(page, studioUrl);
        assert.equal(await frame.locator("text=Switch Tenant").count(), 0);
        assert.equal(await frame.evaluate(() => document.documentElement.dataset.embed), "1");

        // Theme follows the app.
        await page.evaluate(() => (window as any).__post("theme.changed", { theme: { mode: "dark", accent: "#3366ff" } }));
        await frame.waitForFunction(() => document.documentElement.classList.contains("dark"));
        assert.equal(await frame.evaluate(() => document.documentElement.style.getPropertyValue("--primary")), "#3366ff");

        // The app navigates; Studio reports the route back.
        await page.evaluate((route) => (window as any).__post("navigate", { route }), `/tenants/${TENANT}/vault`);
        await waitForMessage(page, (m) => m.kind === "route.changed" && m.route === `/tenants/${TENANT}/vault`, "vault route");
        // Another Tenant's route is refused.
        await page.evaluate(() => (window as any).__post("navigate", { route: "/tenants/tn_other/vault" }));
        await waitForMessage(page, (m) => m.kind === "error" && m.code === "route_other_tenant", "route_other_tenant");

        // No token in storage or cookies.
        const stored = await frame.evaluate(() =>
          JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]),
        );
        assert.ok(!stored.includes("v2."), stored);

        // The server's clock passes the session's expiry: the next call is
        // refused, Studio asks the app, and carries on with a new session.
        const sessionsBefore = (await messages(page)).filter((m) => m.kind === "session").length;
        clock.offset += 61 * 60 * 1000;
        await page.evaluate((route) => (window as any).__post("navigate", { route }), `/tenants/${TENANT}/settings`);
        await waitForMessage(page, (m) => m.kind === "token.expiring", "token.expiring");
        const deadline = Date.now() + 15_000;
        while ((await messages(page)).filter((m) => m.kind === "session").length <= sessionsBefore) {
          assert.ok(Date.now() < deadline, "no new session after expiry");
          await page.waitForTimeout(100);
        }
        assert.deepEqual(pageErrors, []);
        await page.close();
      });
    } finally {
      await browser.close();
    }
  });

  test(`${name}: an origin not on the allowlist cannot frame Studio`, async () => {
    const browser: Browser = await browserType.launch();
    try {
      await withStack(async ({ studioUrl }) => {
        const outsider = await embedder(studioUrl);
        try {
          const page = await browser.newPage();
          await page.goto(outsider.origin);
          await page.waitForTimeout(2_000);
          const frame = page.frames().find((f) => f.url().startsWith(studioUrl));
          const rendered = frame
            ? await frame
                .evaluate(() => document.querySelector('meta[name="nylorun-frame-ancestors"]') !== null)
                .catch(() => false)
            : false;
          assert.equal(rendered, false, "Studio rendered inside a non-allowlisted origin");
          assert.deepEqual(await messages(page), []);
          await page.close();
        } finally {
          outsider.close();
        }
      });
    } finally {
      await browser.close();
    }
  });
}

test("a normal browser tab still signs in with the cookie and lists Tenants", async () => {
  const browser = await chromium.launch();
  try {
    await withStack(async ({ studioUrl }) => {
      const minted = await fetch(`${studioUrl}/_studio/login-tokens`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      const { url } = (await minted.json()) as { url: string };
      const page = await browser.newPage();
      const signedOut = await browser.newPage();
      await signedOut.goto(studioUrl);
      await signedOut.getByRole("heading", { name: "Sign in to Studio" }).waitFor();
      await page.goto(url);
      await page.getByRole("heading", { name: "Tenants" }).waitFor();
      await page.getByText("orders").waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.embed), undefined);
    });
  } finally {
    await browser.close();
  }
});

test("a Runtime answering {} for provider and vault lists leaves the dashboard rendered", async () => {
  const browser = await chromium.launch();
  try {
    await withStack(
      async ({ studioUrl }) => {
        const minted = await fetch(`${studioUrl}/_studio/login-tokens`, {
          method: "POST",
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
        });
        const { url } = (await minted.json()) as { url: string };
        const page = await browser.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(url);
        await page.getByRole("heading", { name: "Tenants" }).waitFor();

        // The session's model picker reports the missing lists instead of crashing.
        await page.goto(`${studioUrl}/tenants/${TENANT}/agents/${AGENT}/sessions/${SESSION}`);
        await page.getByText("The Runtime did not return connected model providers.").waitFor();
        await page.getByText("Agent One").first().waitFor();

        await page.goto(`${studioUrl}/tenants/${TENANT}/vault`);
        await page.getByText("The Runtime did not return the Tenant's vaults.").waitFor();
        assert.equal(await page.getByText("Something went wrong in this view").count(), 0);
        assert.deepEqual(pageErrors, []);
      },
      { listsMissing: true },
    );
  } finally {
    await browser.close();
  }
});
