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

test("Agents: Studio opens on the Agents list, each sidebar Agent opens its page, the list sorts and filters, and an Agent's page shows its secrets, events and sessions", async () => {
  await withStudio(async (page, base, requests) => {
    await page.goto(base);
    // Studio opens on its Agents.
    await page.waitForURL((url) => url.pathname.endsWith("/agents") && url.search === "");
    await page.getByRole("link", { name: AGENT, exact: true }).waitFor();
    // Agents hold compute, secrets and disk versions: no Credentials, Environments or Sessions entry.
    for (const name of ["Credentials", "Environments", "Sessions"])
      assert.equal(await page.getByRole("link", { name, exact: true }).count(), 0, name);
    const sidebar = page.locator("[data-sidebar=sidebar]");
    assert.equal(await sidebar.getByRole("button", { name: "New session", exact: true }).count(), 0);
    // One row per Agent, no manifest rows: each opens its page, which opens on its sessions.
    assert.equal(await sidebar.getByRole("link", { name: "analyst-box 2" }).count(), 0);
    await sidebar.locator(`a[href$="/agents/${encoded}"]`).click();
    await page.waitForURL(/\/agents\/team%2Fbuild$/u);
    await page.getByRole("tab", { name: "Sessions", exact: true, selected: true }).waitFor();
    // The old session list opens the Agents, or one Agent's sessions.
    await page.goto(base + `/sessions?agent=${encoded}`);
    await page.waitForURL(/\/agents\/team%2Fbuild$/u);
    await page.goto(base + "/sessions");
    await page.waitForURL((url) => url.pathname.endsWith("/agents") && url.search === "");
    // Agents opens the list.
    await page.getByRole("link", { name: AGENT, exact: true }).click();
    await page.waitForURL(/\/agents\/team%2Fbuild$/u);
    await sidebar.getByRole("link", { name: /^Agents/u }).click();
    await page.waitForURL((url) => url.pathname.endsWith("/agents") && url.search === "");
    await page.getByRole("link", { name: AGENT, exact: true }).waitFor();
    // The whole list, as the session list: no pages to load.
    assert.ok(requests.some((r) => r.path === "/v1/agents"));
    assert.equal(requests.filter((r) => r.path.startsWith("/v1/agents?")).length, 0);
    // How many of an Agent's sessions wait on a person.
    await page.locator("tbody tr", { hasText: ASKING }).getByText("1 waiting", { exact: true }).waitFor();
    await page.getByRole("searchbox", { name: "Search Agents" }).fill("pod");
    await page.getByRole("link", { name: AGENT, exact: true }).waitFor({ state: "detached" });
    await page.getByText("1 of 3 Agents", { exact: true }).waitFor();
    await page.getByRole("searchbox", { name: "Search Agents" }).fill("");
    // Input required sorts first; each row names the version it runs and whether it tracks.
    const first = page.locator("tbody tr").first();
    await first.getByRole("link", { name: ASKING, exact: true }).waitFor();
    await first.getByText("Input required", { exact: true }).waitFor();
    await first.getByText("analyst-box@3", { exact: true }).waitFor();
    await first.getByText("pinned", { exact: true }).waitFor();
    await page.locator("tbody tr", { hasText: AGENT }).getByText("pinned", { exact: true }).waitFor();
    await page.locator("tbody tr", { hasText: POD }).getByText("tracks", { exact: true }).waitFor();
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
    await page.getByText("1 of 3 Agents", { exact: true }).waitFor();
    await page.goto(base + "/agents");
    await page
      .locator("tbody tr", { hasText: AGENT })
      .getByRole("button", { name: "project=build" })
      .click();
    await page.waitForURL(/label=project%3Dbuild/u);
    await page.getByRole("link", { name: ASKING, exact: true }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Remove label filter project=build" }).click();
    await page.getByRole("link", { name: ASKING, exact: true }).waitFor();
    // An Agent's page: what it is an instance of, and one tab for each thing it holds.
    await page.getByRole("link", { name: AGENT, exact: true }).click();
    await page.waitForURL(/\/agents\/team%2Fbuild$/u);
    await page.getByRole("heading", { name: AGENT, exact: true }).waitFor();
    await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Agents", exact: true }).waitFor();
    await page.getByRole("link", { name: "analyst-box v2", exact: true }).waitFor();
    await page.getByText("pinned", { exact: true }).first().waitFor();
    // It opens on its sessions; none is special.
    await page.getByRole("tab", { name: "Sessions", exact: true, selected: true }).waitFor();
    assert.deepEqual(
      await page.getByRole("tab").allTextContents(),
      ["Sessions", "Triggers", "Artifacts", "Memory", "Disk", "Activity", "Vault", "Manifest"],
    );
    await page.getByRole("link", { name: "s-other", exact: true }).waitFor();
    await page.locator("tbody tr", { hasText: "s-other" }).getByText("running", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Filter by status" }).click();
    await page.getByRole("menuitemradio", { name: "idle" }).click();
    await page.getByRole("link", { name: "s-other", exact: true }).waitFor({ state: "detached" });
    await page.getByText("1 of 2 sessions", { exact: true }).waitFor();
    // A virtual Agent has no pod to stop or reset; its moves are on the Manifest tab.
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Edit labels and owner…" }).waitFor();
    for (const name of ["Stop compute", "Reset disk…"])
      assert.equal(await page.getByRole("menuitem", { name, exact: true }).count(), 0, name);
    await page.keyboard.press("Escape");
    // The vault: the slots its manifest version declares, and whether each holds a value.
    await page.getByRole("tab", { name: "Vault", exact: true }).click();
    await page.waitForURL(/tab=vault/u);
    const slot = page.locator("tbody tr", { hasText: "github" });
    await slot.getByText("MCP server github", { exact: true }).waitFor();
    await slot.getByText("Set", { exact: false }).waitFor();
    await slot.click();
    const details = page.getByRole("dialog", { name: "github" });
    await details.getByText("From the manifest", { exact: true }).waitFor();
    await details.getByText("https://api.githubcopilot.com/mcp/", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    // The manifest version it runs, as a readable spec, and its moves.
    await page.getByRole("tab", { name: "Manifest", exact: true }).click();
    await page.getByRole("region", { name: "MCP servers" }).getByText("https://api.githubcopilot.com/mcp/", { exact: true }).waitFor();
    await page.getByRole("region", { name: "Triggers" }).getByText("Mondays at 08:00, Europe/Berlin → Session kpi", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Manifest actions" }).click();
    await page.getByRole("menuitem", { name: "Move to v3" }).waitFor();
    await page.getByRole("menuitem", { name: "Track the manifest" }).waitFor();
    await page.keyboard.press("Escape");
    // Its activity, read on from the last event it holds.
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await page.getByRole("cell", { name: "agent.created" }).waitFor();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("cell", { name: "agent.attached" }).waitFor();
    await page.getByRole("tab", { name: "Activity", exact: true, selected: true }).waitFor();
    const events = requests.filter((r) => r.path.includes("/agents/team%2Fbuild/events")).map((r) => r.path);
    assert.equal(events[0], "/v1/agents/team%2Fbuild/events?from=0");
    // Its artifacts: each session's, read one session at a time.
    await page.getByRole("tab", { name: "Artifacts", exact: true }).click();
    await page.getByRole("cell", { name: "report.html", exact: true }).waitFor();
    assert.ok(requests.some((r) => r.path === `/v1/artifacts?sessionId=${SESSION}`));
    // Its memory.
    await page.getByRole("tab", { name: "Memory", exact: true }).click();
    await page.getByRole("cell", { name: "conventions/release.md", exact: true }).click();
    await page.getByRole("dialog", { name: "conventions/release.md" }).getByText("Releases are named vN.", { exact: false }).waitFor();
    await page.keyboard.press("Escape");
    // A session's page links back to the Agent's, opened on its sessions.
    await page.getByRole("tab", { name: "Sessions", exact: true }).click();
    await page.getByRole("link", { name: SESSION, exact: true }).click();
    await page.waitForURL(new RegExp(`/agents/team%2Fbuild/sessions/${SESSION}$`, "u"));
    await page.getByRole("tab", { name: "Record", exact: true }).click();
    await page.getByRole("button", { name: "report.html", exact: true }).click();
    await page.getByText("Report version 2", { exact: true }).waitFor();
    await page.getByRole("link", { name: `Agent: ${AGENT}`, exact: true }).click();
    await page.waitForURL(/\/agents\/team%2Fbuild$/u);
    await page.getByRole("tab", { name: "Sessions", exact: true, selected: true }).waitFor();
  });
});

test("a session's Manifest tab, under Deployed, shows where it runs: the version it opened on, coverage, disk and the other sessions", async () => {
  await withStudio(async (page, base, requests) => {
    // The Agent tab's link before the four tabs opens it.
    await page.goto(base + `/sessions/${SESSION}?inspector=agent`);
    await page.getByRole("tab", { name: "Manifest", exact: true, selected: true }).waitFor();
    await page.getByRole("tab", { name: "Deployed", exact: true, selected: true }).waitFor();
    const panel = page.getByRole("tabpanel", { name: "Deployed" });
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
    await page.getByRole("tab", { name: "Deployed", exact: true, selected: true }).waitFor();
    await page.getByRole("tabpanel", { name: "Deployed" }).getByRole("link", { name: "Disk versions", exact: true }).click();
    await page.waitForURL(/\/agents\/team%2Fbuild\?tab=disk$/u);
    await page.getByRole("tab", { name: "Disk", exact: true, selected: true }).waitFor();
  });
});

test("agent manifests are one read-only table on the Tenant's page; a row opens the manifest beside it as a readable spec, on any version, with the Agents made from it", async () => {
  await withStudio(async (page, base, requests) => {
    await page.goto(base);
    await page.locator("[data-sidebar=sidebar]").getByRole("link", { name: /^Resource fixture/u }).click();
    await page.waitForURL(/\/tenant$/u);
    await page.getByRole("tab", { name: "Manifests", exact: true }).click();
    await page.waitForURL(/\/tenant\?tab=manifests$/u);
    const row = page.locator("tbody tr", { hasText: "analyst-box" });
    await row.getByText("v3", { exact: true }).waitFor();
    await row.getByText("Answers questions about data.", { exact: true }).waitFor();
    await page.getByText("2 manifests", { exact: true }).waitFor();
    // Filters on top: no manifest makes a pod.
    await page.getByRole("button", { name: "Filter by kind" }).click();
    await page.getByRole("menuitemradio", { name: "pod" }).click();
    await page.getByText("No manifests match these filters.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Filter by kind" }).click();
    await page.getByRole("menuitemradio", { name: "Any" }).click();
    await page.getByRole("searchbox", { name: "Search manifests" }).fill("pod");
    await page.getByText("1 of 2 manifests", { exact: true }).waitFor();
    await page.getByRole("searchbox", { name: "Search manifests" }).fill("");
    // A row opens the manifest beside the list, on its latest version.
    await row.getByRole("button", { name: "analyst-box", exact: true }).click();
    await page.waitForURL(/\/tenant\?tab=manifests&selected=analyst-box$/u);
    const pane = page.getByRole("complementary", { name: "analyst-box" });
    await pane.getByRole("heading", { name: "analyst-box", exact: true }).waitFor();
    await pane.getByText(/^v3 · latest · saved /u).waitFor();
    await pane.getByRole("heading", { name: "Harness", exact: true }).waitFor();
    await pane.getByRole("heading", { name: "Runtime", exact: true }).waitFor();
    await pane.getByRole("region", { name: "Instructions" }).getByText("Analyse the data.", { exact: true }).waitFor();
    await pane
      .getByRole("region", { name: "Triggers" })
      .getByText("Mondays at 08:00, Europe/Berlin → Session kpi", { exact: true })
      .waitFor();
    // A line opens its part of the manifest.
    const server = pane.getByRole("region", { name: "MCP servers" }).getByRole("button", { name: /^github/u });
    // The tool policy rule on its server is noted beside it; it is edited on the Tool policy tab.
    await server.getByText("Deny delete_repository: Repositories are deleted by people", { exact: false }).waitFor();
    await server.click();
    assert.equal(await server.getAttribute("aria-expanded"), "true");
    await pane.getByText('"type": "streamable-http"', { exact: false }).waitFor();
    // The Agents made from it, on whichever version, each linked to its page.
    await pane.getByRole("link", { name: `${AGENT} v2` }).waitFor();
    await pane.getByRole("link", { name: `${ASKING} v3` }).waitFor();
    // Another version.
    await pane.getByRole("button", { name: "Filter by version" }).click();
    await page.getByRole("menuitemradio", { name: "v2" }).click();
    await page.waitForURL(/\/tenant\?tab=manifests&selected=analyst-box&version=2$/u);
    await pane.getByText(/^v2 of 3 · saved /u).waitFor();
    assert.ok(requests.some((r) => r.path === "/v1/agent-manifests/analyst-box/versions/2"));
    await pane.getByRole("button", { name: "analyst-box actions" }).click();
    await page.getByRole("menuitem", { name: "New Agent from v2…" }).waitFor();
    await page.keyboard.press("Escape");
    // Nothing edits a manifest here.
    for (const name of ["New version", "Save version", "Check"])
      assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0, name);
    await pane.getByRole("button", { name: "Close manifest" }).click();
    await page.waitForURL(/\/tenant\?tab=manifests$/u);
    // The manifests list and a manifest's page before open the Tenant's Manifests tab.
    await page.goto(base + "/agent-manifests");
    await page.waitForURL(/\/tenant\?tab=manifests$/u);
    await page.goto(base + "/agent-manifests/analyst-box?version=2");
    await page.waitForURL(/\/tenant\?tab=manifests&selected=analyst-box&version=2$/u);
    await page.goto(base + "/agent-manifests/missing");
    await page.getByText(/Agent manifest not found/u).first().waitFor();
  });
});

test("an Agent is made from a manifest version, its labels and owner edited, forked to a newer version, and deleted", async () => {
  await withStudio(
    async (page, base, requests) => {
      // From a manifest beside the list: pinned to the version shown.
      await page.goto(base + "/tenant?tab=manifests&selected=analyst-box&version=2");
      await page.getByRole("button", { name: "analyst-box actions" }).click();
      await page.getByRole("menuitem", { name: "New Agent from v2…" }).click();
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
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: "Edit labels and owner…" }).click();
      const edit = page.getByRole("dialog", { name: `Edit ${AGENT}` });
      await edit.getByRole("textbox", { name: "Labels" }).fill("project=build\nteam=a");
      await edit.getByRole("button", { name: "Save labels and owner" }).click();
      await edit.waitFor({ state: "hidden" });
      const edited = requests.find((r) => r.method === "PUT" && r.path === "/v1/agents/team%2Fbuild");
      const { requestId: _edit, ...change } = edited?.body as Record<string, unknown>;
      // An edit names the version it runs: it moves nothing.
      assert.deepEqual(change, { manifest: "analyst-box@2", labels: { project: "build", team: "a" }, owner: null });

      // Fork onto the newer version: check the plan, then fork.
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: "Fork into a new Agent…" }).click();
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
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: "Delete Agent…" }).click();
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
    // The tabs it had before read as the ones that hold them now.
    await page.getByRole("tab", { name: "Activity", exact: true, selected: true }).waitFor();
    await page.goto(base + `/environments?selected=${encoded}&tab=disk`);
    await page.waitForURL(/\/agents\/team%2Fbuild\?tab=disk$/u);
    await page.goto(base + `/vault?environment=${encoded}`);
    await page.waitForURL(/\/agents\/team%2Fbuild\?tab=vault$/u);
    await page.goto(base + `/agents/${encoded}?tab=overview`);
    await page.getByRole("tab", { name: "Sessions", exact: true, selected: true }).waitFor();
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

