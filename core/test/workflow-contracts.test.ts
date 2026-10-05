import { expect, it } from "vitest";
import {
  MessageEventBodySchema,
  PutAgentRequestSchema,
  PutSessionRequestSchema,
  WorkflowManifestSchema,
} from "../src/contracts.js";

const coder = { manifestSchemaVersion: 5 as const, id: "coder", capabilities: [] };
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

it("registers a workflow through PutAgentRequest", () => {
  const parsed = PutAgentRequestSchema.parse({
    requestId: "r1",
    manifest: shipFeature,
    implementationVersion: "dev",
  });
  expect(parsed.manifest).toMatchObject({ kind: "workflow", id: "ship-feature" });
});

it("still registers an agent document without kind", () => {
  const parsed = PutAgentRequestSchema.parse({
    requestId: "r1",
    manifest: {
      manifestSchemaVersion: 5,
      id: "coder",
      capabilities: [],
    },
    implementationVersion: "dev",
  });
  expect(parsed.manifest).toMatchObject({ id: "coder" });
  expect(parsed.manifest).not.toHaveProperty("kind");
});

it("accepts PutSession.sandbox", () => {
  const parsed = PutSessionRequestSchema.parse({
    requestId: "r1",
    agentId: "coder",
    ownerUserId: "u1",
    sandbox: { session: "workflow-session" },
  });
  expect(parsed.sandbox).toEqual({ session: "workflow-session" });
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
    manifestSchemaVersion: 5 as const,
    id: "coder",
    capabilities: [],
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
