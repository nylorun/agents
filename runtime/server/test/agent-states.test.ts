/**
 * An Agent's state (protocol 16), derived when it is read: paused, failing, input_required,
 * working, sleeping, the first that holds, with `attention` naming every state that holds and the
 * session behind it.
 */
import { describe, expect, it } from "vitest";
import { stateOf } from "../src/tenant/agents.js";
import type { SandboxPodState } from "../src/store/types.js";

const on = { desiredState: "on" as const };
const pod = (observed: SandboxPodState["observed"], reason?: string): SandboxPodState => ({
  k8sName: "sbx",
  volumeGen: 0,
  desired: "running",
  observed,
  hostEpoch: 0,
  rev: 1,
  ...(reason ? { reason } : {}),
});

describe("stateOf", () => {
  it("sleeps with nothing to do", () => {
    expect(stateOf(on, [])).toEqual({ state: "sleeping", attention: [] });
    expect(stateOf(on, [{ id: "a", status: "idle" }, { id: "b", status: "completed" }]).state).toBe("sleeping");
  });

  it("works while a turn runs", () => {
    for (const status of ["running", "runnable", "waiting"])
      expect(stateOf(on, [{ id: "a", status }])).toEqual({
        state: "working",
        attention: [{ state: "working", sessionId: "a", reason: status }],
      });
  });

  it("needs a person while a session waits on one, even beside a working session (D66)", () => {
    const found = stateOf(on, [
      { id: "busy", status: "running" },
      { id: "held", status: "paused" },
    ]);
    expect(found.state).toBe("input_required");
    expect(found.attention).toEqual([
      { state: "input_required", sessionId: "held", reason: "paused" },
      { state: "working", sessionId: "busy", reason: "running" },
    ]);
    expect(stateOf(on, [{ id: "u", status: "uncertain" }]).state).toBe("input_required");
  });

  it("fails when its compute failed or was lost, or a session's last turn failed, above waiting work", () => {
    expect(stateOf({ ...on, pod: pod("lost", "volume gone") }, [{ id: "held", status: "paused" }])).toEqual({
      state: "failing",
      attention: [
        { state: "failing", reason: "compute lost: volume gone" },
        { state: "input_required", sessionId: "held", reason: "paused" },
      ],
    });
    expect(stateOf({ ...on, pod: pod("failed") }, []).state).toBe("failing");
    expect(stateOf({ ...on, pod: pod("running") }, []).state).toBe("sleeping");
    expect(stateOf(on, [{ id: "f", status: "failed" }]).state).toBe("failing");
  });

  it("fails while a crash an idle suspend found stands, until a turn starts the pod", () => {
    const crashed = { ...pod("suspended", "Crashed: worker pod went away. What the Agent wrote since its last suspend is lost; its next turn starts it from that suspend."), desired: "suspended" as const };
    const view = stateOf({ ...on, pod: crashed }, []);
    expect(view.state).toBe("failing");
    expect(view.attention).toEqual([{ state: "failing", reason: `compute crashed: ${crashed.reason}` }]);
    expect(stateOf({ ...on, pod: { ...crashed, reason: undefined } }, []).state).toBe("sleeping");
    expect(stateOf({ ...on, pod: { ...crashed, desired: "deleted" } }, []).attention).toEqual([]);
  });

  it("needs a person while a required secret of the version it runs is unset, each named", () => {
    expect(stateOf(on, [{ id: "busy", status: "running" }], ["ORDERS_TOKEN", "SHOP_KEY"])).toEqual({
      state: "input_required",
      attention: [
        { state: "input_required", reason: "secret_unset: required secret ORDERS_TOKEN unset" },
        { state: "input_required", reason: "secret_unset: required secret SHOP_KEY unset" },
        { state: "working", sessionId: "busy", reason: "running" },
      ],
    });
    expect(stateOf({ ...on, pod: pod("lost") }, [], ["ORDERS_TOKEN"]).state).toBe("failing");
  });

  it("is paused when its desired state is off, above everything", () => {
    expect(stateOf({ desiredState: "off", pod: pod("lost") }, [{ id: "f", status: "failed" }]).state).toBe("paused");
  });
});
