import assert from "node:assert/strict";
import test from "node:test";
import {
  NEW_SESSION,
  definitionForSession,
  isNewSessionState,
  sessionHref,
} from "../web/src/session-open.ts";

const orders = { id: "orders", name: "Orders", manifest: { capabilities: [] } };
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
        capabilities: [{ id: "maps", tools: [{ name: "route" }] }],
      },
      customs: {
        kind: "workflow",
        workflowSchemaVersion: 3,
        id: "customs",
        root: { agent: "declarer" },
        agents: { declarer: { id: "declarer", capabilities: [] } },
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
  assert.deepEqual(planner.manifest.capabilities[0].tools, [{ name: "route" }]);
  const declarer = definitionForSession("declarer", [orders, shipping]);
  assert.equal(declarer.id, "declarer");
  assert.equal(definitionForSession("customs", [shipping]).kind, "workflow");
});

test("an unknown agent still opens, named by its id", () => {
  assert.deepEqual(definitionForSession("ghost", [orders]), {
    id: "ghost",
    name: "ghost",
    manifest: { capabilities: [] },
  });
});
