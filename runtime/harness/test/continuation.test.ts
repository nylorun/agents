import { runAgent } from "./run-agent.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent } from "@nylorun/core/define";
import { type ExecutionState } from "../src/index.js";

const make = (execute = vi.fn(async () => ({ kind: "deferred" as const, token: "job" }))) =>
  Agent({ id: "a", name: "A" })
    .use({
      id: "c",
      tools: [
        { name: "job", inputSchema: z.object({}), execute },
        {
          name: "done",
          inputSchema: z.object({}),
          execute: async () => ({ kind: "completed", output: "settled sibling" }),
        },
      ],
    })
    .build();
const pause = () =>
  runAgent(make(), {
    input: "go",
    onModelCall: async () => ({
      output: [
        { type: "tool-call", id: "c", name: "job", args: {} },
        { type: "tool-call", id: "done", name: "done", args: {} },
      ],
    }),
  });

it("continues in a separate Node process using only JSON and rebuilt definitions", async () => {
  const first = await pause();
  if (first.status !== "paused") throw new Error("Expected pause");
  const script = `import {Agent} from '@nylorun/core/define'; import {run,bindingFromAgent} from './dist/run/index.js'; import {z} from 'zod';
    const state = JSON.parse(process.argv[1]);
    const agent = Agent({id:'a',name:'A'}).use({id:'c',tools:['job','done'].map(name=>({name,inputSchema:z.object({}),execute:async()=>{throw new Error('must not redispatch')}}))}).build();
    const result = await run({binding:bindingFromAgent(agent),state,input:{kind:'settle',invocationId:state.plan.calls[0].invocationId,outcome:{kind:'completed',output:'done'}},onModelCall:async()=> 'restored'});
    process.stdout.write(JSON.stringify(result));`;
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    script,
    JSON.stringify(first.state),
  ]);
  expect(JSON.parse(stdout)).toMatchObject({ status: "completed", output: "restored" });
  expect(stdout).toContain("settled sibling");
});

it("restores an approval in a fresh process without redispatching its settled sibling", async () => {
  const agent = Agent({ id: "approval", name: "Approval" })
    .use({
      id: "tools",
      tools: ["approved", "done"].map((name) => ({
        name,
        inputSchema: z.object({}),
        execute: async () =>
          name === "approved"
            ? {
                kind: "interaction-required" as const,
                interaction: { kind: "approval" as const, prompt: "Proceed?" },
                token: { resource: "original" },
              }
            : { kind: "completed" as const, output: `original ${name}` },
      })),
    })
    .build();
  const first = await runAgent(agent, {
    input: "go",
    onModelCall: async () => ({
      output: ["approved", "done"].map((name) => ({
        type: "tool-call" as const,
        id: name,
        name,
        args: {},
      })),
    }),
  });
  expect(first.status).toBe("paused");
  if (first.status !== "paused") throw new Error("Expected pause");
  const script = `import {Agent} from '@nylorun/core/define'; import {run,bindingFromAgent} from './dist/run/index.js'; import {z} from 'zod';
    const state = JSON.parse(process.argv[1]);
    const agent = Agent({id:'approval',name:'Approval'}).use({id:'tools',tools:['approved','done'].map(name=>({name,inputSchema:z.object({}),execute:async(_, {info,resume})=>{if(name==='done')throw new Error('must not redispatch');if(resume.token.resource!=='original')throw new Error('lost original resource');return {kind:'completed',output:info.principal};}}))}).build();
    const call=state.plan.calls.find(call=>call.interaction);
    const result=await run({binding:bindingFromAgent(agent),state,input:{kind:'approve',interactionId:call.interaction.id,approved:true},info:{principal:'fresh authorization'},onModelCall:async()=> 'restored'});
    process.stdout.write(JSON.stringify(result));`;
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    script,
    JSON.stringify(first.state),
  ]);
  expect(JSON.parse(stdout)).toMatchObject({ status: "completed", output: "restored" });
  expect(stdout).toContain("original done");
  expect(stdout).toContain("fresh authorization");
  expect(stdout).not.toContain("original approved");
});

it.each(["arguments", "order", "reference", "active", "failed"])(
  "rejects corrupted %s before invoking dependencies",
  async (kind) => {
    const first = await pause();
    const state = JSON.parse(JSON.stringify(first.state));
    if (kind === "arguments") state.plan.calls[0].args = { injected: true };
    if (kind === "order") state.plan.order = [];
    if (kind === "reference") state.plan.calls[0].reference.toolName = "missing";
    if (kind === "active") state.plan.calls[0].status = "active";
    if (kind === "failed") state.status = "failed";
    const model = vi.fn(async () => "unexpected");
    await expect(
      runAgent(make(), {
        state: state as ExecutionState,
        input: {
          kind: "settle",
          invocationId: state.plan.calls[0].invocationId,
          outcome: { kind: "completed", output: "ok" },
        },
        onModelCall: model,
      }),
    ).rejects.toThrow();
    expect(model).not.toHaveBeenCalled();
  },
);

it("uses the registered executable snapshot even when the original object changes", async () => {
  const original = vi.fn(async () => ({ kind: "completed" as const, output: "original" }));
  const definition = { name: "t", inputSchema: z.object({}), execute: original };
  const agent = Agent({ id: "a", name: "A" })
    .use({ id: "c", tools: [definition] })
    .build();
  definition.execute = vi.fn(async () => ({ kind: "completed", output: "changed" }));
  let calls = 0;
  const result = await runAgent(agent, {
    input: "go",
    onModelCall: async () =>
      calls++ ? "done" : { output: [{ type: "tool-call", id: "c", name: "t", args: {} }] },
  });
  expect(result.status).toBe("completed");
  expect(original).toHaveBeenCalledOnce();
  expect(definition.execute).not.toHaveBeenCalled();
});

it("finishes all dispatched effects before rejecting a failed settlement recording", async () => {
  const settled: string[] = [];
  const agent = Agent({ id: "a", name: "A" })
    .use({
      id: "c",
      tools: ["fast", "slow"].map((name) => ({
        name,
        inputSchema: z.object({}),
        execute: async () => {
          if (name === "slow") await new Promise((resolve) => setTimeout(resolve, 5));
          settled.push(name);
          return { kind: "completed" as const, output: name };
        },
      })),
    })
    .build();
  const model = vi.fn(async () => ({
    output: ["fast", "slow"].map((name) => ({
      type: "tool-call" as const,
      id: name,
      name,
      args: {},
    })),
  }));
  await expect(
    runAgent(agent, {
      input: "go",
      onModelCall: model,
      record: (state) => {
        if (state.plan?.calls.every((call) => call.status === "settled"))
          throw new Error("commit failed");
      },
    }),
  ).rejects.toMatchObject({ code: "execution.record-failed" });
  expect(settled).toEqual(["fast", "slow"]);
  expect(model).toHaveBeenCalledOnce();
});
