import { expect, it } from "vitest";
import {
  capabilityForSandbox,
  owningSandboxSessionId,
  sandboxSpecOf,
  sandboxSpecsEqual,
  sessionHasSandbox,
  type SessionSandboxRef,
} from "../src/sandbox/share.js";
import {
  SandboxRouteError,
  validateSandboxAttach,
} from "../src/core/sandbox-routes.js";

const agentManifest = (sandbox?: Record<string, unknown>) => ({
  schemaVersion: 4 as const,
  id: "bot",
  name: "Bot",
  capabilities: sandbox
    ? [{ id: "sandbox", type: "agent" as const, sandbox }]
    : [],
});

const workflowManifest = (sandbox?: Record<string, unknown>) => ({
  kind: "workflow" as const,
  workflowSchemaVersion: 3 as const,
  id: "flow",
  root: { agent: "bot" },
  agents: {},
  ...(sandbox ? { sandbox } : {}),
});

it("reads sandbox specs from agent capabilities and workflow manifests", () => {
  expect(sandboxSpecOf(agentManifest({ image: "node:22" }))).toEqual({
    image: "node:22",
  });
  expect(sandboxSpecOf(workflowManifest({ image: "node:22" }))).toEqual({
    image: "node:22",
  });
  expect(sandboxSpecOf(agentManifest())).toBeUndefined();
  expect(sandboxSpecsEqual({ image: "a" }, { image: "a" })).toBe(true);
  expect(sandboxSpecsEqual({ image: "a" }, { image: "b" })).toBe(false);
  expect(capabilityForSandbox({ image: "node:22" }).sandbox).toEqual({
    image: "node:22",
  });
});

it("keys the shared sandbox by the owning session", () => {
  const sessions = new Map<string, SessionSandboxRef>([
    [
      "workflow",
      {
        id: "workflow",
        ownerUserId: "ada",
        manifest: workflowManifest({ image: "node:22" }),
      },
    ],
    [
      "agent-a",
      {
        id: "agent-a",
        ownerUserId: "ada",
        manifest: agentManifest({ image: "node:22" }),
        sandboxOwnerId: "workflow",
      },
    ],
    [
      "agent-b",
      {
        id: "agent-b",
        ownerUserId: "ada",
        manifest: agentManifest({ image: "node:22" }),
        sandboxOwnerId: "agent-a",
      },
    ],
  ]);
  const lookup = (id: string) => sessions.get(id);
  expect(owningSandboxSessionId(sessions.get("workflow")!, lookup)).toBe(
    "workflow"
  );
  expect(owningSandboxSessionId(sessions.get("agent-a")!, lookup)).toBe(
    "workflow"
  );
  expect(owningSandboxSessionId(sessions.get("agent-b")!, lookup)).toBe(
    "workflow"
  );
  expect(sessionHasSandbox(sessions.get("agent-a")!, lookup)).toBe(true);
});

it("validates PutSession.sandbox: same owner and identical specs", () => {
  const owner: SessionSandboxRef = {
    id: "workflow",
    ownerUserId: "ada",
    manifest: workflowManifest({ image: "node:22", idle: "15m" }),
  };
  const lookup = (id: string) => (id === "workflow" ? owner : undefined);

  expect(
    validateSandboxAttach(
      { ownerUserId: "ada", sandbox: { session: "workflow" } },
      agentManifest({ image: "node:22", idle: "15m" }) as never,
      lookup
    )
  ).toBe("workflow");

  expect(() =>
    validateSandboxAttach(
      { ownerUserId: "bob", sandbox: { session: "workflow" } },
      agentManifest({ image: "node:22", idle: "15m" }) as never,
      lookup
    )
  ).toThrow(SandboxRouteError);

  expect(() =>
    validateSandboxAttach(
      { ownerUserId: "ada", sandbox: { session: "workflow" } },
      agentManifest({ image: "node:24" }) as never,
      lookup
    )
  ).toThrow(/identical/);

  expect(() =>
    validateSandboxAttach(
      { ownerUserId: "ada", sandbox: { session: "missing" } },
      agentManifest({ image: "node:22" }) as never,
      lookup
    )
  ).toThrow(/not found/);
});
