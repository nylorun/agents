import assert from "node:assert/strict";
import test from "node:test";
import {
  linksFromEvents,
  mergeLinkIndex,
  workflowLinkFor,
} from "../web/src/workflow/links.ts";
import {
  clearWorkflowLinks,
  lookupWorkflowLink,
  rememberWorkflowLinks,
} from "../web/src/workflow/link-store.ts";

const fixtures = [
  {
    type: "node.agent",
    payload: {
      path: "fix-tests/coder",
      sessionId: "sess-coder",
      turnId: "t1",
    },
  },
  {
    type: "loop.iteration",
    payload: {
      path: "fix-tests",
      n: 1,
      sessionId: "sess-coder",
      turnId: "t1",
    },
  },
];

test("linksFromEvents builds agent→workflow links", () => {
  const links = linksFromEvents(fixtures, "wf-session-1", {
    workflowAgentId: "fix-tests",
  });
  const link = workflowLinkFor("sess-coder", links);
  assert.deepEqual(link, {
    workflowSessionId: "wf-session-1",
    path: "fix-tests/coder",
    workflowAgentId: "fix-tests",
  });
});

test("mergeLinkIndex accepts Runtime links-index fixtures", () => {
  const merged = mergeLinkIndex(new Map(), [
    {
      agentSessionId: "a1",
      workflowSessionId: "w1",
      path: "ship/planner",
      workflowAgentId: "ship-feature",
    },
  ]);
  assert.equal(merged.get("a1")?.path, "ship/planner");
});

test("link store remembers links for agent session views", () => {
  clearWorkflowLinks();
  rememberWorkflowLinks(
    linksFromEvents(fixtures, "wf-session-1", {
      workflowAgentId: "fix-tests",
    }),
  );
  assert.equal(lookupWorkflowLink("sess-coder")?.workflowSessionId, "wf-session-1");
  clearWorkflowLinks();
  assert.equal(lookupWorkflowLink("sess-coder"), undefined);
});
