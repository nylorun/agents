import assert from "node:assert/strict";
import test from "node:test";
import {
  NEW_SESSION,
  definitionForSession,
  isNewSessionState,
  sessionEnvironment,
  sessionEnvironmentId,
  sessionHref,
} from "../web/src/session-open.ts";

const orders = { id: "orders", name: "Orders", manifest: {} };
const shipping = {
  id: "shipping",
  name: "Shipping",
  kind: "workflow",
  manifest: {
    kind: "workflow",
    workflowSchemaVersion: 3,
    id: "shipping",
    root: { chain: [{ agent: "logistics-planner" }, { agent: "customs" }] },
    agents: {
      "logistics-planner": {
        id: "logistics-planner",
        name: "Logistics planner",
        tools: [{ name: "route" }],
      },
      customs: {
        kind: "workflow",
        workflowSchemaVersion: 3,
        id: "customs",
        root: { agent: "declarer" },
        agents: { declarer: { id: "declarer" } },
      },
    },
  },
};

test("only Studio's own New session state may create a session", () => {
  assert.equal(isNewSessionState(NEW_SESSION), true);
  assert.equal(isNewSessionState(null), false);
  assert.equal(isNewSessionState(undefined), false);
  assert.equal(isNewSessionState({ newSession: "yes" }), false);
});

test("a child session links to the generic session route", () => {
  assert.equal(sessionHref("wf_a/b"), "/sessions/wf_a%2Fb");
});

test("a registered agent is the session's definition", () => {
  assert.equal(definitionForSession("orders", [orders, shipping]), orders);
});

test("an agent embedded in a flow, also a nested flow, is found in the workflow manifest", () => {
  const planner = definitionForSession("logistics-planner", [orders, shipping], ["shipping"]);
  assert.equal(planner.id, "logistics-planner");
  assert.equal(planner.name, "Logistics planner");
  assert.deepEqual(planner.manifest.tools, [{ name: "route" }]);
  const declarer = definitionForSession("declarer", [orders, shipping]);
  assert.equal(declarer.id, "declarer");
  assert.equal(definitionForSession("customs", [shipping]).kind, "workflow");
});

test("an unknown agent still opens, named by its id", () => {
  assert.deepEqual(definitionForSession("ghost", [orders]), {
    id: "ghost",
    name: "ghost",
    manifest: {},
  });
});

test("a session view names its Environment and the recipe version it opened on, or none", () => {
  assert.deepEqual(sessionEnvironment({ environment: { id: "team/build", version: 2 } }), {
    id: "team/build",
    version: 2,
  });
  assert.deepEqual(sessionEnvironment({ environment: { id: "team/build" } }), { id: "team/build" });
  assert.deepEqual(sessionEnvironment({ environment: { id: "a", version: 0 } }), { id: "a" });
  assert.equal(sessionEnvironment({ environment: null }), undefined);
  assert.equal(sessionEnvironment({}), undefined);
  assert.equal(sessionEnvironment({ environment: { id: "" } }), undefined);
  assert.equal(sessionEnvironmentId({ environment: { id: "team/build", version: 2 } }), "team/build");
});
