import { expect, it } from "vitest";
import {
  createActionSandbox,
  definitionDeclaresSandbox,
} from "../src/sandbox/client.js";
import type { Transport } from "../src/http.js";

function fakeTransport(calls: unknown[]): Transport {
  return {
    json: async (path: string, method: string, body?: unknown) => {
      calls.push({ path, method, body });
      return { kind: "completed", output: { ok: true, path, body } };
    },
  } as unknown as Transport;
}

it("createActionSandbox posts claim-scoped tool calls for all six built-ins", async () => {
  const calls: unknown[] = [];
  const sandbox = createActionSandbox({
    transport: fakeTransport(calls),
    actionId: "act-1",
    claimId: "claim-1",
    generation: 2,
  });
  await sandbox.bash({ command: "echo hi" });
  await sandbox.write({ path: "a.txt", content: "x" });
  await sandbox.read({ path: "a.txt" });
  await sandbox.edit({
    path: "a.txt",
    old_string: "x",
    new_string: "y",
  });
  await sandbox.grep({ pattern: "y" });
  await sandbox.glob({ pattern: "*.txt" });

  expect(calls).toHaveLength(6);
  expect(calls[0]).toMatchObject({
    path: "/v1/actions/act-1/sandbox/bash",
    method: "POST",
    body: { claimId: "claim-1", generation: 2, command: "echo hi" },
  });
  expect(calls.map((c: any) => c.path.split("/").at(-1))).toEqual([
    "bash",
    "write",
    "read",
    "edit",
    "grep",
    "glob",
  ]);
});

it("definitionDeclaresSandbox detects agent and workflow sandboxes", () => {
  expect(
    definitionDeclaresSandbox({
      capabilities: [{ sandbox: { image: "node:22" } }],
    })
  ).toBe(true);
  expect(definitionDeclaresSandbox({ capabilities: [{}] })).toBe(false);
  expect(
    definitionDeclaresSandbox({ kind: "workflow", sandbox: { image: "node:22" } })
  ).toBe(true);
  expect(definitionDeclaresSandbox({ kind: "workflow" })).toBe(false);
});

it("createActionSandbox sends no claim for a delivery, whose token is the credential", async () => {
  const calls: unknown[] = [];
  const sandbox = createActionSandbox({
    transport: fakeTransport(calls),
    actionId: "act-1",
  });
  await sandbox.bash({ command: "echo hi" });
  expect(calls[0]).toEqual({
    path: "/v1/actions/act-1/sandbox/bash",
    method: "POST",
    body: { command: "echo hi" },
  });
});