test("an Agent's Vault sets a declared slot's value and nothing else, also through an old Credentials link", async () => {
  await withStudio(
    async (page, base, requests) => {
      await page.goto(base + `/settings/credentials?environment=${encoded}`);
      await page.waitForURL(/\/agents\/team%2Fbuild\?tab=vault$/u);
      await page.getByRole("tab", { name: "Vault", exact: true, selected: true }).waitFor();
      await page.getByRole("cell", { name: "github", exact: true }).waitFor();
      await page.getByRole("button", { name: "Actions for github" }).click();
      await page.getByRole("menuitem", { name: "Set value" }).click();
      const panel = page.getByRole("dialog", { name: "github" });
      // Its type and where it goes are the manifest's: the value is all it asks for.
      await panel.getByLabel("Token").fill("ghp_secret_value");
      assert.equal(await panel.locator("input").count(), 1);
      await panel.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByText("Saved github.", { exact: false }).waitFor();
      const written = requests.find((r) => r.method === "PUT" && r.path === "/v1/agents/team%2Fbuild/secrets/github");
      assert.ok(written, JSON.stringify(requests.map((r) => `${r.method} ${r.path}`)));
      const { requestId: _id, ...body } = written.body as Record<string, unknown>;
      assert.deepEqual(body, { value: "ghp_secret_value" });
      assert.equal(requests.some((r) => r.path.startsWith("/v1/tenant/vaults")), false);
    },
    false,
    true,
  );
});

