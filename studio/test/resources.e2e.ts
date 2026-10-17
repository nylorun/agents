import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { startStudioServer } from "../dist/server.js";
import {
  resourceRuntime,
  TENANT,
  SESSION,
  AGENT,
  ASKING,
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
        "resource browsing never mutates a session, Agent or artifact",
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

const encoded = encodeURIComponent(AGENT);

test("Agents: the sidebar lists each Agent as a filter on the sessions, the list sorts and filters, and an Agent's page shows its secrets, events and sessions", async () => {
  await withStudio(async (page, base, requests) => {
    await page.goto(base);
    await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
    // Agents hold compute, secrets and disk versions: no Credentials or Environments entry.
    assert.equal(await page.getByRole("link", { name: "Credentials", exact: true }).count(), 0);
    assert.equal(await page.getByRole("link", { name: "Environments", exact: true }).count(), 0);
    const sidebar = page.locator("[data-sidebar=sidebar]");
    // One row per Agent, no manifest rows: each filters the session table to its sessions.
    assert.equal(await sidebar.getByRole("link", { name: "analyst-box 2" }).count(), 0);
    await sidebar.locator(`a[href$="/sessions?agent=${encoded}"]`).click();
    await page.waitForURL(/\/sessions\?agent=team%2Fbuild$/u);
    await page.getByRole("button", { name: "Filter by Agent" }).getByText(AGENT, { exact: true }).waitFor();
    // Agents opens every session; Manage Agents opens the list.
    await sidebar.getByRole("link", { name: /^Agents/u }).click();
    await page.waitForURL((url) => url.pathname.endsWith("/sessions") && url.search === "");
    await page.getByRole("link", { name: "Manage Agents" }).click();
    await page.waitForURL((url) => url.pathname.endsWith("/agents") && url.search === "");
    await page.getByRole("link", { name: AGENT, exact: true }).waitFor();
    // The whole list, as the session list: no pages to load.
    assert.ok(requests.some((r) => r.path === "/v1/agents"));
    assert.equal(requests.filter((r) => r.path.startsWith("/v1/agents?")).length, 0);
    // Input required sorts first; each row names the version it runs and whether it tracks.
    const first = page.locator("tbody tr").first();
    await first.getByRole("link", { name: ASKING, exact: true }).waitFor();
    await first.getByText("Input required", { exact: true }).waitFor();
    await first.getByText("analyst-box@3", { exact: true }).waitFor();
    await first.getByText("pinned", { exact: true }).waitFor();
    await page.locator("tbody tr", { hasText: AGENT }).getByText("tracks", { exact: true }).waitFor();
    // Filters: a state, a manifest, an owner, a label.
    await page.getByRole("button", { name: "Filter by state" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Input required 1" }).click();
    await page.waitForURL(/\/agents\?state=input_required$/u);
    await page.getByRole("link", { name: AGENT, exact: true }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Filter by state" }).click();
    await page.getByRole("menuitemcheckbox", { name: "All states" }).click();
    await page.getByRole("button", { name: "Filter by owner" }).click();
    await page.getByRole("menuitemcheckbox", { name: "No owner guard 2" }).click();
    await page.waitForURL(/owner=-/u);
    await page.getByRole("link", { name: ASKING, exact: true }).waitFor({ state: "detached" });
    await page.goto(base + "/agents?manifest=pod-box");
    await page.getByText("1 total", { exact: true }).waitFor();
    await page.goto(base + "/agents");
    await page
      .locator("tbody tr", { hasText: AGENT })
      .getByRole("button", { name: "project=build" })
      .click();
    await page.waitForURL(/label=project%3Dbuild/u);
    await page.getByRole("link", { name: ASKING, exact: true }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Remove label filter project=build" }).click();
    await page.getByRole("link", { name: ASKING, exact: true }).waitFor();
    // An Agent's page.
    await page.getByRole("link", { name: AGENT, exact: true }).click();
    await page.waitForURL(/\/agents\/team%2Fbuild$/u);
    await page.getByRole("heading", { name: AGENT, exact: true }).waitFor();
    await page.getByText("A virtual workspace has no pod", { exact: false }).waitFor();
    // Its manifest has a newer version: the pinned Agent moves to it in place (track T3).
    await page.getByRole("button", { name: "Move to v3" }).waitFor();
    await page.getByRole("button", { name: "Track the manifest" }).waitFor();
    // A virtual Agent has no pod to stop or reset.
    assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Reset", exact: true }).count(), 0);
    await page.getByRole("tab", { name: "Secrets", exact: true }).click();
    await page.waitForURL(/tab=secrets/u);
    await page.getByText("https://api.githubcopilot.com/mcp/", { exact: true }).first().waitFor();
    // The slots its manifest declares, and what its tools get from them.
    await page.getByText("What its tools get · 1 of 1 covered", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "Events", exact: true }).click();
    await page.getByText("0 · agent.created", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Refresh events" }).click();
    await page.getByText("1 · agent.attached", { exact: false }).waitFor();
    assert.deepEqual(
      requests.filter((r) => r.path.includes("/agents/team%2Fbuild/events")).map((r) => r.path),
      ["/v1/agents/team%2Fbuild/events?from=0", "/v1/agents/team%2Fbuild/events?from=1"],
    );
    // Its sessions, none special.
    await page.getByRole("tab", { name: "Sessions", exact: true }).click();
    await page.getByRole("link", { name: "s-other", exact: true }).waitFor();
    await page.getByText("Active turn: t9", { exact: true }).waitFor();
    await page.getByRole("link", { name: SESSION, exact: true }).click();
    await page.waitForURL(new RegExp(`/agents/team%2Fbuild/sessions/${SESSION}$`, "u"));
    await page.getByRole("tab", { name: "Outputs", exact: true }).click();
    await page.getByRole("button", { name: "report.html", exact: true }).click();
    await page.getByText("Report version 2", { exact: true }).waitFor();
    await page.getByRole("link", { name: `Agent: ${AGENT}`, exact: true }).click();
    await page.waitForURL(/\/agents\/team%2Fbuild$/u);
    await page.getByRole("tab", { name: "Overview", exact: true, selected: true }).waitFor();
  });
});

test("a session's Agent tab shows where it runs: the version it opened on, coverage, disk and the other sessions", async () => {
  await withStudio(async (page, base, requests) => {
    await page.goto(base + `/sessions/${SESSION}?inspector=agent`);
    await page.getByRole("tab", { name: "Agent", exact: true, selected: true }).waitFor();
    const panel = page.getByRole("tabpanel", { name: "Agent" });
    await panel.getByText("analyst-box v2", { exact: true }).waitFor();
    await panel.getByText("analyst-box@2", { exact: true }).waitFor();
    // The coverage its tools get from the Agent's vault.
    await panel.getByText("MCP server github", { exact: true }).waitFor();
    await panel.getByText("Covered", { exact: true }).waitFor();
    await panel.getByText("Sends github", { exact: true }).waitFor();
    const coverage = requests.find((r) => r.path === "/v1/tenant/credential-coverage");
    const { requestId: _id, ...checked } = coverage?.body as Record<string, unknown>;
    assert.deepEqual(checked, { agentId: AGENT });
    // Its disk, and the other session on it.
    await panel.getByText("v2", { exact: true }).waitFor();
    await panel.getByRole("link", { name: "s-other", exact: true }).waitFor();
    await panel.getByText("running a turn", { exact: false }).waitFor();
    // It only reads: what changes an Agent is on its page.
    for (const name of ["Reset", "Restore", "Snapshot disk", "Add credential"])
      assert.equal(await panel.getByRole("button", { name, exact: true }).count(), 0, name);
    // The tab the session's Environment had before protocol 16 opens it too.
    await page.goto(base + `/sessions/${SESSION}?inspector=environment`);
    await page.getByRole("tab", { name: "Agent", exact: true, selected: true }).waitFor();
    await page.getByRole("tabpanel", { name: "Agent" }).getByRole("link", { name: "Disk versions", exact: true }).click();
    await page.waitForURL(/\/agents\/team%2Fbuild\?tab=disk$/u);
    await page.getByRole("tab", { name: "Disk", exact: true, selected: true }).waitFor();
  });
});

test("agent manifests are read only: names, versions, each version's two sections side by side, and the Agents made from it", async () => {
  await withStudio(async (page, base, requests) => {
    await page.goto(base);
    await page.locator("[data-sidebar=sidebar]").getByRole("link", { name: /^Manifests/u }).click();
    await page.waitForURL(/\/agent-manifests$/u);
    const row = page.locator("tbody tr", { hasText: "analyst-box" });
    await row.getByText("v3", { exact: true }).waitFor();
    await row.getByText("Answers questions about data.", { exact: true }).waitFor();
    await row.getByRole("link", { name: "analyst-box", exact: true }).click();
    await page.waitForURL(/\/agent-manifests\/analyst-box$/u);
    await page.getByRole("heading", { name: "analyst-box", exact: true }).waitFor();
    await page.getByText("v3 (latest)", { exact: false }).waitFor();
    await page.getByRole("heading", { name: "Harness", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Runtime", exact: true }).waitFor();
    await page.getByText("github", { exact: true }).first().waitFor();
    // The Agents made from it, on whichever version.
    await page.getByRole("link", { name: AGENT, exact: true }).waitFor();
    await page.getByRole("link", { name: ASKING, exact: true }).waitFor();
    // Another version.
    await page.getByRole("link", { name: /^v2/u }).click();
    await page.waitForURL(/\/agent-manifests\/analyst-box\?version=2$/u);
    await page.getByRole("button", { name: "New Agent from v2" }).waitFor();
    assert.ok(requests.some((r) => r.path === "/v1/agent-manifests/analyst-box/versions/2"));
    // Nothing edits a manifest here.
    for (const name of ["New version", "Save version", "Check"])
      assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0, name);
    await page.goto(base + "/agent-manifests/missing");
    await page.getByText(/Agent manifest not found/u).first().waitFor();
  });
});

test("an Agent is made from a manifest version, its labels and owner edited, forked to a newer version, and deleted", async () => {
  await withStudio(
    async (page, base, requests) => {
      // From a manifest's page: pinned to the version shown.
      await page.goto(base + "/agent-manifests/analyst-box?version=2");
      await page.getByRole("button", { name: "New Agent from v2" }).click();
      const pinned = page.getByRole("dialog", { name: "New Agent" });
      await pinned.getByRole("combobox", { name: "Version" }).locator("option", { hasText: "Pin v2" }).waitFor({ state: "attached" });
      assert.equal(await pinned.getByRole("combobox", { name: "Version" }).inputValue(), "2");
      await pinned.getByRole("textbox", { name: "ID", exact: true }).fill("data/one");
      await pinned.getByRole("button", { name: "Create Agent" }).click();
      await page.waitForURL(/\/agents\/data%2Fone$/u);
      const made = requests.find((r) => r.method === "PUT" && r.path === "/v1/agents/data%2Fone");
      const { requestId: _made, ...body } = made?.body as Record<string, unknown>;
      assert.deepEqual(body, { manifest: "analyst-box@2", owner: "local-developer" });

      // From the list: tracking the manifest, with labels and no owner guard.
      await page.goto(base + "/agents");
      await page.getByRole("button", { name: "New Agent" }).click();
      const sheet = page.getByRole("dialog", { name: "New Agent" });
      await sheet.getByRole("combobox", { name: "Agent manifest" }).selectOption("analyst-box");
      await sheet.getByRole("textbox", { name: "ID", exact: true }).fill("users/alice/web");
      await sheet.getByRole("textbox", { name: "Owner (optional)" }).fill("");
      await sheet.getByRole("textbox", { name: "Labels" }).fill("project=web");
      await sheet.getByRole("button", { name: "Create Agent" }).click();
      await page.waitForURL(/\/agents\/users%2Falice%2Fweb$/u);
      const created = requests.find((r) => r.method === "PUT" && r.path === "/v1/agents/users%2Falice%2Fweb");
      const { requestId: _id, ...tracking } = created?.body as Record<string, unknown>;
      assert.deepEqual(tracking, { manifest: "analyst-box", labels: { project: "web" } });

      await page.goto(base + `/agents/${encoded}`);
      await page.getByRole("button", { name: "Edit labels and owner" }).click();
      const edit = page.getByRole("dialog", { name: `Edit ${AGENT}` });
      await edit.getByRole("textbox", { name: "Labels" }).fill("project=build\nteam=a");
      await edit.getByRole("button", { name: "Save labels and owner" }).click();
      await edit.waitFor({ state: "hidden" });
      const edited = requests.find((r) => r.method === "PUT" && r.path === "/v1/agents/team%2Fbuild");
      const { requestId: _edit, ...change } = edited?.body as Record<string, unknown>;
      // An edit names the version it runs: it moves nothing.
      assert.deepEqual(change, { manifest: "analyst-box@2", labels: { project: "build", team: "a" }, owner: null });

      // Fork onto the newer version: check the plan, then fork.
      await page.getByRole("button", { name: "Fork", exact: true }).click();
      const fork = page.getByRole("dialog", { name: `Fork ${AGENT}` });
      assert.equal(await fork.getByRole("textbox", { name: "Agent manifest" }).inputValue(), "analyst-box@3");
      await fork.getByRole("button", { name: "Check" }).click();
      await fork.getByText("Made from analyst-box v3, kind virtual.", { exact: true }).waitFor();
      await fork.getByText("Secrets copied: github.", { exact: true }).waitFor();
      await fork.getByRole("button", { name: "Fork", exact: true }).click();
      await page.waitForURL(/\/agents\/team%2Fbuild-v3$/u);
      const forked = requests.filter((r) => r.method === "POST" && r.path === "/v1/agents/team%2Fbuild/fork");
      assert.equal(forked.length, 2);
      assert.equal((forked[0]!.body as { dryRun?: boolean }).dryRun, true);
      const { requestId: _fork, ...forkBody } = forked[1]!.body as Record<string, unknown>;
      assert.deepEqual(forkBody, { id: "team/build-v3", manifest: "analyst-box@3", disk: "latest", secrets: "copy" });

      await page.goto(base + `/agents/${encoded}`);
      let confirmation = "";
      page.once("dialog", (dialog) => {
        confirmation = dialog.message();
        void dialog.accept();
      });
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.waitForURL((url) => url.pathname.endsWith("/agents"));
      // The confirmation says sessions still run on it.
      assert.match(confirmation, /2 sessions run on it/u);
      assert.ok(requests.some((r) => r.method === "DELETE" && r.path === "/v1/agents/team%2Fbuild"));
    },
    false,
    true,
  );
});

test("old Environment, Credentials and vault links open the Agent's page", async () => {
  await withStudio(async (page, base) => {
    await page.goto(base + `/environments/${encoded}?tab=events`);
    await page.waitForURL(/\/agents\/team%2Fbuild\?tab=events$/u);
    await page.getByRole("tab", { name: "Events", exact: true, selected: true }).waitFor();
    await page.goto(base + `/environments?selected=${encoded}&tab=disk`);
    await page.waitForURL(/\/agents\/team%2Fbuild\?tab=disk$/u);
    await page.goto(base + `/vault?environment=${encoded}`);
    await page.waitForURL(/\/agents\/team%2Fbuild\?tab=secrets$/u);
    await page.goto(base + "/environments?manifest=analyst-box");
    await page.waitForURL(/\/agents\?manifest=analyst-box$/u);
    await page.goto(base + "/settings/credentials");
    await page.waitForURL((url) => url.pathname.endsWith("/agents"));
    // The server answers 400 for an undecodable path: only in-app navigation reaches one.
    await page.evaluate((url) => {
      history.pushState(null, "", url);
      dispatchEvent(new PopStateEvent("popstate"));
    }, new URL(base).pathname + "/agents/%E0");
    await page.getByRole("heading", { name: "Agent not found" }).waitFor();
  });
});

test("an Agent's Secrets tab lists and writes the secrets of its vault, also through an old Credentials link", async () => {
  await withStudio(
    async (page, base, requests) => {
      await page.goto(base + `/settings/credentials?environment=${encoded}`);
      await page.waitForURL(/\/agents\/team%2Fbuild\?tab=secrets$/u);
      await page.getByRole("tab", { name: "Secrets", exact: true, selected: true }).waitFor();
      await page.getByRole("cell", { name: "github", exact: true }).waitFor();
      await page.getByRole("button", { name: "Add credential" }).click();
      const sheet = page.getByRole("dialog", { name: "Add credential" });
      await sheet.getByRole("combobox", { name: "Type" }).selectOption("environment_secret");
      await sheet.getByRole("textbox", { name: "Variable name" }).fill("GH_TOKEN");
      await sheet.getByRole("textbox", { name: "Allowed hosts" }).fill("api.github.com");
      await sheet.getByLabel("Secret value").fill("ghp_secret_value");
      await sheet.getByRole("button", { name: "Save credential" }).click();
      await sheet.waitFor({ state: "hidden" }).catch(() => undefined);
      const written = requests.find((r) => r.method === "PUT" && r.path === "/v1/agents/team%2Fbuild/secrets/GH_TOKEN");
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

test("an Agent's Disk tab keeps, browses, restores, forks from and deletes disk versions", async () => {
  await withStudio(
    async (page, base, requests) => {
      await page.goto(base + `/agents/${encoded}?tab=disk`);
      await page.getByRole("cell", { name: "v2 latest" }).waitFor();
      await page.getByRole("cell", { name: "v1", exact: true }).waitFor();
      await page.getByRole("button", { name: "Snapshot disk" }).click();
      await page.getByText("Kept version 3: 12 entries", { exact: false }).waitFor();
      assert.ok(requests.some((r) => r.method === "POST" && r.path === "/v1/agents/team%2Fbuild/snapshot"));

      // A version's files, through the folder artifact the Agent owns.
      await page.getByRole("button", { name: "Browse version 1" }).click();
      await page.waitForURL(/diskArtifact=a-disk&diskVersion=1/u);
      await page.getByRole("button", { name: /nested\/a \+b.html/u }).click();
      await page.getByText("Report version 1", { exact: false }).waitFor();
      assert.ok(requests.some((r) => r.path.startsWith("/v1/artifacts/a-disk/versions/1/")));

      let confirmation = "";
      page.once("dialog", (dialog) => {
        confirmation = dialog.message();
        void dialog.accept();
      });
      await page.getByRole("button", { name: "Restore version 1" }).click();
      await page.getByText("Restored version 1.", { exact: true }).waitFor();
      // Restoring changes the disk of every session on it.
      assert.match(confirmation, /2 sessions run on it/u);
      const restore = requests.find((r) => r.path === "/v1/agents/team%2Fbuild/restore");
      assert.equal((restore?.body as { version: number }).version, 1);

      // A fork whose disk starts from a version, with the secrets its manifest declares.
      await page.getByRole("button", { name: "Fork from version 2" }).click();
      const fork = page.getByRole("dialog", { name: `Fork ${AGENT}` });
      await fork.getByRole("textbox", { name: "New Agent id" }).fill("team/build-fork");
      await fork.getByRole("textbox", { name: "Agent manifest" }).fill("");
      await fork.getByRole("button", { name: "Fork", exact: true }).click();
      await page.waitForURL(/\/agents\/team%2Fbuild-fork$/u);
      const created = requests.find((r) => r.method === "POST" && r.path === "/v1/agents/team%2Fbuild/fork");
      const { requestId: _id, ...forked } = created!.body as Record<string, unknown>;
      assert.deepEqual(forked, { id: "team/build-fork", disk: 2, secrets: "copy" });

      await page.goto(base + `/agents/${encoded}?tab=disk`);
      page.once("dialog", (dialog) => void dialog.accept());
      await page.getByRole("button", { name: "Delete version 1" }).click();
      await page.getByText("Deleted version 1.", { exact: true }).waitFor();
      assert.ok(requests.some((r) => r.method === "DELETE" && r.path === "/v1/agents/team%2Fbuild/versions/1"));
    },
    false,
    true,
  );
});

test("a pod's Setup & files tab shows its setup commands and input files, which never change", async () => {
  await withStudio(
    async (page, base) => {
      await page.goto(base + `/agents/${encodeURIComponent(POD)}?tab=setup`);
      await page.getByText("pip install -r requirements.txt", { exact: true }).waitFor();
      await page.getByText("1. in /workspace/app · timeout 10m", { exact: true }).waitFor();
      await page.getByRole("link", { name: `${INPUT_ARTIFACT} · v1` }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Edit setup & files" }).count(), 0);
      // A virtual Agent has neither.
      await page.goto(base + `/agents/${encoded}?tab=setup`);
      await page.getByText("A virtual Agent has none.", { exact: false }).waitFor();
    },
    false,
    true,
  );
});

test("the Tenant's artifacts are one paged table, filtered by kind, session and labels, each with its owner", async () => {
  await withStudio(async (page, base, requests) => {
    await page.goto(base);
    // The sidebar holds Agents and, below them, manifests and models; the table opens by its address.
    await page.locator("[data-sidebar=sidebar]").getByRole("link", { name: /^Agents/u }).waitFor();
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
    // Owners: the Tenant's own file, an Agent's disk, a session's outputs.
    const row = (name: string) => page.getByRole("row").filter({ hasText: name });
    await row("requirements.txt").getByText("Tenant", { exact: true }).waitFor();
    await row("disk").getByRole("link", { name: `${AGENT} · disk` }).waitFor();
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

    // An Agent's disk opens on its Disk tab.
    await page.getByRole("textbox", { name: "Artifact labels" }).fill("");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await row("disk").getByRole("link", { name: `${AGENT} · disk` }).click();
    await page.waitForURL(/\/agents\/team%2Fbuild\?tab=disk$/);
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
