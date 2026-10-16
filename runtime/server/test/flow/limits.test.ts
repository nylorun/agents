import { expect, it } from "vitest";
import { RUNTIME_LIMIT_DEFAULTS, runtimeLimitsOf } from "@nylorun/core/contracts";
import { flowLimitsOf, mayDispatchMore } from "../../src/core/limits.js";

it("WF-L1/L2/L3: the flow limits are Runtime limits, with today's defaults", () => {
  expect(RUNTIME_LIMIT_DEFAULTS).toMatchObject({ flowConcurrency: 8, flowMapItems: 1000, flowLoopIterations: 100 });
  expect(flowLimitsOf(RUNTIME_LIMIT_DEFAULTS)).toEqual({ maxMapItems: 1000, maxLoopIterations: 100 });
  // A Tenant's setting reaches the flow engine's `turn.start`.
  expect(flowLimitsOf(runtimeLimitsOf({ flowMapItems: 10, flowLoopIterations: 5 }))).toEqual({
    maxMapItems: 10,
    maxLoopIterations: 5,
  });
});

it("WF-L1: mayDispatchMore waits (not an error) at flowConcurrency", () => {
  expect(mayDispatchMore(7, { flowConcurrency: 8 })).toBe(true);
  expect(mayDispatchMore(8, { flowConcurrency: 8 })).toBe(false);
  expect(mayDispatchMore(1, runtimeLimitsOf({ flowConcurrency: 1 }))).toBe(false);
});
