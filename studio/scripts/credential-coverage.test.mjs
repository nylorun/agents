import assert from "node:assert/strict";
import test from "node:test";
import {
  coverageCounts,
  coverageCredentialLabel,
  coverageEntryLabel,
  coverageStatusLabel,
  coverageTone,
  agentUnavailable,
} from "../web/src/credential-coverage.ts";

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
    credential: { agentId: "team/build", name: "tickets" },
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
    coverageCounts({ agentId: "x", complete: false, entries: [covered, publicServer, httpTool, stage] }),
    { covered: 1, warn: 1, error: 2 },
  );
});

test("names the secret a covered entry sends, and its gateway", () => {
  assert.equal(
    coverageCredentialLabel(entry({ status: "covered", credential: { agentId: "e", name: "tickets" } })),
    "tickets",
  );
  assert.equal(
    coverageCredentialLabel(
      entry({ status: "covered", credential: { agentId: "e", name: "gh", via: "https://gw.example/gh" } }),
    ),
    "gh via https://gw.example/gh",
  );
  assert.equal(coverageCredentialLabel(entry({})), undefined);
});

test("an Agent guarded for another owner cannot carry Studio's session", () => {
  assert.equal(agentUnavailable({ owner: null }, "local-developer"), undefined);
  assert.equal(agentUnavailable({ owner: "local-developer" }, "local-developer"), undefined);
  assert.match(agentUnavailable({ owner: "alice" }, "local-developer"), /alice/);
});
