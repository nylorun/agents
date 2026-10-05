/**
 * HTTP in flows: an `http()` tool is a flow stage the Runtime runs through its Tool Gate, and
 * `http({ url })` is a Loop's HTTP verifier. Both are data in workflow manifest v3; nothing
 * is bound locally for them.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  AgentBuildError,
  VerdictSchema,
  WorkflowBuildError,
  flow,
  flowHttpTarget,
  http,
  isHttpTarget,
  tool,
} from "../src/define.js";
import { WorkflowManifestSchema } from "../src/contracts.js";
import { HarnessError } from "../src/errors.js";

const planner = Agent({ id: "planner" })
  .instructions("Plan.")
  .output(z.object({ orderId: z.string() }));
const lister = Agent({ id: "lister" })
  .instructions("List.")
  .output(z.object({ items: z.array(z.object({ orderId: z.string() })) }));
const chatty = Agent({ id: "chatty" }).instructions("Talk.");
const fixer = Agent({ id: "fixer" }).instructions("Fix.");
const judge = Agent({ id: "judge" }).instructions("Judge.").output(VerdictSchema);

const refund = http({
  name: "refund",
  description: "Refund an order.",
  input: z.object({ orderId: z.string() }),
  output: z.object({ refundId: z.string() }),
  url: "https://billing.example.com/refunds",
  method: "PUT",
  credential: "billing",
  timeoutMs: 5_000,
});
const checker = http({ url: "https://checks.example.com/verify", credential: "checks" });

const codesOf = (build: () => unknown): string[] => {
  try {
    build();
  } catch (error) {
    if (error instanceof AgentBuildError || error instanceof WorkflowBuildError)
      return error.diagnostics.map((d) => `${d.code}: ${d.message}`);
    throw error;
  }
  return [];
};
const issues = (value: unknown) => {
  const parsed = WorkflowManifestSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe("an HTTP stage", () => {
  it("compiles to a tool node carrying its http target, with nothing bound", () => {
    const desk = Agent({ id: "desk" }).pipe(planner, refund).build();
    expect(desk.manifest.root).toEqual({
      chain: [
        { agent: "planner" },
        {
          tool: {
            name: "refund",
            description: "Refund an order.",
            inputSchema: expect.objectContaining({ type: "object", required: ["orderId"] }),
            outputSchema: expect.objectContaining({ type: "object", required: ["refundId"] }),
            http: {
              url: "https://billing.example.com/refunds",
              method: "PUT",
              credential: "billing",
              timeoutMs: 5_000,
            },
          },
        },
      ],
    });
    expect(desk.getBinding().nodes).toEqual({});
    expect(WorkflowManifestSchema.parse(desk.manifest)).toEqual(desk.manifest);
    expect(flowHttpTarget(desk.manifest, "refund")).toEqual({
      http: { url: "https://billing.example.com/refunds", method: "PUT", credential: "billing", timeoutMs: 5_000 },
      outputSchema: expect.objectContaining({ type: "object" }),
      verify: false,
    });
  });

  it("may be a switch case, a map item and a loop body", () => {
    const routed = Agent({ id: "routed" })
      .pipe(Agent({ id: "router" }).instructions("Route.").output(z.object({ route: z.string(), orderId: z.string() })))
      .switch({ refund, default: chatty })
      .build();
    expect(routed.manifest.root).toMatchObject({ chain: [{}, { switch: { cases: { refund: { tool: { name: "refund" } } } } }] });

    const mapped = Agent({ id: "mapped" }).pipe(lister).map(refund).build();
    expect(mapped.manifest.root).toMatchObject({ chain: [{}, { map: { each: { tool: { http: {} } } } }] });

    const polled = Agent({ id: "polled" }).pipe(planner).loop(refund, { verify: checker, max: 3 }).build();
    expect(polled.manifest.root).toMatchObject({
      chain: [{}, { loop: { run: { tool: { name: "refund" } }, verify: { http: { url: "https://checks.example.com/verify" } }, max: 3 } }],
    });
  });

  it("is found by its stage key inside a nested flow agent", () => {
    const inner = Agent({ id: "inner" }).pipe(planner, flow().pipe(refund).withId("pay"));
    const outer = Agent({ id: "outer" }).pipe(inner).build();
    expect(flowHttpTarget(outer.manifest, "inner/pay")?.http.url).toBe("https://billing.example.com/refunds");
    expect(flowHttpTarget(outer.manifest, "pay")).toBeUndefined();
  });

  it("is refused when the stage before it is known to return the wrong type", () => {
    expect(codesOf(() => Agent({ id: "d" }).pipe(chatty, refund).build())).toEqual([
      "flow.input-mismatch: HTTP stage 'refund' takes an object (its input schema), but agent 'chatty' returns text: give 'chatty' an .output() schema",
    ]);
    expect(codesOf(() => Agent({ id: "d" }).pipe(lister).map(refund).pipe(flow().pipe(refund).withId("again")).build())).toEqual([
      "flow.input-mismatch: HTTP stage 'refund' takes an object (its input schema), but the Map before it returns a list",
    ]);
    expect(
      codesOf(() => Agent({ id: "d" }).input(z.string()).pipe(refund).build())
    ).toEqual(["flow.input-mismatch: HTTP stage 'refund' takes an object (its input schema), but the flow's input schema returns text"]);
    // Unknown at build time: checked when the stage runs.
    expect(codesOf(() => Agent({ id: "d" }).pipe(planner, refund).build())).toEqual([]);
    expect(codesOf(() => Agent({ id: "d" }).pipe(refund).build())).toEqual([]);
  });

  it("refuses approval for now", () => {
    const approved = http({ name: "approved", input: z.object({}), url: "https://example.com/x", approval: "always" });
    expect(codesOf(() => Agent({ id: "d" }).pipe(approved).build())).toEqual([
      "flow.approval-unsupported: HTTP stage 'approved': approval on a flow stage is not supported yet",
    ]);
    expect(
      issues({
        kind: "workflow",
        workflowSchemaVersion: 3,
        id: "d",
        root: { tool: { name: "x", http: { url: "https://example.com/x" }, approval: "always" } },
        agents: {},
      })
    ).toHaveLength(1);
  });

  it("is refused in the manifest with a bad target", () => {
    const at = (http: unknown) => ({
      kind: "workflow",
      workflowSchemaVersion: 3,
      id: "d",
      root: { tool: { name: "x", http } },
      agents: {},
    });
    expect(issues(at({ url: "https://example.com/x", method: "PATCH" }))).toEqual([]);
    expect(issues(at({ url: "/x" }))).toHaveLength(1);
    expect(issues(at({ url: "https://example.com/x", method: "GET" }))).toHaveLength(1);
  });

  it("leaves code tool stages bound as before", () => {
    const local = tool({ name: "local", input: z.object({}), async run() { return 1; } });
    const desk = Agent({ id: "desk" }).pipe(planner, refund, local).build();
    expect(Object.keys(desk.getBinding().nodes)).toEqual(["local"]);
    const json = JSON.parse(JSON.stringify(desk.manifest));
    expect(Agent.from(json, { nodes: { local } }).manifest).toEqual(desk.manifest);
    expect(() => Agent.from(json, { nodes: { local, refund } })).toThrow(/no tool node refund/);
  });
});

describe("an HTTP verifier", () => {
  it("is a bare http() target, and its manifest form is itself", () => {
    expect(isHttpTarget(checker)).toBe(true);
    expect(JSON.parse(JSON.stringify(checker))).toEqual({
      http: { url: "https://checks.example.com/verify", credential: "checks" },
    });
    const desk = Agent({ id: "desk" }).loop(fixer, { verify: checker, max: 2 }).build();
    expect(desk.manifest.root).toEqual({
      chain: [
        {
          loop: {
            run: { agent: "fixer" },
            verify: { http: { url: "https://checks.example.com/verify", credential: "checks" } },
            max: 2,
          },
        },
      ],
    });
    expect(Object.keys(desk.manifest.agents)).toEqual(["fixer"]);
    expect(flowHttpTarget(desk.manifest, "@0.verify")).toEqual({
      http: { url: "https://checks.example.com/verify", credential: "checks" },
      verify: true,
    });
  });

  it("refuses a bad target when it is built", () => {
    expect(() => http({ url: "ftp://example.com" })).toThrow(HarnessError);
    expect(() => http({ url: "https://example.com", timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => http({ url: "https://example.com", approval: "always" } as never)).toThrow(/unknown option approval/);
    expect(() => http({ name: "x", url: "https://example.com" } as never)).toThrow(/input is required/);
  });

  it("is not a stage, and an HTTP tool is not a verifier", () => {
    expect(codesOf(() => Agent({ id: "d" }).pipe(checker).build())).toEqual([
      expect.stringMatching(/^workflow\.invalid-runnable: http\(\{ url \}\) without a name and an input is a Loop verifier/),
    ]);
    expect(codesOf(() => Agent({ id: "d" }).loop(fixer, { verify: refund, max: 2 }).build())).toEqual([
      "loop.invalid-verify: Loop 'loop' verify takes an HTTP verifier, http({ url }) with no name or input, not an HTTP tool",
    ]);
  });

  it("reserves fn and command verify targets", () => {
    for (const verify of [{ fn: "check" }, { command: ["check"] }])
      expect(() => Agent({ id: "d" }).loop(fixer, { verify, max: 2 })).toThrow(/Functions are not available yet/);
    const at = (verify: unknown) => ({
      kind: "workflow",
      workflowSchemaVersion: 3,
      id: "d",
      root: { loop: { run: { agent: "fixer" }, verify, max: 2 } },
      agents: { fixer: fixer.build().manifest },
    });
    expect(issues(at({ fn: "check" }))).toEqual(["Functions are not available yet"]);
    expect(issues(at({ command: ["check"] }))).toEqual(["Functions are not available yet"]);
    expect(issues(at({ http: { url: "https://example.com/v" } }))).toEqual([]);
    expect(issues(at({ agent: "fixer", http: { url: "https://example.com/v" } }))).toHaveLength(1);
    expect(issues(at({}))).toHaveLength(1);
    expect(issues(at({ http: { url: "https://example.com/v" }, id: "v" }))).toEqual(["An HTTP verifier takes no id"]);
  });

  it("works beside a verifier agent elsewhere in the same flow", () => {
    const desk = Agent({ id: "desk" })
      .loop(fixer, { verify: judge, max: 2, id: "fix" })
      .loop(flow().pipe(planner, refund), { verify: checker, max: 2, id: "pay" })
      .build();
    expect(WorkflowManifestSchema.parse(desk.manifest)).toEqual(desk.manifest);
    expect(flowHttpTarget(desk.manifest, "@1.verify")?.verify).toBe(true);
  });
});
