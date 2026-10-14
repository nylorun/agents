import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { startStudioServer } from "../dist/server.js";
import {
  resourceRuntime,
  TENANT,
  SESSION,
  ENVIRONMENT,
  POD,
  INPUT_ARTIFACT,
} from "./support/resource-runtime.ts";

async function withStudio(
  run: (
    page: Page,
    base: string,
    requests: Awaited<ReturnType<typeof resourceRuntime>>["requests"],
  ) => Promise<void>,
  mobile = false,
  mutates = false,
  options: Parameters<typeof resourceRuntime>[0] = {},
) {
  const runtime = await resourceRuntime(options);
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
    if (!mutates)
      assert.deepEqual(
        runtime.requests.filter(
          (r) =>
            r.method !== "GET" &&
            !r.path.endsWith("/links") &&
            r.path !== "/v1/tenant/credential-coverage",
        ),
        [],
        "resource browsing never mutates a session, Environment or artifact",
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

test("Environments work before agent registration: server paging, label navigation, an Environment's page, its secrets, events and sessions", async () => {
  await withStudio(async (page, base, requests) => {
    await page.goto(base);
    // No agent is registered; the session list still lists the Tenant's sessions.
    await page
      .getByRole("heading", { name: "Sessions", exact: true })
      .waitFor();
    // Environments hold sandboxes, secrets and disk versions: no Credentials entry.
    assert.equal(await page.getByRole("link", { name: "Credentials", exact: true }).count(), 0);
    await page.getByRole("link", { name: "Environments", exact: true }).click();
    await page.getByRole("link", { name: ENVIRONMENT, exact: true }).waitFor();
    await page.getByRole("button", { name: "Load more Environments" }).click();
    await page.getByRole("link", { name: "z-last", exact: true }).waitFor();
    assert.ok(
      requests.some((r) => r.path === "/v1/environments?limit=50&cursor=page2"),
    );
    await page
      .getByRole("textbox", { name: "Environment labels" })
      .fill("project=build");
    await page.getByRole("button", { name: "Apply labels" }).click();
    await page.waitForURL(/label=project%3Dbuild/);
    await page.getByRole("link", { name: ENVIRONMENT, exact: true }).click();
    await page.waitForURL(/\/environments\/team%2Fbuild$/);
    await page.getByRole("heading", { name: ENVIRONMENT, exact: true }).waitFor();
    await page.getByText("A virtual workspace has no pod", { exact: false }).waitFor();
    // A virtual Environment has no pod to stop or reset.
    assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Reset", exact: true }).count(), 0);
    await page.getByRole("tab", { name: "Secrets", exact: true }).click();
    await page.waitForURL(/tab=secrets/);
    await page.getByText("github", { exact: true }).waitFor();
    await page.getByText("https://api.githubcopilot.com/mcp/", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "Events", exact: true }).click();
    await page.getByText("0 · environment.created", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Refresh events" }).click();
    await page.getByText("1 · environment.attached", { exact: false }).waitFor();
    assert.deepEqual(
      requests
        .filter((r) => r.path.includes("/environments/team%2Fbuild/events"))
        .map((r) => r.path),
      [
        "/v1/environments/team%2Fbuild/events?from=0",
        "/v1/environments/team%2Fbuild/events?from=1",
      ],
    );
    await page.getByRole("tab", { name: "Sessions", exact: true }).click();
    await page.getByRole("link", { name: SESSION, exact: true }).click();
    await page.waitForURL(
      new RegExp(`/agents/external-agent/sessions/${SESSION}$`),
    );
    await page.getByRole("tab", { name: "Outputs", exact: true }).click();
    await page
      .getByRole("button", { name: "report.html", exact: true })
      .click();
    await page.getByText("Report version 2", { exact: true }).waitFor();
    assert.ok(requests.some((r) => r.path.includes("environmentId=team%2Fbuild")));
    await page
      .getByRole("link", { name: `Environment: ${ENVIRONMENT}`, exact: true })
      .click();
    await page.waitForURL(/\/environments\/team%2Fbuild$/);
    await page.getByRole("tab", { name: "Overview", exact: true, selected: true }).waitFor();
  });
});

test("a session's Environment tab shows where it runs: the version it opened on, coverage, disk and who shares it", async () => {
  await withStudio(async (page, base, requests) => {
    await page.goto(base + `/sessions/${SESSION}?inspector=environment`);
    await page.getByRole("tab", { name: "Environment", exact: true, selected: true }).waitFor();
    const panel = page.getByRole("tabpanel", { name: "Environment" });
    // Opened on version 2, and still on it.
    await panel.getByText("Version 2", { exact: true }).first().waitFor();
    assert.equal(await panel.getByText("Version 2", { exact: true }).count(), 2);
    // The coverage this agent's tools get from the Environment's secrets.
    await panel.getByText("MCP server github", { exact: true }).waitFor();
    await panel.getByText("Covered", { exact: true }).waitFor();
    await panel.getByText("Sends github", { exact: true }).waitFor();
    const coverage = requests.find((r) => r.path === "/v1/tenant/credential-coverage");
    const { requestId: _id, ...checked } = coverage?.body as Record<string, unknown>;
    assert.deepEqual(checked, { agentId: "external-agent", environmentId: ENVIRONMENT });
    // Its disk, and the other session that names it.
    await panel.getByText("v2", { exact: true }).waitFor();
    await panel.getByRole("link", { name: "s-other", exact: true }).waitFor();
    await panel.getByText("running a turn", { exact: false }).waitFor();
    // It only reads: what changes an Environment is on its page.
    for (const name of ["Reset", "Restore", "Snapshot disk", "Add credential"])
      assert.equal(await panel.getByRole("button", { name, exact: true }).count(), 0, name);
    await panel.getByRole("link", { name: "Disk versions", exact: true }).click();
    await page.waitForURL(/\/environments\/team%2Fbuild\?tab=disk$/);
    await page.getByRole("tab", { name: "Disk", exact: true, selected: true }).waitFor();
  });
});

test("an Environment is created from the form, its labels and owner edited, and it is deleted", async () => {
  await withStudio(
    async (page, base, requests) => {
      await page.goto(base + "/environments");
      await page.getByRole("button", { name: "New Environment" }).click();
      const sheet = page.getByRole("dialog", { name: "New Environment" });
      await sheet.getByRole("textbox", { name: "ID", exact: true }).fill("users/alice/web");
      await sheet.getByRole("combobox", { name: "Kind" }).selectOption("virtual");
      await sheet.getByRole("textbox", { name: "Memory" }).fill("2GiB");
      await sheet.getByRole("textbox", { name: "Allowed hosts" }).fill("pypi.org, api.github.com");
      await sheet.getByRole("textbox", { name: "Labels" }).fill("project=web");
      await sheet.getByRole("textbox", { name: "Owner (optional)" }).fill("local-developer");
      await sheet.getByRole("textbox", { name: "Delete after" }).fill("30d");
      // Only a pod takes setup commands and input files.
      assert.equal(await sheet.getByRole("button", { name: "Add setup command" }).count(), 0);
      await sheet.getByRole("button", { name: "Create Environment" }).click();
      await page.waitForURL(/\/environments\/users%2Falice%2Fweb$/);
      const created = requests.find(
        (r) => r.method === "PUT" && r.path === "/v1/environments/users%2Falice%2Fweb",
      );
      assert.ok(created);
      const { requestId: _id, ...recipe } = created.body as Record<string, unknown>;
      assert.deepEqual(recipe, {
        kind: "virtual",
        labels: { project: "web" },
        resources: { memory: "2GiB" },
        network: { allowedHosts: ["pypi.org", "api.github.com"] },
        ownerUserId: "local-developer",
        lifecycle: { deleteAfter: "30d" },
      });

      await page.goto(base + `/environments/${encodeURIComponent(ENVIRONMENT)}`);
      await page.getByRole("button", { name: "Edit labels and owner" }).click();
      const edit = page.getByRole("dialog", { name: `Edit ${ENVIRONMENT}` });
      // What it runs is read-only: only labels and the owner guard change.
      assert.equal(await edit.getByRole("textbox", { name: "Idle" }).isDisabled(), true);
      await edit.getByRole("textbox", { name: "Labels" }).fill("project=build\nteam=a");
      await edit.getByRole("button", { name: "Save labels and owner" }).click();
      await edit.waitFor({ state: "hidden" });
      const edited = requests.find(
        (r) => r.method === "PUT" && r.path === "/v1/environments/team%2Fbuild",
      );
      assert.ok(edited);
      const { requestId: _edit, ...change } = edited.body as Record<string, unknown>;
      // An Environment never changes what it runs: an edit sends labels and the owner guard.
      assert.deepEqual(change, { labels: { project: "build", team: "a" }, ownerUserId: null });

      let confirmation = "";
      page.once("dialog", (dialog) => {
        confirmation = dialog.message();
        void dialog.accept();
      });
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.waitForURL((url) => url.pathname.endsWith("/environments"));
      // The confirmation says another session still names it.
      assert.match(confirmation, /2 sessions name it/);
      assert.ok(
        requests.some((r) => r.method === "DELETE" && r.path === "/v1/environments/team%2Fbuild"),
      );
    },
    false,
    true,
  );
});

test("old Environment, Credentials and vault links open the Environment's page", async () => {
  await withStudio(async (page, base) => {
    await page.goto(base + `/environments?selected=${encodeURIComponent(ENVIRONMENT)}&tab=events`);
    await page.waitForURL(/\/environments\/team%2Fbuild\?tab=events$/);
    await page.getByRole("tab", { name: "Events", exact: true, selected: true }).waitFor();
    await page.goto(base + `/vault?environment=${encodeURIComponent(ENVIRONMENT)}`);
    await page.waitForURL(/\/environments\/team%2Fbuild\?tab=secrets$/);
    await page.goto(base + "/settings/credentials");
    await page.waitForURL((url) => url.pathname.endsWith("/environments"));
    // The server answers 400 for an undecodable path: only in-app navigation reaches one.
    await page.evaluate((url) => {
      history.pushState(null, "", url);
      dispatchEvent(new PopStateEvent("popstate"));
    }, new URL(base).pathname + "/environments/%E0");
    await page.getByRole("heading", { name: "Environment not found" }).waitFor();
  });
});

test("an Environment's Secrets tab lists and writes the secrets of its vault, also through an old Credentials link", async () => {
  await withStudio(
    async (page, base, requests) => {
      await page.goto(base + `/settings/credentials?environment=${encodeURIComponent(ENVIRONMENT)}`);
      await page.waitForURL(/\/environments\/team%2Fbuild\?tab=secrets$/);
      await page.getByRole("tab", { name: "Secrets", exact: true, selected: true }).waitFor();
      await page.getByText("github", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Add credential" }).click();
      const sheet = page.getByRole("dialog", { name: "Add credential" });
      await sheet.getByRole("combobox", { name: "Type" }).selectOption("environment_secret");
      await sheet.getByRole("textbox", { name: "Variable name" }).fill("GH_TOKEN");
      await sheet.getByRole("textbox", { name: "Allowed hosts" }).fill("api.github.com");
      await sheet.getByLabel("Secret value").fill("ghp_secret_value");
      await sheet.getByRole("button", { name: "Save credential" }).click();
      await sheet.waitFor({ state: "hidden" }).catch(() => undefined);
      const written = requests.find(
        (r) => r.method === "PUT" && r.path === "/v1/environments/team%2Fbuild/secrets/GH_TOKEN",
      );
      assert.ok(written, JSON.stringify(requests.map((r) => `${r.method} ${r.path}`)));
      const { requestId: _id, ...body } = written.body as Record<string, unknown>;
      assert.deepEqual(body, {
        type: "environment_secret",
        value: "ghp_secret_value",
        allowedHosts: ["api.github.com"],
      });
      assert.equal(requests.some((r) => r.path.startsWith("/v1/tenant/vaults")), false);
    },
    false,
    true,
  );
});

test("an Environment's Disk tab keeps, browses, restores, forks and deletes disk versions", async () => {
  await withStudio(
    async (page, base, requests) => {
      await page.goto(base + `/environments/${encodeURIComponent(ENVIRONMENT)}?tab=disk`);
      await page.getByRole("cell", { name: "v2 latest" }).waitFor();
      await page.getByRole("cell", { name: "v1", exact: true }).waitFor();
      await page.getByRole("button", { name: "Snapshot disk" }).click();
      await page.getByText("Kept version 3: 12 entries", { exact: false }).waitFor();
      assert.ok(
        requests.some((r) => r.method === "POST" && r.path === "/v1/environments/team%2Fbuild/snapshot"),
      );

      // A version's files, through the folder artifact the Environment owns.
      await page.getByRole("button", { name: "Browse version 1" }).click();
      await page.waitForURL(/diskArtifact=a-disk&diskVersion=1/);
      await page.getByRole("button", { name: /nested\/a \+b.html/ }).click();
      await page.getByText("Report version 1", { exact: false }).waitFor();
      assert.ok(requests.some((r) => r.path.startsWith("/v1/artifacts/a-disk/versions/1/")));

      let confirmation = "";
      page.once("dialog", (dialog) => {
        confirmation = dialog.message();
        void dialog.accept();
      });
      await page.getByRole("button", { name: "Restore version 1" }).click();
      await page.getByText("Restored version 1.", { exact: true }).waitFor();
      // Restoring changes the disk of every session that names it.
      assert.match(confirmation, /2 sessions name it/);
      const restore = requests.find((r) => r.path === "/v1/environments/team%2Fbuild/restore");
      assert.equal((restore?.body as { version: number }).version, 1);

      await page.getByRole("button", { name: "New Environment from version 2" }).click();
      const fork = page.getByRole("dialog", { name: `New Environment from ${ENVIRONMENT} v2` });
      await fork.getByRole("textbox", { name: "ID", exact: true }).fill("team/build-fork");
      await fork.getByRole("button", { name: "Create from version" }).click();
      await page.waitForURL(/\/environments\/team%2Fbuild-fork$/);
      const created = requests.find(
        (r) => r.method === "PUT" && r.path === "/v1/environments/team%2Fbuild-fork",
      );
      const { requestId: _id, ...forked } = created!.body as Record<string, unknown>;
      assert.deepEqual(forked, {
        kind: "virtual",
        labels: { project: "build" },
        resources: { cpus: 1, memory: "1024MiB" },
        network: { allowedHosts: ["pypi.org"] },
        lifecycle: { idle: "15m" },
        from: { environment: ENVIRONMENT, version: 2 },
      });

      await page.goto(base + `/environments/${encodeURIComponent(ENVIRONMENT)}?tab=disk`);
      page.once("dialog", (dialog) => void dialog.accept());
      await page.getByRole("button", { name: "Delete version 1" }).click();
      await page.getByText("Deleted version 1.", { exact: true }).waitFor();
      assert.ok(
        requests.some((r) => r.method === "DELETE" && r.path === "/v1/environments/team%2Fbuild/versions/1"),
      );
    },
    false,
    true,
  );
});

test("a pod's Setup & files tab shows its setup commands and input files, which never change", async () => {
  await withStudio(
    async (page, base) => {
      await page.goto(base + `/environments/${encodeURIComponent(POD)}?tab=setup`);
      await page.getByText("pip install -r requirements.txt", { exact: true }).waitFor();
      await page.getByText("1. in /workspace/app · timeout 10m", { exact: true }).waitFor();
      await page.getByRole("link", { name: `${INPUT_ARTIFACT} · v1` }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Edit setup & files" }).count(), 0);
      // A virtual Environment has neither.
      await page.goto(base + `/environments/${encodeURIComponent(ENVIRONMENT)}?tab=setup`);
      await page.getByText("A virtual Environment has none.", { exact: false }).waitFor();
    },
    false,
    true,
  );
});

test("the Tenant's artifacts are one paged table, filtered by kind, session and labels, each with its owner", async () => {
  await withStudio(async (page, base, requests) => {
    await page.goto(base);
    // The sidebar holds Sessions and Environments only; the table opens by its address.
    await page.getByRole("link", { name: "Environments", exact: true }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Artifacts", exact: true }).count(), 0);
    await page.goto(base + "/artifacts");
    await page.getByRole("button", { name: "requirements.txt", exact: true }).waitFor();
    await page.getByRole("button", { name: "disk", exact: true }).waitFor();
    await page.getByRole("button", { name: "Load more artifacts" }).click();
    await page.getByRole("button", { name: "report.html", exact: true }).waitFor();
    assert.deepEqual(
      requests.filter((r) => r.path.startsWith("/v1/artifacts?")).map((r) => r.path),
      ["/v1/artifacts?limit=50", "/v1/artifacts?limit=50&cursor=artifacts2"],
    );
    // Owners: the Tenant's own file, an Environment's disk, a session's outputs.
    const row = (name: string) => page.getByRole("row").filter({ hasText: name });
    await row("requirements.txt").getByText("Tenant", { exact: true }).waitFor();
    await row("disk").getByRole("link", { name: `${ENVIRONMENT} · disk` }).waitFor();
    await row("report.html").getByRole("link", { name: SESSION, exact: true }).waitFor();

    await page.getByRole("combobox", { name: "Kind" }).selectOption("folder");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.waitForURL(/kind=folder/);
    await page.getByRole("button", { name: "requirements.txt", exact: true }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "outputs", exact: true }).waitFor();
    assert.ok(requests.some((r) => r.path === "/v1/artifacts?limit=50&kind=folder"));

    await page.getByRole("combobox", { name: "Kind" }).selectOption("");
    await page.getByRole("textbox", { name: "Artifact labels" }).fill("purpose=input");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.waitForURL(/label=purpose%3Dinput/);
    await page.getByRole("button", { name: "outputs", exact: true }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "requirements.txt", exact: true }).click();
    await page.getByRole("heading", { name: "requirements.txt", exact: true }).waitFor();
    assert.ok(requests.some((r) => r.path === "/v1/artifacts?limit=50&label=purpose%3Dinput"));

    // An Environment's disk opens on its Disk tab.
    await page.getByRole("textbox", { name: "Artifact labels" }).fill("");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await row("disk").getByRole("link", { name: `${ENVIRONMENT} · disk` }).click();
    await page.waitForURL(/\/environments\/team%2Fbuild\?tab=disk$/);
  });
});

test("artifacts pin versions, escape HTML, browse folder files and diff, and stream native downloads; a Host without pages looks up a session's", async () => {
  await withStudio(async (page, base, requests) => {
    await page.goto(base + "/artifacts");
    await page
      .getByRole("heading", { name: "Open an artifact" })
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
  }, false, false, { artifactReads: false });
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
      .getByRole("tab", { name: "Outputs", exact: true, selected: true })
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
