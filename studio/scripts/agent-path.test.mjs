import assert from "node:assert/strict";
import test from "node:test";
import {
  agentPath,
  agentRoute,
  agentTabOf,
  legacyRedirect,
  manifestPath,
  tenantPath,
  tenantTabOf,
} from "../web/src/agent-path.ts";

test("an Agent's page is one percent-encoded segment, opened on a tab", () => {
  assert.equal(agentPath("users/alice/triage"), "/agents/users%2Falice%2Ftriage");
  assert.equal(agentPath("team/build", "sessions"), "/agents/team%2Fbuild");
  assert.equal(agentPath("team/build", "disk"), "/agents/team%2Fbuild?tab=disk");
});

test("the Tenant's page opens on its status; its manifests are a tab with one open beside the list", () => {
  assert.equal(tenantPath(), "/tenant");
  assert.equal(tenantPath("status"), "/tenant");
  assert.equal(tenantPath("policy"), "/tenant?tab=policy");
  assert.equal(tenantTabOf("keys"), "keys");
  assert.equal(tenantTabOf("nope"), undefined);
  assert.equal(tenantTabOf(null), undefined);
  assert.equal(manifestPath(), "/tenant?tab=manifests");
  assert.equal(manifestPath("triage"), "/tenant?tab=manifests&selected=triage");
  assert.equal(manifestPath("triage", 3), "/tenant?tab=manifests&selected=triage&version=3");
});

test("the page opens on its sessions, and the tabs it had before open where they live now", () => {
  assert.equal(agentTabOf(null), undefined);
  assert.equal(agentTabOf("triggers"), "triggers");
  assert.equal(agentTabOf("overview"), "sessions");
  assert.equal(agentTabOf("details"), "sessions");
  assert.equal(agentTabOf("secrets"), "vault");
  assert.equal(agentTabOf("setup"), "manifest");
  assert.equal(agentTabOf("events"), "activity");
  assert.equal(agentTabOf("nope"), undefined);
});

test("a route names the list, one Agent, or a segment that is not found", () => {
  assert.deepEqual(agentRoute("/agents"), { kind: "list" });
  assert.deepEqual(agentRoute("/agents/"), { kind: "list" });
  assert.deepEqual(agentRoute("/agents/team%2Fbuild"), { kind: "agent", id: "team/build" });
  assert.deepEqual(agentRoute("/agents/%E0"), { kind: "invalid", segment: "%E0" });
  // A session's page is not the Agent's.
  assert.equal(agentRoute("/agents/team%2Fbuild/sessions/s1"), undefined);
  assert.equal(agentRoute("/sessions"), undefined);
});

test("old Environment, Credentials, vault and sandbox links open the Agent's page", () => {
  assert.equal(legacyRedirect("/environments/team%2Fbuild", "?tab=disk"), "/agents/team%2Fbuild?tab=disk");
  assert.equal(
    legacyRedirect("/environments", "?selected=team%2Fbuild&tab=secrets"),
    "/agents/team%2Fbuild?tab=vault",
  );
  assert.equal(
    legacyRedirect("/environments", "?selected=team%2Fbuild&tab=details&label=a%3Db"),
    "/agents/team%2Fbuild?label=a%3Db",
  );
  assert.equal(legacyRedirect("/environments", "?label=a%3Db"), "/agents?label=a%3Db");
  assert.equal(legacyRedirect("/environments", ""), "/agents");
  assert.equal(
    legacyRedirect("/settings/credentials", "?environment=team%2Fbuild"),
    "/agents/team%2Fbuild?tab=vault",
  );
  assert.equal(
    legacyRedirect("/vault", "?environment=team%2Fbuild&embed=1"),
    "/agents/team%2Fbuild?tab=vault&embed=1",
  );
  assert.equal(legacyRedirect("/settings/credentials", ""), "/agents");
  assert.equal(legacyRedirect("/sandboxes", "?label=a%3Db"), "/agents?label=a%3Db");
  assert.equal(legacyRedirect("/agents", ""), undefined);
  assert.equal(legacyRedirect("/sessions/s1", ""), undefined);
});

test("Studio opens on its Agents; the session list it had before opens an Agent's sessions", () => {
  assert.equal(legacyRedirect("/", ""), "/agents");
  assert.equal(legacyRedirect("/", "?embed=1"), "/agents?embed=1");
  assert.equal(legacyRedirect("/sessions", ""), "/agents");
  assert.equal(legacyRedirect("/sessions/", "?embed=1"), "/agents?embed=1");
  assert.equal(legacyRedirect("/sessions", "?agent=team%2Fbuild&embed=1"), "/agents/team%2Fbuild?embed=1");
});

test("the settings and manifest pages before open the Tenant's page, on the tab they became", () => {
  assert.equal(legacyRedirect("/settings", ""), "/tenant");
  assert.equal(legacyRedirect("/settings/overview", "?embed=1"), "/tenant?embed=1");
  assert.equal(legacyRedirect("/settings/models", ""), "/tenant?tab=models");
  assert.equal(legacyRedirect("/agent-manifests", ""), "/tenant?tab=manifests");
  assert.equal(legacyRedirect("/agent-manifests", "?selected=triage"), "/tenant?tab=manifests&selected=triage");
  assert.equal(legacyRedirect("/agent-manifests/triage", ""), "/tenant?tab=manifests&selected=triage");
  assert.equal(
    legacyRedirect("/agent-manifests/triage", "?version=3&embed=1"),
    "/tenant?tab=manifests&selected=triage&version=3&embed=1",
  );
  assert.equal(legacyRedirect("/agent-manifests/%E0", ""), undefined);
  assert.equal(legacyRedirect("/tenant", ""), undefined);
});
