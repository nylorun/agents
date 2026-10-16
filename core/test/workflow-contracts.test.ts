import { expect, it } from "vitest";
import { harnessSectionOf, loopManifestOf } from "../src/define.js";
import {
  MessageEventBodySchema,
  AgentManifestV8Schema,
  DefinitionDocumentSchema,
  PutSessionRequestSchema,
  WorkflowManifestSchema,
} from "../src/contracts.js";

const coder = { manifestSchemaVersion: 7 as const, id: "coder" };
const shipFeature = {
  kind: "workflow" as const,
  workflowSchemaVersion: 3 as const,
  id: "ship-feature",
  root: {
    chain: [
      { agent: "planner" },
      {
        map: {
          each: { loop: { run: { agent: "coder" }, verify: { agent: "tester" }, max: 3 } },
        },
        id: "implement",
      },
      { tool: { name: "open-pr", inputSchema: { type: "array" } } },
    ],
  },
  agents: {
    planner: { ...coder, id: "planner" },
    coder,
    tester: { ...coder, id: "tester" },
  },
};
const issues = (value: unknown) =>
  WorkflowManifestSchema.safeParse(value).error?.issues.map((issue) => issue.message) ?? [];

it("accepts a workflow manifest v3", () => {
  expect(WorkflowManifestSchema.safeParse(shipFeature).success).toBe(true);
});

it("rejects a workflow document without kind workflow", () => {
  const { kind: _, ...rest } = shipFeature;
  expect(WorkflowManifestSchema.safeParse(rest).success).toBe(false);
});

it("refuses v1 and v2 workflow manifests with what changed", () => {
  for (const version of [1, 2])
    expect(issues({ ...shipFeature, workflowSchemaVersion: version })).toContain(
      `workflowSchemaVersion ${version} is no longer supported: flows run no code since manifest v5 (no input, on, verify or decide functions). Rebuild the flow with the current SDK (see MIGRATION.md)`
    );
  expect(issues({ ...shipFeature, workflowSchemaVersion: 9 })).toContain(
    "Unsupported workflowSchemaVersion 9"
  );
});

it("refuses function markers and a loop without max", () => {
  const withRoot = (root: unknown) => ({ ...shipFeature, root });
  expect(WorkflowManifestSchema.safeParse(withRoot({ agent: "coder", input: { fn: true } })).success).toBe(false);
  expect(
    WorkflowManifestSchema.safeParse(
      withRoot({ switch: { on: { fn: true }, cases: { a: { agent: "coder" } } } })
    ).success
  ).toBe(false);
  expect(
    WorkflowManifestSchema.safeParse(withRoot({ loop: { run: { agent: "coder" }, verify: { fn: true }, max: 2 } }))
      .success
  ).toBe(false);
  expect(
    WorkflowManifestSchema.safeParse(withRoot({ loop: { run: { agent: "coder" }, verify: { agent: "tester" } } }))
      .success
  ).toBe(false);
  expect(
    WorkflowManifestSchema.safeParse(
      withRoot({ loop: { run: { agent: "coder" }, verify: { agent: "tester" }, max: 2, decide: { fn: true } } })
    ).success
  ).toBe(false);
});

it("checks that every agent the flow uses is embedded under its id", () => {
  expect(WorkflowManifestSchema.safeParse({ ...shipFeature, root: { agent: "nobody" } }).success).toBe(false);
  expect(
    WorkflowManifestSchema.safeParse({ ...shipFeature, agents: { ...shipFeature.agents, other: coder } }).success
  ).toBe(false);
});

it("saves a workflow as an agent manifest's harness section", () => {
  const parsed = AgentManifestV8Schema.parse({
    manifestSchemaVersion: 8,
    name: "ship-feature",
    harness: harnessSectionOf(shipFeature),
  });
  expect(parsed.harness).toMatchObject({ kind: "workflow" });
  expect(loopManifestOf(parsed)).toMatchObject({ kind: "workflow", id: "ship-feature" });
});

it("loop manifests stay agent manifest v7 or workflow manifest v3", () => {
  const parsed = DefinitionDocumentSchema.parse({ manifestSchemaVersion: 7, id: "coder" });
  expect(parsed).toMatchObject({ id: "coder" });
  expect(parsed).not.toHaveProperty("kind");
});

it("opens a session on an Agent, and refuses the protocol 15 and protocol 10 fields", () => {
  const base = { requestId: "r1", agent: "users/u1/coder", ownerUserId: "u1" };
  expect(PutSessionRequestSchema.parse(base).agent).toBe("users/u1/coder");
  for (const removed of [{ agentId: "coder" }, { environment: "users/u1/web" }, { sandbox: { id: "x" } }, { vaultIds: ["v"] }])
    expect(PutSessionRequestSchema.safeParse({ ...base, ...removed }).success).toBe(false);
  expect(PutSessionRequestSchema.safeParse({ ...base, agent: "/bad" }).success).toBe(false);
});

it("message is exactly one of content or data", () => {
  const base = { requestId: "r1", idempotencyKey: "k1", type: "message" as const };
  expect(MessageEventBodySchema.safeParse({ ...base, content: "hello" }).success).toBe(true);
  expect(MessageEventBodySchema.safeParse({ ...base, data: { task: "ship" } }).success).toBe(
    true
  );
  expect(MessageEventBodySchema.safeParse({ ...base }).success).toBe(false);
  expect(
    MessageEventBodySchema.safeParse({ ...base, content: "hello", data: { x: 1 } }).success
  ).toBe(false);
});

it("message may carry an optional agent manifest", () => {
  const manifest = {
    manifestSchemaVersion: 7 as const,
    id: "coder",
    instructions: ["Retry."],
  };
  const parsed = MessageEventBodySchema.parse({
    requestId: "r1",
    idempotencyKey: "k1",
    type: "message",
    content: "retry",
    manifest,
  });
  expect(parsed).toMatchObject({ content: "retry", manifest });
});
