import { describe, expect, it } from "vitest";
import { podWantsReconcile } from "../../src/tenant/sweep.js";
import type { SandboxPodState } from "../../src/store/types.js";

const MINUTE = 60_000;
const now = Date.parse("2026-11-15T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const running = { desired: "running", observed: "running", k8sName: "sbx-a-g0", rev: 1, hostEpoch: 1, lastActiveAt: ago(2 * MINUTE) } as unknown as SandboxPodState;
const row = (pod: SandboxPodState, updated = 2 * MINUTE) => ({ updatedAt: ago(updated), createdAt: ago(10 * MINUTE), pod });
const facts = (over: Partial<{ computer: boolean; hosting: boolean }> = {}) => ({
  now,
  staleMs: MINUTE,
  idleMs: 15 * MINUTE,
  computer: false,
  hosting: true,
  ...over,
});

describe("podWantsReconcile", () => {
  it("looks at a computer the Runtime wants running on every pass, whatever its row says", () => {
    expect(podWantsReconcile(row(running), facts({ computer: true, hosting: false }))).toBe(true);
    // A resumed computer whose row still reads suspended, and one whose row just moved.
    expect(podWantsReconcile(row({ ...running, observed: "suspended" } as SandboxPodState), facts({ computer: true }))).toBe(true);
    expect(podWantsReconcile(row(running, 10_000), facts({ computer: true }))).toBe(true);
    // One the Runtime wants suspended and that is: left alone.
    expect(podWantsReconcile(row({ ...running, desired: "suspended", observed: "suspended" } as SandboxPodState), facts({ computer: true }))).toBe(false);
  });

  it("leaves a running pod whose engine is connected, and a pod row that just moved", () => {
    expect(podWantsReconcile(row(running), facts({ computer: false, hosting: true }))).toBe(false);
    expect(podWantsReconcile(row(running, 10_000), facts({ computer: false, hosting: false }))).toBe(false);
  });

  it("looks at a running pod whose engine is not connected, and at unfinished changes", () => {
    expect(podWantsReconcile(row(running), facts({ hosting: false }))).toBe(true);
    expect(podWantsReconcile(row({ ...running, observed: "creating" } as SandboxPodState), facts())).toBe(true);
    expect(podWantsReconcile(row({ ...running, desired: "suspended" } as SandboxPodState), facts())).toBe(true);
  });

  it("looks at a pod running past its idle limit", () => {
    const idle = { ...running, lastActiveAt: ago(20 * MINUTE) } as SandboxPodState;
    expect(podWantsReconcile(row(idle), facts())).toBe(true);
  });
});
