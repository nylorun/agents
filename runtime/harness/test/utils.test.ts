import { describe, expect, it } from "vitest";
import { createId } from "../src/utils/ids.js";
import { createObservationSink, emitObserve } from "../src/loop/observe.js";

describe("portable utility primitives", () => {
  it("creates prefixed UUID v4 identifiers with Web Crypto", () => {
    expect(createId("session")).toMatch(
      /^session_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

describe("observer emission", () => {
  it("does not invoke an emit factory when no observer is provided", () => {
    let calls = 0;
    emitObserve(undefined, () => {
      calls += 1;
      return { type: "middleware.entered", turnId: "turn", stepId: "step", middlewareId: "mw" };
    });
    expect(calls).toBe(0);
  });

  it("invokes an emit factory once when an observer exists", () => {
    const types: string[] = [];
    let calls = 0;
    emitObserve(
      (event) => types.push(event.type),
      () => {
        calls += 1;
        return { type: "middleware.entered", turnId: "turn", stepId: "step", middlewareId: "mw" };
      },
    );
    expect(calls).toBe(1);
    expect(types).toEqual(["middleware.entered"]);
  });

  it("isolates observer failures and reports observation.failed", () => {
    const types: string[] = [];
    const sink = createObservationSink({
      listener: (event) => {
        types.push(event.type);
        if (event.type === "middleware.entered") throw new Error("observer failed");
      },
      executionId: () => "exec",
      runId: "run",
    });
    expect(() =>
      sink.emit({ type: "middleware.entered", turnId: "turn", stepId: "step", middlewareId: "mw" }),
    ).not.toThrow();
    expect(types).toEqual(["middleware.entered", "observation.failed"]);
  });
});
