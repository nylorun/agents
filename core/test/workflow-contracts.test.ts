import { expect, it } from "vitest";
import {
  ActionSchema,
  MessageEventBodySchema,
  PutAgentRequestSchema,
  PutSessionRequestSchema,
  WorkflowManifestSchema,
} from "../src/contracts.js";

const shipFeature = {
  kind: "workflow" as const,
  workflowSchemaVersion: 1 as const,
  id: "ship-feature",
  root: {
    chain: {
      id: "ship-feature",
      steps: [
        { agent: "planner" },
        {
          map: {
            id: "implement",
            over: { fn: true as const },
            each: {
              loop: {
                id: "code",
                run: { agent: "coder" },
                verify: { fn: true as const },
                decide: { fn: true as const },
              },
            },
          },
        },
        { tool: { name: "open-pr", inputSchema: { type: "array" } } },
      ],
    },
  },
  sandbox: { image: "node:22" },
};

it("accepts the design workflow manifest example", () => {
  expect(WorkflowManifestSchema.safeParse(shipFeature).success).toBe(true);
});

it("rejects a workflow document without kind workflow", () => {
  const { kind: _, ...rest } = shipFeature;
  expect(WorkflowManifestSchema.safeParse(rest).success).toBe(false);
});

it("accepts a slot-wrapped node in the tree", () => {
  const withSlot = {
    ...shipFeature,
    root: {
      slot: {
        id: "draft",
        input: { fn: true as const },
        run: { agent: "writer" },
      },
    },
  };
  expect(WorkflowManifestSchema.safeParse(withSlot).success).toBe(true);
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

const actionBase = {
  actionId: "a1",
  sessionId: "s1",
  turnId: "t1",
  agentId: "ship-feature",
  manifestHash: "hash",
  implementationVersion: "dev",
  input: {},
  context: {},
  status: "pending" as const,
  generation: 0,
};

it("ActionSchema accepts agent tools, workflow tools, fn and verify", () => {
  expect(
    ActionSchema.safeParse({
      ...actionBase,
      kind: "tool",
      capabilityId: "agent",
      toolName: "search",
    }).success
  ).toBe(true);
  expect(
    ActionSchema.safeParse({
      ...actionBase,
      kind: "tool",
      path: "ship-feature/open-pr",
      key: "ship-feature/open-pr",
    }).success
  ).toBe(true);
  expect(
    ActionSchema.safeParse({
      ...actionBase,
      kind: "fn",
      path: "ship-feature/implement",
      key: "ship-feature/implement",
    }).success
  ).toBe(true);
  expect(
    ActionSchema.safeParse({
      ...actionBase,
      kind: "verify",
      path: "ship-feature/implement/code",
      key: "ship-feature/implement/code",
    }).success
  ).toBe(true);
  expect(
    ActionSchema.safeParse({
      ...actionBase,
      kind: "tool",
    }).success
  ).toBe(false);
});
