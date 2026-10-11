import assert from "node:assert/strict";
import test from "node:test";
import { pendingApprovals } from "../web/src/approvals.ts";

const paused = (interactions) => ({ type: "turn.paused", payload: { interactions } });
const held = (id, extra = {}) => ({
  invocationId: `inv-${id}`,
  callId: `call-${id}`,
  toolName: "refund",
  interaction: { id, kind: "approval", prompt: "Approve refund? Refunds over 100 need a person", reason: "Refunds over 100 need a person", input: { amount: 120 }, ...extra },
  status: "interaction",
});

test("lists the approvals of the last turn.paused, with tool, reason and input", () => {
  assert.deepEqual(pendingApprovals([{ type: "command.message", payload: {} }, paused([held("e1", { server: "billing" })])]), [
    {
      id: "e1",
      toolName: "refund",
      prompt: "Approve refund? Refunds over 100 need a person",
      reason: "Refunds over 100 need a person",
      server: "billing",
      input: { amount: 120 },
    },
  ]);
});

test("drops an approval a later approve answered, and every one once the turn ended", () => {
  const events = [paused([held("e1"), held("e2")]), { type: "command.approve", payload: { interactionId: "e1", approved: true } }];
  assert.deepEqual(
    pendingApprovals(events).map((approval) => approval.id),
    ["e2"],
  );
  assert.deepEqual(pendingApprovals([...events, { type: "turn.completed", payload: {} }]), []);
});

test("ignores interactions that are not approvals", () => {
  assert.deepEqual(pendingApprovals([paused([{ invocationId: "i", interaction: { id: "q", kind: "response" } }])]), []);
});
