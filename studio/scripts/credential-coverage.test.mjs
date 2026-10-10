import assert from "node:assert/strict";
import test from "node:test";
import {
  coverageCounts,
  coverageEntryLabel,
  coverageStatusLabel,
  coverageTone,
  credentialChoices,
  keptPicks,
  selectionsOf,
  suggestedVaultIds,
  vaultHolds,
} from "../web/src/credential-coverage.ts";
import {
  NEW_SESSION,
  newSessionCredentials,
  newSessionState,
} from "../web/src/session-open.ts";

const credential = (vaultId, credentialId) => ({
  vaultId,
  vaultName: vaultId,
  credentialId,
  credentialName: credentialId,
});
const entry = (fields) => ({
  kind: "mcp",
  name: fields.serverName ?? "tickets",
  serverName: "tickets",
  url: "https://mcp.tickets.example/mcp",
  required: false,
  status: "missing",
  matches: [],
  available: [],
  message: "",
  ...fields,
});

test("suggests the vaults that hold a missing credential, one per URL", () => {
  const coverage = {
    agentId: "triage",
    vaultIds: ["kept"],
    complete: false,
    entries: [
      entry({ serverName: "tickets", available: [credential("mine", "t1"), credential("shared", "t2")] }),
      // Already held by a suggested vault: nothing more is added.
      entry({ serverName: "docs", available: [credential("shared", "d1"), credential("mine", "d2")] }),
      entry({ serverName: "billing", kind: "http", required: true, available: [credential("billing", "b1")] }),
      entry({ serverName: "covered", status: "covered", matches: [credential("kept", "c1")] }),
      entry({ serverName: "public" }),
    ],
  };
  assert.deepEqual(suggestedVaultIds(coverage), ["kept", "mine", "billing"]);
  assert.equal(vaultHolds(coverage, "mine"), 2);
  assert.equal(vaultHolds(coverage, "kept"), 1);
  assert.equal(vaultHolds(coverage, "nowhere"), 0);
});

test("offers a choice where several attached credentials match, and keeps it once picked", () => {
  const coverage = {
    agentId: "triage",
    vaultIds: ["a", "b"],
    complete: false,
    entries: [
      entry({ serverName: "billing", status: "ambiguous", matches: [credential("a", "b1"), credential("b", "b2")] }),
      entry({ serverName: "picked", status: "covered", matches: [credential("a", "p1"), credential("b", "p2")] }),
      entry({ serverName: "wrong", status: "selection_mismatch", matches: [credential("a", "w1")] }),
      entry({ serverName: "single", status: "covered", matches: [credential("a", "s1")] }),
    ],
  };
  assert.deepEqual(
    credentialChoices(coverage).map((choice) => [choice.serverName, choice.options.map((item) => item.credentialId)]),
    [
      ["billing", ["b1", "b2"]],
      ["picked", ["p1", "p2"]],
      ["wrong", ["w1"]],
    ],
  );
});

test("drops a pick whose vault is detached, and sends picks without vaults", () => {
  const picks = [
    { serverName: "billing", credentialId: "b2", vaultId: "b" },
    { serverName: "docs", credentialId: "d1", vaultId: "a" },
  ];
  assert.deepEqual(keptPicks(picks, ["a"]), [picks[1]]);
  assert.deepEqual(selectionsOf(picks), [
    { serverName: "billing", credentialId: "b2" },
    { serverName: "docs", credentialId: "d1" },
  ]);
});

test("reads an entry: an MCP server without a credential warns, a failing call is an error", () => {
  const covered = entry({ status: "covered" });
  const publicServer = entry({});
  const httpTool = entry({ kind: "http", name: "refund_order", serverName: "billing", required: true, agentId: "researcher" });
  const stage = entry({ kind: "http", name: "open_pr", serverName: "github", required: true, stage: "open_pr" });
  const ambiguous = entry({ status: "ambiguous" });
  assert.deepEqual(
    [covered, publicServer, httpTool, ambiguous].map((item) => [coverageTone(item), coverageStatusLabel(item)]),
    [
      ["ok", "Covered"],
      ["warn", "No credential"],
      ["error", "Missing"],
      ["error", "Pick one"],
    ],
  );
  assert.equal(coverageEntryLabel(publicServer), "MCP server tickets");
  assert.equal(coverageEntryLabel(httpTool), "HTTP tool refund_order · researcher");
  assert.equal(coverageEntryLabel(stage), "HTTP stage open_pr");
  assert.deepEqual(
    coverageCounts({ agentId: "x", vaultIds: [], complete: false, entries: [covered, publicServer, httpTool, ambiguous] }),
    { covered: 1, warn: 1, error: 2 },
  );
});

test("a new session's state carries its vaults and picks, and reads them back", () => {
  assert.deepEqual(newSessionState(), NEW_SESSION);
  const state = newSessionState({
    vaultIds: ["a", "b"],
    credentialSelections: [{ serverName: "billing", credentialId: "b2" }],
  });
  assert.deepEqual(state, {
    newSession: true,
    vaultIds: ["a", "b"],
    credentialSelections: [{ serverName: "billing", credentialId: "b2" }],
  });
  assert.deepEqual(newSessionCredentials(state), {
    vaultIds: ["a", "b"],
    credentialSelections: [{ serverName: "billing", credentialId: "b2" }],
  });
  // Only Studio's own "New session" attaches vaults; anything malformed is dropped.
  assert.deepEqual(newSessionCredentials({ vaultIds: ["a"] }), {});
  assert.deepEqual(
    newSessionCredentials({ newSession: true, vaultIds: ["a", 7, ""], credentialSelections: [{ serverName: "x" }] }),
    { vaultIds: ["a"] },
  );
});
