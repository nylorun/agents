import { expect, it } from "vitest";
import {
  assertLoopIteration,
  assertMapItemCount,
  FLOW_LIMIT_DEFAULTS,
  FlowLimitError,
  mayDispatchMore,
  resolveFlowLimits,
} from "../../src/core/limits.js";

it("WF-L1/L2/L3: resolveFlowLimits defaults and RuntimeOptions.flow overrides", () => {
  expect(resolveFlowLimits()).toEqual(FLOW_LIMIT_DEFAULTS);
  expect(
    resolveFlowLimits({
      flow: { maxConcurrency: 2, maxMapItems: 10, maxLoopIterations: 5 },
    })
  ).toEqual({
    maxConcurrency: 2,
    maxMapItems: 10,
    maxLoopIterations: 5,
  });
});

it("WF-L1/L2/L3: NYLORUN_FLOW_* env vars apply when flow overrides are absent", () => {
  expect(
    resolveFlowLimits({
      env: {
        NYLORUN_FLOW_MAX_CONCURRENCY: "3",
        NYLORUN_FLOW_MAX_MAP_ITEMS: "50",
        NYLORUN_FLOW_MAX_LOOP_ITERATIONS: "7",
      },
    })
  ).toEqual({
    maxConcurrency: 3,
    maxMapItems: 50,
    maxLoopIterations: 7,
  });
});

it("WF-D10: flow overrides win over env", () => {
  expect(
    resolveFlowLimits({
      flow: { maxConcurrency: 1 },
      env: { NYLORUN_FLOW_MAX_CONCURRENCY: "99" },
    }).maxConcurrency
  ).toBe(1);
});

it("WF-L1: mayDispatchMore waits (not an error) at the ceiling", () => {
  expect(mayDispatchMore(7, { maxConcurrency: 8 })).toBe(true);
  expect(mayDispatchMore(8, { maxConcurrency: 8 })).toBe(false);
});

it("MAP-E2 / WF-E9: assertMapItemCount raises map.too-many-items", () => {
  expect(() =>
    assertMapItemCount(1001, { maxMapItems: 1000 }, "ship/implement")
  ).toThrow(FlowLimitError);
  try {
    assertMapItemCount(11, { maxMapItems: 10 }, "m");
  } catch (error) {
    expect(error).toMatchObject({
      code: "map.too-many-items",
      path: "m",
    });
  }
  expect(() => assertMapItemCount(10, { maxMapItems: 10 })).not.toThrow();
});

it("LOOP-A8 / WF-E13: assertLoopIteration raises loop.too-many-iterations", () => {
  expect(() =>
    assertLoopIteration(101, { maxLoopIterations: 100 }, "polish")
  ).toThrow(FlowLimitError);
  try {
    assertLoopIteration(6, { maxLoopIterations: 5 }, "loop");
  } catch (error) {
    expect(error).toMatchObject({
      code: "loop.too-many-iterations",
      path: "loop",
    });
  }
  expect(() =>
    assertLoopIteration(5, { maxLoopIterations: 5 })
  ).not.toThrow();
});

it("rejects non-positive limit values", () => {
  expect(() => resolveFlowLimits({ flow: { maxConcurrency: 0 } })).toThrow(
    /positive integer/
  );
  expect(() =>
    resolveFlowLimits({ env: { NYLORUN_FLOW_MAX_MAP_ITEMS: "-1" } })
  ).toThrow(/positive integer/);
});
