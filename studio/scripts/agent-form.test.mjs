import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_AGENT_FORM,
  agentRequest,
  editRequest,
  forkRequest,
  isAgentIdText,
  labelsText,
  manifestRef,
  parseLabels,
} from "../web/src/agent-form.ts";

const form = (fields) => ({ ...EMPTY_AGENT_FORM, ...fields });

test("an Agent is made from a manifest it tracks, or a version it pins", () => {
  assert.deepEqual(agentRequest(form({ id: " users/alice/triage ", manifest: "triage" })), {
    id: "users/alice/triage",
    input: { manifest: "triage" },
  });
  assert.deepEqual(
    agentRequest(
      form({ id: "team/a", manifest: "triage", version: "3", owner: " alice ", labels: "team=a\nenv = dev " }),
    ),
    { id: "team/a", input: { manifest: "triage@3", owner: "alice", labels: { team: "a", env: "dev" } } },
  );
  assert.equal(manifestRef("triage", ""), "triage");
  assert.equal(manifestRef("triage", "2"), "triage@2");
});

test("the form says which field is wrong before the request", () => {
  assert.throws(() => agentRequest(form({ id: "/bad", manifest: "triage" })), /Agent id/);
  assert.throws(() => agentRequest(form({ id: "a", manifest: "" })), /agent manifest/);
  assert.throws(() => agentRequest(form({ id: "a", manifest: "triage", version: "0" })), /whole number/);
  assert.throws(() => agentRequest(form({ id: "a", manifest: "triage", labels: "nokey" })), /not a label/);
  assert.equal(isAgentIdText("users/alice/triage"), true);
  assert.equal(isAgentIdText("a".repeat(201)), false);
  assert.equal(isAgentIdText("a//b"), false);
});

test("an edit changes labels and the owner guard, naming the manifest as the Agent was made", () => {
  assert.deepEqual(editRequest({ manifest: "triage@2" }, { labels: "team=a", owner: "" }), {
    manifest: "triage@2",
    labels: { team: "a" },
    owner: null,
  });
  assert.deepEqual(editRequest({ manifest: "triage" }, { labels: "", owner: "bob" }), {
    manifest: "triage",
    labels: {},
    owner: "bob",
  });
  assert.deepEqual(parseLabels("a=1\n\n b = 2 "), { a: "1", b: "2" });
  assert.equal(labelsText({ a: "1", b: "2" }), "a=1\nb=2");
});

test("a fork names its new id, the manifest version, its disk and its secrets", () => {
  assert.deepEqual(forkRequest({ id: "team/a-v3", manifest: "triage@3", disk: "latest", secrets: "copy" }), {
    id: "team/a-v3",
    manifest: "triage@3",
    disk: "latest",
    secrets: "copy",
  });
  assert.deepEqual(forkRequest({ id: "team/b", manifest: " ", disk: 2, secrets: "none" }), {
    id: "team/b",
    disk: 2,
    secrets: "none",
  });
  assert.throws(() => forkRequest({ id: "", manifest: "", disk: "empty", secrets: "copy" }), /new Agent an id/);
  assert.throws(() => forkRequest({ id: "a", manifest: "triage@x", disk: "empty", secrets: "copy" }), /whole number/);
});