test("an Agent's Triggers tab pauses, resumes and runs a trigger, and lists its runs", async () => {
  await withStudio(
    async (page, base, requests) => {
      await page.goto(base + `/agents/${encoded}?tab=triggers`);
      const row = page.locator("tbody tr", { hasText: "weekly-kpi" }).first();
      await row.getByText("Mondays at 08:00, Europe/Berlin", { exact: true }).waitFor();
      await row.getByText("Active", { exact: true }).waitFor();
      await page.getByRole("cell", { name: "A turn in session s-resource" }).waitFor();
      // Its panel shows the prompt its manifest version gives it.
      await row.click();
      const panel = page.getByRole("dialog", { name: "weekly-kpi" });
      await panel.getByText("Write the weekly KPI digest.", { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Actions for weekly-kpi" }).click();
      await page.getByRole("menuitem", { name: "Pause" }).click();
      await page.getByText("Paused weekly-kpi.", { exact: true }).waitFor();
      await row.getByText("Paused", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Actions for weekly-kpi" }).click();
      await page.getByRole("menuitem", { name: "Resume" }).click();
      await row.getByText("Active", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Actions for weekly-kpi" }).click();
      await page.getByRole("menuitem", { name: "Run now" }).click();
      await page.getByText("Ran weekly-kpi", { exact: false }).waitFor();
      const posts = requests.filter((r) => r.method === "POST" && r.path.startsWith("/v1/agents/team%2Fbuild/triggers/"));
      assert.deepEqual(
        posts.map((r) => r.path),
        [
          "/v1/agents/team%2Fbuild/triggers/weekly-kpi/pause",
          "/v1/agents/team%2Fbuild/triggers/weekly-kpi/resume",
          "/v1/agents/team%2Fbuild/triggers/weekly-kpi/run",
        ],
      );
    },
    false,
    true,
  );
});

test("an Agent's Memory tab reads a memory and its history, and deletes it", async () => {
  await withStudio(
    async (page, base, requests) => {
      await page.goto(base + `/agents/${encoded}?tab=memory`);
      const row = page.locator("tbody tr", { hasText: "conventions/release.md" });
      await row.getByText("How releases are named", { exact: true }).waitFor();
      await row.getByText(SESSION, { exact: true }).waitFor();
      await page.getByRole("button", { name: "Actions for conventions/release.md" }).click();
      await page.getByRole("menuitem", { name: "History" }).click();
      const panel = page.getByRole("dialog", { name: "conventions/release.md" });
      await panel.getByText("create", { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      page.once("dialog", (dialog) => void dialog.accept());
      await page.getByRole("button", { name: "Actions for conventions/release.md" }).click();
      await page.getByRole("menuitem", { name: "Delete…" }).click();
      await page.getByText("Deleted conventions/release.md.", { exact: true }).waitFor();
      await page.getByText("It keeps no memories yet.", { exact: true }).waitFor();
      assert.ok(
        requests.some((r) => r.method === "DELETE" && r.path === "/v1/agents/team%2Fbuild/memories/conventions%2Frelease.md"),
      );
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
      await page.getByRole("button", { name: "Disk actions" }).click();
      await page.getByRole("menuitem", { name: "Snapshot now" }).click();
      await page.getByText("Kept version 3: 12 entries", { exact: false }).waitFor();
      assert.ok(requests.some((r) => r.method === "POST" && r.path === "/v1/agents/team%2Fbuild/snapshot"));

      // A version's files, through the folder artifact the Agent owns.
      await page.getByRole("button", { name: "Actions for version 1" }).click();
      await page.getByRole("menuitem", { name: "Browse" }).click();
      await page.waitForURL(/diskArtifact=a-disk&diskVersion=1/u);
      await page.getByRole("button", { name: /nested\/a \+b.html/u }).click();
      await page.getByText("Report version 1", { exact: false }).waitFor();
      assert.ok(requests.some((r) => r.path.startsWith("/v1/artifacts/a-disk/versions/1/")));

      let confirmation = "";
      page.once("dialog", (dialog) => {
        confirmation = dialog.message();
        void dialog.accept();
      });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Actions for version 1" }).click();
      await page.getByRole("menuitem", { name: "Restore…" }).click();
      await page.getByText("Restored version 1.", { exact: true }).waitFor();
      // Restoring changes the disk of every session on it.
      assert.match(confirmation, /2 sessions run on it/u);
      const restore = requests.find((r) => r.path === "/v1/agents/team%2Fbuild/restore");
      assert.equal((restore?.body as { version: number }).version, 1);

      // A fork whose disk starts from a version, with the secrets its manifest declares.
      await page.getByRole("button", { name: "Actions for version 2" }).click();
      await page.getByRole("menuitem", { name: "Fork into a new Agent…" }).click();
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
      await page.getByRole("button", { name: "Actions for version 1" }).click();
      await page.getByRole("menuitem", { name: "Delete…" }).click();
      await page.getByText("Deleted version 1.", { exact: true }).waitFor();
      assert.ok(requests.some((r) => r.method === "DELETE" && r.path === "/v1/agents/team%2Fbuild/versions/1"));
    },
    false,
    true,
  );
});

test("a pod's Manifest tab shows its setup commands and input files, which never change", async () => {
  await withStudio(async (page, base) => {
    // The Setup tab it had before is its Manifest tab now.
    await page.goto(base + `/agents/${encodeURIComponent(POD)}?tab=setup`);
    await page.getByRole("tab", { name: "Manifest", exact: true, selected: true }).waitFor();
    const setup = page.getByRole("region", { name: "Setup" });
    await setup.getByText(`${INPUT_ARTIFACT} v1 → /workspace/data`, { exact: true }).waitFor();
    await setup.getByText("pip install -r requirements.txt", { exact: true }).waitFor();
    await setup.getByText("in /workspace/app · timeout 10m", { exact: true }).click();
    await page.getByRole("dialog", { name: "2. Run" }).getByText('"cwd": "/workspace/app"', { exact: false }).waitFor();
    await page.keyboard.press("Escape");
    // A pod can be stopped and reset.
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Stop compute" }).waitFor();
    await page.getByRole("menuitem", { name: "Reset disk…" }).waitFor();
    await page.keyboard.press("Escape");
    // A virtual Agent has neither setup nor input files.
    await page.goto(base + `/agents/${encoded}?tab=manifest`);
    await page.getByRole("region", { name: "Compute" }).waitFor();
    assert.equal(await page.getByRole("region", { name: "Setup" }).count(), 0);
  });
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
      .getByRole("tab", { name: "Record", exact: true, selected: true })
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
    await frame.getByRole("tab", { name: "Versions (2)", exact: true }).click();
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

test("the Tenant's page: its header, then status, compute, tool policy, limits, usage and keys, each one table", async () => {
  await withStudio(async (page, base, requests) => {
    await page.goto(base + "/settings");
    await page.waitForURL(/\/tenant$/u);
    await page.getByRole("heading", { name: "Resource fixture", level: 1 }).waitFor();
    await page.getByText("Open", { exact: true }).waitFor();
    await page.getByText(TENANT, { exact: true }).first().waitFor();
    await page.getByText("No model set", { exact: true }).first().waitFor();
    await page.getByText("Sandbox virtual, process", { exact: true }).waitFor();
    await page.getByText("3 Agents · 1 session", { exact: true }).waitFor();
    // One row of tabs, in the order a turn meets them; it opens on the status.
    assert.deepEqual(await page.getByRole("tablist", { name: "Tenant tabs" }).getByRole("tab").allTextContents(), [
      "Status",
      "Manifests",
      "Models",
      "Compute",
      "Tool policy",
      "Limits",
      "Usage",
      "Keys",
    ]);
    await page.getByRole("tab", { name: "Status", selected: true }).waitFor();
    await page.getByText("All 4 checks pass", { exact: true }).waitFor();
    const harness = page.locator("tbody tr", { hasText: "Harness" });
    await harness.getByText("1 connected · workspace on", { exact: true }).waitFor();
    // A row links to the tab that configures it.
    await page.locator("tbody tr", { hasText: "Sandbox" }).getByRole("link", { name: "Compute" }).click();
    await page.waitForURL(/\/tenant\?tab=compute$/u);
    await page.getByRole("region", { name: "Backends found" }).getByText("Not enabled", { exact: true }).waitFor();
    const environments = page.getByRole("region", { name: "Environments" });
    await environments.getByText("4 CPUs · 8 GiB memory", { exact: true }).waitFor();
    await environments.getByText("pypi.org, github.com", { exact: true }).waitFor();
    await page.getByRole("region", { name: "Storage" }).getByText("12 MiB used", { exact: true }).waitFor();

    await page.getByRole("tab", { name: "Tool policy" }).click();
    const rule = page.locator("tbody tr", { hasText: "github · delete_repository" });
    await rule.getByText("Deny", { exact: true }).waitFor();
    await rule.getByText("Repositories are deleted by people", { exact: true }).waitFor();
    await page.getByText(/the strictest rule that matches decides/u).waitFor();

    await page.getByRole("tab", { name: "Limits" }).click();
    const attempts = page.locator("tbody tr", { hasText: "modelAttempts" });
    await attempts.getByRole("cell", { name: "5", exact: true }).waitFor();
    await attempts.getByRole("cell", { name: "3", exact: true }).waitFor();
    await page.getByRole("button", { name: "Filter by value" }).click();
    await page.getByRole("menuitemradio", { name: "Changed from default" }).click();
    await page.getByText(/^1 of \d+ limits$/u).waitFor();

    await page.getByRole("tab", { name: "Usage" }).click();
    const today = page.locator("tbody tr", { hasText: "Today" });
    await today.getByRole("cell", { name: "$2.00", exact: true }).waitFor();
    await today.getByRole("cell", { name: "40 K", exact: true }).waitFor();
    const budget = page.locator("tbody tr", { hasText: "The Tenant" });
    await budget.getByText("$60.00 · 24%", { exact: true }).waitFor();

    await page.getByRole("tab", { name: "Keys" }).click();
    await page.locator("tbody tr", { hasText: "web-app" }).getByText("application", { exact: true }).waitFor();
    await page.locator("tbody tr", { hasText: "sk_current" }).getByText("Current", { exact: true }).waitFor();
    // Keys are read-only here.
    for (const name of ["New key", "Rotate…"])
      assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0, name);
    for (const path of ["/v1/tenant", "/v1/tenant/sandbox", "/v1/tenant/tool-policy", "/v1/tenant/limits", "/v1/tenant/budgets", "/v1/tenant/keys", "/v1/tenant/signing-keys"])
      assert.ok(requests.some((r) => r.path === path), path);
    // Settings are on the Tenant's page; the sidebar keeps only the Agents.
    assert.equal(await page.locator("[data-sidebar=sidebar]").getByRole("link", { name: /^(?:Manifests|Models)/u }).count(), 0);
  });
});

test("the Tenant's tool policy, limits, budgets and compute are edited in a panel, and its ⋯ menu resets it", async () => {
  await withStudio(
    async (page, base, requests) => {
      // What the last PUT to `path` sent, without the request id the client adds.
      const put = (path: string) => {
        const body = requests.filter((r) => r.method === "PUT" && r.path === path).at(-1)?.body as
          | Record<string, unknown>
          | undefined;
        if (!body) return undefined;
        const { requestId: _, ...rest } = body;
        return rest;
      };
      await page.goto(base + "/tenant?tab=policy");
      await page.getByRole("button", { name: "Add rule" }).click();
      const rule = page.getByRole("dialog", { name: "New rule" });
      await rule.getByRole("radio", { name: "Ask" }).click();
      await rule.getByLabel("Tool").fill("pay_invoice");
      await rule.getByLabel("Manifest").fill("analyst-box");
      await rule.getByLabel("When").fill('{"amount": {"gt": 100}}');
      await rule.getByLabel("Reason").fill("Payments need a person");
      await rule.getByRole("button", { name: "Save rule" }).click();
      await page.locator("tbody tr", { hasText: "pay_invoice" }).getByText("amount > 100", { exact: true }).waitFor();
      assert.deepEqual(put("/v1/tenant/tool-policy"), {
        rules: [
          { effect: "deny", server: "github", tool: "delete_repository", reason: "Repositories are deleted by people" },
          { effect: "ask", tool: "pay_invoice", agent: "analyst-box", when: { amount: { gt: 100 } }, reason: "Payments need a person" },
        ],
      });

      await page.getByRole("tab", { name: "Limits" }).click();
      await page.locator("tbody tr", { hasText: "memoryBytes" }).click();
      const limit = page.getByRole("dialog", { name: "memoryBytes" });
      await limit.getByLabel("Value").fill("200 KiB");
      await limit.getByRole("button", { name: "Save" }).click();
      await limit.waitFor({ state: "detached" });
      assert.deepEqual(put("/v1/tenant/limits"), { limits: { modelAttempts: 5, memoryBytes: 204800 } });
      await page.getByRole("button", { name: "Actions for modelAttempts" }).click();
      await page.getByRole("menuitem", { name: "Reset to default" }).click();
      await page.locator("tbody tr", { hasText: "modelAttempts" }).getByRole("cell", { name: "3", exact: true }).first().waitFor();
      assert.deepEqual(put("/v1/tenant/limits"), { limits: { memoryBytes: 204800 } });

      await page.getByRole("tab", { name: "Usage" }).click();
      await page.getByRole("button", { name: "Add budget" }).click();
      const budget = page.getByRole("dialog", { name: "New budget" });
      await budget.getByLabel("Applies to").selectOption("manifest");
      await budget.getByLabel("Manifest").fill("analyst-box");
      await budget.getByLabel("Period").selectOption("day");
      await budget.getByLabel("Limit in tokens").fill("2000000");
      await budget.getByRole("button", { name: "Save budget" }).click();
      await page.locator("tbody tr", { hasText: "Manifest analyst-box" }).getByText("2 M tokens", { exact: true }).waitFor();
      assert.deepEqual(put("/v1/tenant/budgets"), {
        budgets: [
          { scope: "tenant", period: "month", limitUsd: 250 },
          { scope: "manifest", id: "analyst-box", period: "day", limitTokens: 2000000 },
        ],
      });

      await page.getByRole("tab", { name: "Compute" }).click();
      await page.getByRole("button", { name: "Edit compute settings…" }).click();
      const compute = page.getByRole("dialog", { name: "Compute settings" });
      await compute.getByLabel("Idle").fill("30m");
      await compute.getByLabel("Most memory").fill("16GiB");
      await compute.getByRole("button", { name: "Save" }).click();
      await page.getByRole("region", { name: "Environments" }).getByText("Stops after 30m without a turn", { exact: true }).waitFor();
      assert.deepEqual(put("/v1/tenant/sandbox"), {
        limits: {
          network: ["pypi.org", "github.com"],
          resources: { cpus: 4, memory: "16384MiB" },
          defaultResources: { cpus: 1, memory: "1024MiB" },
          idle: "30m",
          environments: 100,
        },
        lifecycle: { stopGrace: "10s" },
      });
      // Only what changed is saved: the storage limits stay as they were.
      assert.equal(put("/v1/tenant/artifacts"), undefined);

      let confirmation = "";
      page.once("dialog", (dialog) => {
        confirmation = dialog.message();
        void dialog.accept();
      });
      await page.getByRole("button", { name: "Tenant actions" }).click();
      await page.getByRole("menuitem", { name: "Reset sessions…" }).click();
      await page.getByText("Every session was deleted.", { exact: true }).waitFor();
      assert.match(confirmation, /Every session is deleted/u);
      const reset = requests.find((r) => r.method === "POST" && r.path === "/v1/tenant/reset");
      const { requestId: _, ...sent } = reset?.body as Record<string, unknown>;
      assert.deepEqual(sent, { scope: "sessions", activeWork: "drain" });
    },
    false,
    true,
  );
});
