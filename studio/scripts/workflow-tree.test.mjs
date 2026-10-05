import assert from "node:assert/strict";
import test from "node:test";
import {
  expandMapItems,
  treeFromManifest,
} from "../web/src/workflow/manifest-tree.ts";

/** The issue desk as workflow manifest v3 (abridged agents). */
const issueDesk = {
  kind: "workflow",
  workflowSchemaVersion: 3,
  id: "issue-desk",
  root: {
    chain: [
      { agent: "triage" },
      {
        switch: {
          cases: {
            bug: { loop: { run: { agent: "fixer" }, verify: { agent: "tester" }, max: 3 } },
            docs: { agent: "docs-writer" },
          },
          default: {
            chain: [
              { agent: "planner" },
              { map: { each: { agent: "implementer" } } },
              { agent: "docs-writer", id: "feature-docs" },
            ],
          },
        },
        id: "route",
      },
      { parallel: { security: { agent: "security-reviewer" } }, id: "reviews" },
      { agent: "review" },
      { tool: { name: "open_pr" } },
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
      workflowSchemaVersion: 3,
      id: "review",
      root: {
        chain: [
          { agent: "reader" },
          { loop: { run: { agent: "fixer" }, verify: { agent: "judge" }, max: 2 } },
        ],
      },
      agents: { reader: { id: "reader" }, fixer: { id: "fixer" }, judge: { id: "judge" } },
    },
  },
};

test("leaves at their session paths, control stages at their keys", () => {
  const tree = treeFromManifest(issueDesk);
  assert.equal(tree.path, "@");
  assert.equal(tree.layout, "row");
  const [triage, route, reviews, review, openPr] = tree.children;
  assert.equal(triage?.path, "triage");
  assert.equal(triage?.agentId, "triage");
  assert.equal(route?.kind, "switch");
  assert.equal(route?.layout, "fork");
  assert.equal(route?.path, "route");
  const [bug, docs, fallback] = route.children;
  assert.equal(bug?.kind, "case");
  assert.equal(bug?.path, "@1.bug");
  assert.equal(docs?.children[0]?.path, "docs-writer");
  assert.equal(fallback?.label, "default");
  const steps = fallback.children[0].children;
  assert.deepEqual(steps.map((s) => s.path), ["planner", "@1.default.1", "feature-docs"]);
  assert.equal(steps[1]?.kind, "map");
  assert.equal(steps[1]?.layout, "map");
  assert.equal(steps[1]?.children[0]?.path, "implementer");
  assert.equal(steps[2]?.agentId, "docs-writer");
  assert.equal(reviews?.path, "reviews");
  assert.equal(reviews?.layout, "lanes");
  assert.equal(reviews?.children[0]?.label, "security");
  assert.equal(reviews?.children[0]?.children[0]?.path, "security-reviewer");
  assert.equal(openPr?.kind, "tool");
  assert.equal(openPr?.path, "open_pr");
});

test("a loop shows its body, its verifier agent and its max", () => {
  const [, route] = treeFromManifest(issueDesk).children;
  const loop = route.children[0].children[0];
  assert.equal(loop?.kind, "loop");
  assert.equal(loop?.layout, "loop");
  assert.equal(loop?.path, "@1.bug");
  assert.equal(loop?.label, "@1.bug · max 3");
  assert.deepEqual(
    loop.children.map((c) => [c.kind, c.path, c.agentId]),
    [
      ["agent", "fixer", "fixer"],
      ["agent", "tester", "tester"],
    ],
  );
});

test("a nested flow agent is drawn inline under its id", () => {
  const review = treeFromManifest(issueDesk).children[3];
  assert.equal(review?.kind, "flow");
  assert.deepEqual(
    review.children[0].children.map((c) => c.path),
    ["review/reader", "review/@1"],
  );
  assert.deepEqual(
    review.children[0].children[1].children.map((c) => c.path),
    ["review/fixer", "review/judge"],
  );
});

test("Map item drill-down expands indexed lanes", () => {
  const map = treeFromManifest({
    kind: "workflow",
    workflowSchemaVersion: 3,
    id: "ship",
    root: { map: { each: { agent: "coder" } }, id: "implement" },
    agents: { coder: { id: "coder" } },
  });
  const items = expandMapItems(map, 2);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.path, "implement[0]");
  assert.equal(items[0]?.kind, "item");
  assert.equal(items[1]?.children[0]?.path, "implement[1]/coder");
});

test("an HTTP stage and an HTTP verifier show their method and URL", () => {
  const tree = treeFromManifest({
    kind: "workflow",
    workflowSchemaVersion: 3,
    id: "refunds",
    root: {
      chain: [
        { agent: "orders" },
        { tool: { name: "refund", http: { url: "https://billing.example.com/refunds", method: "PUT" } } },
        {
          loop: {
            run: { agent: "fixer" },
            verify: { http: { url: "https://checks.example.com/verify" } },
            max: 3,
          },
        },
      ],
    },
    agents: { orders: { id: "orders" }, fixer: { id: "fixer" } },
  });
  const [, refund, loop] = tree.children;
  assert.deepEqual(
    { path: refund?.path, kind: refund?.kind, detail: refund?.detail },
    { path: "refund", kind: "http", detail: "PUT https://billing.example.com/refunds" },
  );
  const [body, verify] = loop.children;
  assert.equal(body?.path, "fixer");
  assert.deepEqual(
    { path: verify?.path, kind: verify?.kind, label: verify?.label, detail: verify?.detail },
    { path: "@2.verify", kind: "http", label: "verify", detail: "POST https://checks.example.com/verify" },
  );
});
