import assert from "node:assert/strict";
import test from "node:test";
import {
  expandMapItems,
  treeFromManifest,
} from "../web/src/workflow/manifest-tree.ts";

/** Design example from workflows.md §18. */
const shipFeature = {
  kind: "workflow",
  workflowSchemaVersion: 1,
  id: "ship-feature",
  root: {
    chain: {
      id: "ship-feature",
      steps: [
        { agent: "planner" },
        {
          map: {
            id: "implement",
            over: { fn: true },
            each: {
              loop: {
                id: "code",
                run: { agent: "coder" },
                verify: { fn: true },
                decide: { fn: true },
              },
            },
          },
        },
        { tool: { name: "open-pr", inputSchema: { type: "array" } } },
      ],
    },
  },
};

test("WF-EV9/WF-C10: treeFromManifest draws Chain as row, Map as map, Loop as loop", () => {
  const tree = treeFromManifest(shipFeature);
  assert.equal(tree.kind, "chain");
  assert.equal(tree.layout, "row");
  assert.equal(tree.path, "ship-feature");
  assert.equal(tree.children.length, 3);
  assert.equal(tree.children[0]?.kind, "agent");
  assert.equal(tree.children[0]?.path, "ship-feature/planner");
  assert.equal(tree.children[0]?.agentId, "planner");
  const map = tree.children[1];
  assert.equal(map?.kind, "map");
  assert.equal(map?.layout, "map");
  assert.equal(map?.path, "ship-feature/implement");
  const loop = map?.children[0];
  assert.equal(loop?.kind, "loop");
  assert.equal(loop?.layout, "loop");
  assert.equal(loop?.path, "ship-feature/implement/code");
  assert.equal(loop?.children[0]?.agentId, "coder");
  assert.equal(tree.children[2]?.kind, "tool");
  assert.equal(tree.children[2]?.path, "ship-feature/open-pr");
});

test("WF-C10: Switch is a fork and Parallel uses lanes", () => {
  const tree = treeFromManifest({
    kind: "workflow",
    workflowSchemaVersion: 1,
    id: "route",
    root: {
      switch: {
        id: "route",
        on: { fn: true },
        cases: {
          bug: { agent: "fixer" },
          feature: {
            parallel: {
              id: "review",
              branches: {
                security: { agent: "sec" },
                style: { agent: "style" },
              },
            },
          },
        },
      },
    },
  });
  assert.equal(tree.layout, "fork");
  assert.equal(tree.children[0]?.kind, "case");
  const parallel = tree.children[1]?.children[0];
  assert.equal(parallel?.layout, "lanes");
  assert.equal(parallel?.children.length, 2);
  assert.equal(parallel?.children[0]?.label, "security");
});

test("WF-C10: Map item drill-down expands indexed lanes", () => {
  const tree = treeFromManifest(shipFeature);
  const map = tree.children[1];
  assert.ok(map);
  const items = expandMapItems(map, 2);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.path, "ship-feature/implement[0]");
  assert.equal(items[0]?.kind, "item");
  assert.equal(
    items[0]?.children[0]?.path,
    "ship-feature/implement[0]/code",
  );
  assert.equal(
    items[1]?.children[0]?.children[0]?.path,
    "ship-feature/implement[1]/code/coder",
  );
});

test("slot id renames the child path part", () => {
  const tree = treeFromManifest({
    kind: "workflow",
    workflowSchemaVersion: 1,
    id: "draft-twice",
    root: {
      chain: {
        id: "draft-twice",
        steps: [
          { slot: { id: "draft", run: { agent: "writer" } } },
          { agent: "critic" },
        ],
      },
    },
  });
  assert.equal(tree.children[0]?.path, "draft-twice/draft");
  assert.equal(tree.children[0]?.agentId, "writer");
});

/** Flow Agents: the design's issue-desk as workflow manifest v2 (abridged agents). */
const issueDesk = {
  kind: "workflow",
  workflowSchemaVersion: 2,
  id: "issue-desk",
  root: {
    chain: [
      { agent: "triage" },
      {
        switch: {
          on: { fn: true },
          cases: {
            bug: { loop: { run: { agent: "fixer" }, verify: { agent: "tester" }, max: 3 } },
            docs: { agent: "docs-writer" },
          },
          default: {
            chain: [
              { agent: "planner" },
              { map: { each: { agent: "implementer" } }, input: { fn: true } },
              { agent: "docs-writer", id: "feature-docs" },
            ],
          },
        },
        id: "route",
      },
      { parallel: { security: { agent: "security-reviewer" } }, id: "reviews" },
      { agent: "review" },
      { tool: { name: "open_pr" }, input: { fn: true } },
    ],
  },
  agents: {
    triage: { id: "triage" },
    fixer: { id: "fixer" },
    tester: { id: "tester" },
    "docs-writer": { id: "docs-writer" },
    planner: { id: "planner" },
    implementer: { id: "implementer" },
    "security-reviewer": { id: "security-reviewer" },
    review: {
      kind: "workflow",
      workflowSchemaVersion: 2,
      id: "review",
      root: { chain: [{ agent: "reader" }, { loop: { run: { agent: "fixer" }, verify: { fn: true }, decide: { fn: true } } }] },
      agents: { reader: { id: "reader" }, fixer: { id: "fixer" } },
    },
  },
};

test("Flow Agents v2: leaves at their session paths, control stages at their keys", () => {
  const tree = treeFromManifest(issueDesk);
  assert.equal(tree.path, "@");
  const [triage, route, reviews, review, openPr] = tree.children;
  assert.equal(triage?.path, "triage");
  assert.equal(route?.kind, "switch");
  assert.equal(route?.path, "route");
  const [bug, docs, fallback] = route.children;
  assert.equal(bug?.path, "@1.bug");
  const loop = bug.children[0];
  assert.equal(loop?.path, "@1.bug");
  assert.equal(loop?.label, "@1.bug · max 3");
  assert.deepEqual(loop.children.map((c) => c.path), ["fixer", "tester"]);
  assert.equal(docs?.children[0]?.path, "docs-writer");
  assert.equal(fallback?.label, "default");
  const steps = fallback.children[0].children;
  assert.deepEqual(steps.map((s) => s.path), ["planner", "@1.default.1", "feature-docs"]);
  assert.equal(steps[1]?.kind, "map");
  assert.equal(steps[1]?.children[0]?.path, "implementer");
  assert.equal(steps[2]?.agentId, "docs-writer");
  assert.equal(reviews?.path, "reviews");
  assert.equal(reviews?.children[0]?.children[0]?.path, "security-reviewer");
  assert.equal(review?.kind, "flow");
  assert.deepEqual(
    review.children[0].children.map((c) => c.path),
    ["review/reader", "review/@1"],
  );
  assert.deepEqual(
    review.children[0].children[1].children.map((c) => c.path),
    ["review/fixer", "review/@1:verify", "review/@1:decide"],
  );
  assert.equal(openPr?.kind, "tool");
  assert.equal(openPr?.path, "open_pr");
});
