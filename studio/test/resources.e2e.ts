import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { startStudioServer } from "../dist/server.js";
import {
  resourceRuntime,
  TENANT,
  SESSION,
  SANDBOX,
} from "./support/resource-runtime.ts";

async function withStudio(
  run: (
    page: Page,
    base: string,
    requests: Awaited<ReturnType<typeof resourceRuntime>>["requests"],
  ) => Promise<void>,
  mobile = false,
) {
  const runtime = await resourceRuntime();
  const studio = await startStudioServer({
    runtimeUrl: runtime.url,
    adminKey: "e".repeat(64),
    port: 0,
    webRoot: fileURLToPath(new URL("../dist/web", import.meta.url)),
    log: () => {},
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    page.setDefaultTimeout(10000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await run(page, studio.url + `/tenants/${TENANT}`, runtime.requests);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      runtime.requests.filter(
        (r) => r.method !== "GET" && !r.path.endsWith("/links"),
      ),
      [],
      "resource browsing never mutates a session, sandbox or artifact",
    );
    assert.equal(
      runtime.requests.filter((r) => r.path === "/v1/artifacts").length,
      0,
      "never fetch an unbounded tenant artifact list",
    );
  } finally {
    await browser.close();
    await studio.close();
    runtime.close();
  }
}

test("sandboxes work before agent registration: server paging, label navigation, events and sessions", async () => {
  await withStudio(async (page, base, requests) => {
    await page.goto(base);
    // No agent is registered; the session list still lists the Tenant's sessions.
    await page
      .getByRole("heading", { name: "Sessions", exact: true })
      .waitFor();
    await page.getByRole("link", { name: "Sandboxes", exact: true }).click();
    await page.getByRole("button", { name: SANDBOX, exact: true }).waitFor();
    await page.getByRole("button", { name: "Load more sandboxes" }).click();
    await page.getByRole("button", { name: "z-last", exact: true }).waitFor();
    assert.ok(
      requests.some((r) => r.path === "/v1/sandboxes?limit=50&cursor=page2"),
    );
    await page
      .getByRole("textbox", { name: "Sandbox labels" })
      .fill("project=build");
    await page.getByRole("button", { name: "Apply labels" }).click();
    await page.waitForURL(/label=project%3Dbuild/);
    await page.getByRole("button", { name: SANDBOX, exact: true }).click();
    await page.getByText("Virtual workspace;", { exact: false }).waitFor();
    assert.ok(page.url().includes("selected=team%2Fbuild"));
    await page.getByRole("tab", { name: "Events", exact: true }).click();
    await page.getByText("0 · sandbox.created", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Refresh events" }).click();
    await page.getByText("1 · sandbox.suspended", { exact: false }).waitFor();
    assert.deepEqual(
      requests
        .filter((r) => r.path.includes("/sandboxes/team%2Fbuild/events"))
        .map((r) => r.path),
      [
        "/v1/sandboxes/team%2Fbuild/events?from=0",
        "/v1/sandboxes/team%2Fbuild/events?from=1",
      ],
    );
    await page.getByRole("tab", { name: "Sessions", exact: true }).click();
    await page.getByRole("link", { name: SESSION, exact: true }).click();
    await page.waitForURL(
      new RegExp(`/agents/external-agent/sessions/${SESSION}$`),
    );
    await page.getByRole("tab", { name: "Artifacts", exact: true }).click();
    await page
      .getByRole("button", { name: "report.html", exact: true })
      .click();
    await page.getByText("Report version 2", { exact: true }).waitFor();
    assert.ok(requests.some((r) => r.path.includes("sandboxId=team%2Fbuild")));
    await page
      .getByRole("link", { name: `Sandbox: ${SANDBOX}`, exact: true })
      .click();
    await page.getByRole("tab", { name: "Details", exact: true }).waitFor();
  });
});

test("artifacts pin versions, escape HTML, browse folder files and diff, and stream native downloads", async () => {
  await withStudio(async (page, base, requests) => {
    await page.goto(base + "/artifacts");
    await page
      .getByRole("heading", {
        name: "Tenant-wide artifact browsing needs a paged API",
      })
      .waitFor();
    await page
      .getByRole("textbox", { name: "Session ID", exact: true })
      .fill(SESSION);
    await page.getByRole("button", { name: "View session artifacts" }).click();
    await page
      .getByRole("button", { name: "report.html", exact: true })
      .click();
    await page.getByText("Report version 2", { exact: true }).waitFor();
    await page
      .getByRole("combobox", { name: "Artifact version" })
      .selectOption("1");
    await page.locator("pre", { hasText: "window.previewExecuted" }).waitFor();
    assert.equal(
      await page.evaluate(
        () => (window as unknown as Record<string, unknown>).previewExecuted,
      ),
      undefined,
    );
    assert.equal(
      await page.locator("h1", { hasText: "Report version 1" }).count(),
      0,
    );
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download", exact: true }).click(),
    ]);
    assert.equal(download.suggestedFilename(), "report.html");
    assert.equal(await download.failure(), null);
    assert.ok(
      requests.some(
        (r) =>
          r.method === "POST" &&
          JSON.stringify(r.body) === '{"version":1,"expiresIn":60}',
      ),
    );
    await page.getByRole("button", { name: "outputs", exact: true }).click();
    await page.getByRole("button", { name: /nested\/a \+b.html/ }).click();
    await page.getByText("Report version 2", { exact: true }).waitFor();
    assert.ok(
      requests.some(
        (r) =>
          r.path.endsWith("/versions/2/files/nested%2Fa%20%2Bb.html") &&
          r.range === "bytes=0-262144",
      ),
    );
    await page.getByRole("tab", { name: "Changes", exact: true }).click();
    await page.getByRole("heading", { name: "Added", exact: true }).waitFor();
    assert.ok(requests.some((r) => r.path.endsWith("/versions/2/diff?from=1")));
    await page.goBack();
    await page.getByRole("tab", { name: "Preview", exact: true }).waitFor();
    await page.goto(base + "/artifacts?selected=a-report&version=bogus");
    await page
      .getByText("Invalid artifact version.", { exact: true })
      .waitFor();
    await page.goto(base + "/artifacts?selected=a-report&version=99");
    await page
      .getByText("This artifact has no such version.", { exact: false })
      .waitFor();
    await page.goto(base + "/artifacts?selected=deleted&version=1");
    await page
      .getByRole("alert")
      .filter({ hasText: "Artifact not found" })
      .waitFor();
  });
});

