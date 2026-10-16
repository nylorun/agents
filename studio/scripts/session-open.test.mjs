import assert from "node:assert/strict";
import test from "node:test";
import {
  NEW_SESSION,
  asStudioDefinition,
  harnessDefinition,
  isNewSessionState,
  loadSessionDefinition,
  sessionHref,
} from "../web/src/session-open.ts";

const harness = { instructions: ["Triage."], tools: [{ name: "route" }] };
const flow = {
  kind: "workflow",
  root: { chain: [{ agent: "logistics-planner" }] },
  agents: { "logistics-planner": { id: "logistics-planner", tools: [{ name: "route" }] } },
};

/** A client whose reads answer from `fields`; `features` are the Host's. */
function reader({ features = ["session-reads"], session, agent, versions = {}, latest } = {}) {
  const reads = [];
  return {
    reads,
    hostFeatures: async () => features,
    session: (id) => ({
      manifest: async () => {
        reads.push(`session ${id}`);
        if (session instanceof Error) throw session;
        return session;
      },
    }),
    agents: {
      get: async (id) => {
        reads.push(`agent ${id}`);
        return agent;
      },
    },
    agentManifests: {
      get: async (name, version) => {
        reads.push(`manifest ${name}${version === undefined ? "" : `@${version}`}`);
        if (version === undefined) {
          if (latest === undefined) throw new Error("not found");
          return { name, version: latest, hash: "latest", manifest: { name, harness } };
        }
        return versions[version];
      },
    },
  };
}

test("only Studio's own New session state may create a session", () => {
  assert.equal(isNewSessionState(NEW_SESSION), true);
  assert.equal(isNewSessionState(null), false);
  assert.equal(isNewSessionState(undefined), false);
  assert.equal(isNewSessionState({ newSession: "yes" }), false);
});

test("a child session links to the generic session route", () => {
  assert.equal(sessionHref("wf_a/b"), "/sessions/wf_a%2Fb");
});

test("a session runs the loop manifest it pinned, named by its agent manifest, with the latest version", async () => {
  const client = reader({
    session: {
      sessionId: "s1",
      agentId: "users/alice/triage",
      definition: { name: "triage", version: 2 },
      manifestHash: "h2",
      manifest: { manifestSchemaVersion: 7, id: "triage", ...harness },
    },
    latest: 3,
  });
  const { definition, pinned } = await loadSessionDefinition(client, "s1", "users/alice/triage");
  assert.equal(definition.id, "triage");
  assert.equal(definition.name, "triage");
  assert.equal(definition.manifestHash, "h2");
  assert.deepEqual(definition.manifest.tools, [{ name: "route" }]);
  assert.equal(pinned.kind, "pinned");
  assert.deepEqual(pinned.version, { name: "triage", version: 2 });
  assert.equal(pinned.latest, 3);
  assert.deepEqual(client.reads, ["session s1", "manifest triage"]);
});

test("a flow's session is a workflow definition; a session closed by protocol 16 pinned no version", async () => {
  const { definition, pinned } = await loadSessionDefinition(
    reader({
      session: { sessionId: "s1", agentId: "ops", definition: null, manifestHash: "h", manifest: { id: "ship", ...flow } },
    }),
    "s1",
    "ops",
  );
  assert.equal(definition.kind, "workflow");
  assert.equal(definition.id, "ship");
  assert.equal(pinned.version, undefined);
  assert.equal(pinned.latest, undefined);
});

test("without session reads, a session runs the version its Agent runs", async () => {
  const client = reader({
    features: [],
    agent: { manifest: "triage@2", resolvedVersion: 2 },
    versions: { 2: { name: "triage", version: 2, hash: "h2", manifest: { name: "triage", harness } } },
    latest: 2,
  });
  const { definition, pinned } = await loadSessionDefinition(client, "s1", "users/alice/triage");
  assert.equal(definition.name, "triage");
  assert.deepEqual(definition.rawManifest.instructions, ["Triage."]);
  assert.deepEqual(pinned, { kind: "agent", manifest: harness, version: { name: "triage", version: 2 }, latest: 2 });
  assert.deepEqual(client.reads, ["agent users/alice/triage", "manifest triage@2", "manifest triage"]);
});

test("a session whose manifest cannot be read still opens, named by its Agent", async () => {
  const { definition, pinned } = await loadSessionDefinition(
    reader({ session: new Error("Session reads are off") }),
    "s1",
    "users/alice/triage",
  );
  assert.deepEqual(definition, { id: "users/alice/triage", name: "users/alice/triage", manifest: {} });
  assert.deepEqual(pinned, { kind: "failed", message: "Session reads are off" });
});

test("a harness section reads as the loop manifest a session pins", () => {
  assert.equal(harnessDefinition("ship", flow).kind, "workflow");
  const triage = harnessDefinition("triage", harness, "h");
  assert.equal(triage.id, "triage");
  assert.equal(triage.manifestHash, "h");
  assert.equal(asStudioDefinition({ manifest: { id: "a", name: "A" } }).name, "A");
});
