import assert from "node:assert/strict";
import test from "node:test";
import {
  coverageCounts,
  coverageCredentialLabel,
  coverageEntryLabel,
  coverageStatusLabel,
  coverageTone,
  environmentUnavailable,
} from "../web/src/credential-coverage.ts";
import {
  NEW_SESSION,
  newSessionEnvironment,
  newSessionState,
  sessionEnvironmentId,
} from "../web/src/session-open.ts";

const entry = (fields) => ({
  kind: "mcp",
  name: fields.serverName ?? "tickets",
  serverName: "tickets",
  url: "https://mcp.tickets.example/mcp",
  required: false,
  status: "missing",
  message: "",
  ...fields,
});

test("reads an entry: an MCP server without a credential warns, a failing call is an error", () => {
  const covered = entry({
    status: "covered",
    credential: { environmentId: "team/build", name: "tickets" },
  });
  const publicServer = entry({});
  const httpTool = entry({ kind: "http", name: "refund_order", serverName: "billing", required: true, agentId: "researcher" });
  const stage = entry({ kind: "http", name: "open_pr", serverName: "github", required: true, stage: "open_pr" });
  assert.deepEqual(
    [covered, publicServer, httpTool].map((item) => [coverageTone(item), coverageStatusLabel(item)]),
    [
      ["ok", "Covered"],
      ["warn", "No credential"],
      ["error", "Missing"],
    ],
  );
  assert.equal(coverageEntryLabel(publicServer), "MCP server tickets");
  assert.equal(coverageEntryLabel(httpTool), "HTTP tool refund_order · researcher");
  assert.equal(coverageEntryLabel(stage), "HTTP stage open_pr");
  assert.deepEqual(
    coverageCounts({ agentId: "x", environmentId: null, complete: false, entries: [covered, publicServer, httpTool, stage] }),
    { covered: 1, warn: 1, error: 2 },
  );
});

test("names the secret a covered entry sends, and its gateway", () => {
  assert.equal(
    coverageCredentialLabel(entry({ status: "covered", credential: { environmentId: "e", name: "tickets" } })),
    "tickets",
  );
  assert.equal(
    coverageCredentialLabel(
      entry({ status: "covered", credential: { environmentId: "e", name: "gh", via: "https://gw.example/gh" } }),
    ),
    "gh via https://gw.example/gh",
  );
  assert.equal(coverageCredentialLabel(entry({})), undefined);
});

test("an Environment guarded for another owner cannot carry Studio's session", () => {
  assert.equal(environmentUnavailable({ ownerUserId: null }, "local-developer"), undefined);
  assert.equal(environmentUnavailable({ ownerUserId: "local-developer" }, "local-developer"), undefined);
  assert.match(environmentUnavailable({ ownerUserId: "alice" }, "local-developer"), /alice/);
});

test("a new session's state carries its Environment, and reads it back", () => {
  assert.deepEqual(newSessionState(), NEW_SESSION);
  assert.deepEqual(newSessionState({}), NEW_SESSION);
  const state = newSessionState({ environment: "team/build" });
  assert.deepEqual(state, { newSession: true, environment: "team/build" });
  assert.deepEqual(newSessionEnvironment(state), { environment: "team/build" });
  // Only Studio's own "New session" names an Environment; anything malformed is dropped.
  assert.deepEqual(newSessionEnvironment({ environment: "team/build" }), {});
  assert.deepEqual(newSessionEnvironment({ newSession: true, environment: 7 }), {});
  assert.deepEqual(newSessionEnvironment({ newSession: true, environment: "" }), {});
  // Protocol-10 state (vaults) carries nothing any more.
  assert.deepEqual(newSessionEnvironment({ newSession: true, vaultIds: ["v1"] }), {});
});

test("a session view names its Environment by id, or none", () => {
  assert.equal(sessionEnvironmentId({ environment: { id: "team/build", version: 2 } }), "team/build");
  assert.equal(sessionEnvironmentId({ environment: null }), undefined);
  assert.equal(sessionEnvironmentId({}), undefined);
  assert.equal(sessionEnvironmentId({ environment: { version: 1 } }), undefined);
});