test("an exact-version event opens the session artifact inspector, including through a session-only URL", async () => {
  await withStudio(async (page, base) => {
    await page.goto(
      base +
        `/sessions/${SESSION}?inspector=artifacts&artifact=a-report&artifactVersion=1`,
    );
    await page.locator("pre", { hasText: "Report version 1" }).waitFor();
    assert.ok(page.url().includes("artifactVersion=1"));
    await page.getByRole("tab", { name: "Events", exact: true }).click();
    await page
      .getByRole("button", { name: "report.html · v1", exact: true })
      .first()
      .click();
    await page
      .getByRole("tab", { name: "Artifacts", exact: true, selected: true })
      .waitFor();
    await page.locator("pre", { hasText: "Report version 1" }).waitFor();
  });
});

test("mobile details use a sheet; stale selections cannot overwrite the current artifact", async () => {
  await withStudio(async (page, base) => {
    await page.goto(base + "/artifacts?selected=a-slow&version=1");
    await page.getByRole("dialog", { name: "Artifact details" }).waitFor();
    await page.evaluate((url) => {
      history.pushState(null, "", url);
      dispatchEvent(new PopStateEvent("popstate"));
    }, base + "/artifacts?selected=a-report&version=2");
    await page.getByText("Report version 2", { exact: true }).waitFor();
    assert.equal(
      await page.getByText("Stale report", { exact: true }).count(),
      0,
    );
    await page.getByRole("button", { name: "Close resource details" }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  }, true);
});

test("an embedded artifact inspector navigates and downloads without a Studio bearer in the URL", async () => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const address = reserve.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  reserve.close();
  await once(reserve, "close");
  const origin = `http://127.0.0.1:${port}`;
  const runtime = await resourceRuntime();
  const studio = await startStudioServer({
    runtimeUrl: runtime.url,
    adminKey: "e".repeat(64),
    port: 0,
    webRoot: fileURLToPath(new URL("../dist/web", import.meta.url)),
    frameAncestors: [origin],
    log: () => {},
  });
  const app = createServer(async (_req, res) => {
    const minted = await fetch(studio.url + "/_studio/login-tokens", {
      method: "POST",
      headers: {
        authorization: `Bearer ${"e".repeat(64)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tenant: TENANT, subject: "resource-reader" }),
    });
    const { token } = (await minted.json()) as { token: string };
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Resource embed fixture</title><iframe style="width:1200px;height:900px" src="${studio.url}/tenants/${TENANT}/artifacts?sessionId=${SESSION}&selected=a-report&version=1&embed=1"></iframe><script>
      const frame=document.querySelector('iframe');
      window.addEventListener('message', e=>{ if(e.source===frame.contentWindow && e.origin===${JSON.stringify(studio.url)} && e.data.kind==='ready') frame.contentWindow.postMessage({type:'nylorun.studio',protocol:1,kind:'init',token:${JSON.stringify(token)}},${JSON.stringify(studio.url)}); });
    </script>`);
  });
  app.listen(port, "127.0.0.1");
  await once(app, "listening");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    page.setDefaultTimeout(10000);
    await page.goto(origin);
    const frame = page.frameLocator("iframe");
    await frame.locator("pre", { hasText: "Report version 1" }).waitFor();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      frame.getByRole("button", { name: "Download", exact: true }).click(),
    ]);
    assert.equal(await download.failure(), null);
    assert.match(
      download.url(),
      /\/_studio\/tenants\/[^/]+\/runtime\/v1\/artifact-links\/v1$/,
    );
    await frame.getByRole("tab", { name: "Versions", exact: true }).click();
    await frame.getByRole("button", { name: "Version 2", exact: true }).click();
    await frame.getByText("Report version 2", { exact: true }).waitFor();
    assert.ok(
      runtime.requests.some((r) => r.path.endsWith("/artifact-links/v1")),
    );
  } finally {
    await browser.close();
    app.closeAllConnections();
    app.close();
    await studio.close();
    runtime.close();
  }
});
