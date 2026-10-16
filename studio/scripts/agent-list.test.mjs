import assert from "node:assert/strict";
import test from "node:test";
import {
  NO_OWNER,
  agentActivity,
  agentFilter,
  agentGroups,
  agentsPath,
  filterAgents,
  isFlowManifest,
  labelsOf,
  manifestNameOf,
  manifestVersionOf,
  sortAgents,
  stateLabel,
} from "../web/src/agent-list.ts";

const agent = (id, manifest, fields = {}) => ({
  id,
  manifest,
  resolvedVersion: 1,
  labels: {},
  state: "sleeping",
  owner: null,
  lastUsedAt: "2026-10-15T00:00:00.000Z",
  ...fields,
});
const manifest = (name, harness = {}) => ({
  name,
  version: 3,
  hash: "h",
  manifest: { manifestSchemaVersion: 8, name, harness },
  agents: 0,
  createdAt: "2026-10-15T00:00:00.000Z",
  savedBy: { actor: "studio" },
});

test("the list is filtered to a state, a manifest, an owner and labels by its query", () => {
  assert.equal(agentsPath(), "/agents");
  assert.equal(agentsPath({ manifest: "triage" }), "/agents?manifest=triage");
  assert.equal(
    agentsPath({ state: "failing", owner: NO_OWNER, labels: ["team=a"] }),
    "/agents?state=failing&owner=-&label=team%3Da",
  );
  assert.deepEqual(agentFilter("?state=working&manifest=a&owner=alice&label=team%3Da&label=bad"), {
    state: "working",
    manifest: "a",
    owner: "alice",
    labels: ["team=a"],
  });
  assert.deepEqual(agentFilter(""), { labels: [] });
  assert.deepEqual(agentFilter("?manifest="), { labels: [] });
});

test("an Agent names the manifest it tracks or pins, and the version it runs", () => {
  assert.equal(manifestNameOf({ manifest: "triage" }), "triage");
  assert.equal(manifestNameOf({ manifest: "triage@3" }), "triage");
  assert.equal(manifestVersionOf({ manifest: "triage", resolvedVersion: 4 }), "triage@4");
  assert.deepEqual(labelsOf({ labels: { team: "a", env: "dev" } }), ["env=dev", "team=a"]);
  assert.equal(stateLabel("input_required"), "Input required");
});

test("filters keep the Agents with the state, manifest, owner and every label", () => {
  const agents = [
    agent("a", "triage", { labels: { team: "a" }, owner: "alice" }),
    agent("b", "triage@2", { state: "working" }),
    agent("c", "ship", { labels: { team: "a", env: "dev" } }),
  ];
  const ids = (filter) => filterAgents(agents, { labels: [], ...filter }).map((a) => a.id);
  assert.deepEqual(ids({ manifest: "triage" }), ["a", "b"]);
  assert.deepEqual(ids({ state: "working" }), ["b"]);
  assert.deepEqual(ids({ owner: "alice" }), ["a"]);
  assert.deepEqual(ids({ owner: NO_OWNER }), ["b", "c"]);
  assert.deepEqual(ids({ labels: ["team=a", "env=dev"] }), ["c"]);
});

test("Agents that need input or fail come first, then the latest activity", () => {
  const agents = [
    agent("old", "t", { lastUsedAt: "2026-10-01T00:00:00.000Z" }),
    agent("failing", "t", { state: "failing", lastUsedAt: "2026-10-01T00:00:00.000Z" }),
    agent("busy", "t", { state: "working", lastUsedAt: "2026-10-02T00:00:00.000Z" }),
    agent("asks", "t", { state: "input_required", lastUsedAt: "2026-09-01T00:00:00.000Z" }),
  ];
  // A session's event is activity too.
  const activity = agentActivity(agents, [
    { agentId: "old", createdAt: null, lastEventAt: "2026-10-05T00:00:00.000Z" },
    { agentId: "busy", createdAt: "2026-10-03T00:00:00.000Z", lastEventAt: null },
  ]);
  assert.equal(activity.get("old"), "2026-10-05T00:00:00.000Z");
  assert.equal(activity.get("busy"), "2026-10-03T00:00:00.000Z");
  assert.deepEqual(
    sortAgents(agents, activity).map((a) => a.id),
    ["asks", "failing", "old", "busy"],
  );
  // The input stays as it was.
  assert.equal(agents[0].id, "old");
});

test("groups list each saved manifest, then any other an Agent names, with their Agents", () => {
  const groups = agentGroups(
    [manifest("triage"), manifest("analyst", { kind: "workflow" })],
    [agent("a", "triage"), agent("b", "gone@1"), agent("c", "triage@3", { state: "failing" })],
  );
  assert.deepEqual(
    groups.map((group) => [group.name, group.agents.map((a) => a.id), group.manifest !== undefined]),
    [
      ["analyst", [], true],
      ["triage", ["c", "a"], true],
      ["gone", ["b"], false],
    ],
  );
  assert.equal(isFlowManifest(groups[0].manifest), true);
  assert.equal(isFlowManifest(groups[1].manifest), false);
  assert.equal(isFlowManifest(undefined), false);
});
