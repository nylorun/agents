/**
 * The trace projector (R7.2) over a change source in memory: batches, acknowledgement in commit
 * order after a post or a drop, and a turn's trace read once after a restart.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "@nylorun/core/contracts";
import type { ChangeHandlers, ChangeSource, CommittedTx } from "../../src/streams/relay/types.js";
import type { OtlpSpan } from "../../src/traces/map.js";
import { createTraceProjector } from "../../src/traces/projector.js";
import { SESSION, TENANT, message, row } from "./rows.js";

function memorySource() {
  let handlers: ChangeHandlers | undefined;
  const acknowledged: string[] = [];
  const source: ChangeSource = {
    start(h) {
      handlers = h;
      h.onActive({ fresh: false });
    },
    acknowledge: (lsn) => void acknowledged.push(lsn),
    reconciled: async () => {},
    stop: async () => {},
  };
  let lsn = 0;
  const commit = (...events: LiveEvent[]): string => {
    const tx: CommittedTx = {
      endLsn: `0/${(lsn += 1)}`,
      rows: events.map((body) => ({ tenantId: TENANT, sessionId: body.sessionId, seq: body.seq, generation: 0, body })),
    };
    handlers!.onTx(tx);
    return tx.endLsn;
  };
  return { source, acknowledged, commit, handlers: () => handlers! };
}

const end = (turnId: string) => row("turn.completed", { output: null, agentId: "a", durationMs: 10 }, { turnId });
const tool = (turnId: string, n: number) =>
  row("tool.completed", {
    callId: `c${n}`,
    invocationId: `i${n}`,
    effectId: `${turnId}:0:tool:i${n}`,
    toolName: "t",
    status: "completed",
    kind: "sandbox",
    durationMs: 1,
  }, { turnId });

function setup(options: { post?: (spans: readonly OtlpSpan[]) => Promise<"posted" | "dropped">; maxBatch?: number; maxDelayMs?: number } = {}) {
  const memory = memorySource();
  const batches: OtlpSpan[][] = [];
  const turnMessage = vi.fn(async (_sessionId: string, turnId: string) => ({ ...message(), turnId }) as LiveEvent);
  const projector = createTraceProjector({
    source: memory.source,
    post: async (spans) => {
      batches.push([...spans]);
      return options.post ? options.post(spans) : "posted";
    },
    key: async () => randomKey,
    turnMessage,
    content: new Set(),
    maxBatch: options.maxBatch ?? 512,
    maxDelayMs: options.maxDelayMs ?? 20,
  });
  projector.start();
  return { ...memory, projector, batches, turnMessage };
}
const randomKey = randomBytes(32);

describe("trace projector", () => {
  it("posts a turn's spans in one batch and acknowledges after the post", async () => {
    const t = setup();
    t.commit({ ...message(), turnId: "t1" } as LiveEvent);
    t.commit(tool("t1", 1));
    const last = t.commit(end("t1"));
    await t.projector.idle();
    expect(t.batches).toHaveLength(1);
    expect(t.batches[0]!.map((span) => span.name)).toEqual(["execute_tool t", "invoke_agent a"]);
    expect(t.acknowledged.at(-1)).toBe(last);
    // The turn's message was in the slot: no read.
    expect(t.turnMessage).not.toHaveBeenCalled();
  });

  it("posts at most maxBatch spans at once, in order", async () => {
    const t = setup({ maxBatch: 2 });
    for (let n = 0; n < 5; n += 1) t.commit(tool("t2", n));
    await t.projector.idle();
    expect(t.batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(t.acknowledged.at(-1)).toBe("0/5");
  });

  it("acknowledges a dropped batch too, so the slot never holds WAL for a dead collector", async () => {
    const t = setup({ post: async () => "dropped" });
    t.commit(tool("t3", 1));
    const last = t.commit(end("t3"));
    await t.projector.idle();
    expect(t.acknowledged.at(-1)).toBe(last);
  });

  it("acknowledges a transaction with no span without posting", async () => {
    const t = setup();
    const last = t.commit(row("environment.state", { state: "running", backend: "virtual" }, { turnId: null }));
    await t.projector.idle();
    expect(t.batches).toHaveLength(0);
    expect(t.acknowledged).toEqual([last]);
    // Caught up: a keepalive moves the slot on.
    expect(t.handlers().onKeepalive("0/99")).toBe("0/99");
  });

  it("reads a turn's message once when the slot starts mid turn", async () => {
    const t = setup();
    t.commit(tool("t4", 1));
    t.commit(tool("t4", 2));
    t.commit(end("t4"));
    await t.projector.idle();
    expect(t.turnMessage).toHaveBeenCalledTimes(1);
    expect(t.turnMessage).toHaveBeenCalledWith(SESSION, "t4");
    const traceIds = new Set(t.batches.flat().map((span) => span.traceId));
    expect(traceIds.size).toBe(1);
  });

  it("holds keepalives while spans wait, and drops what waits when the source is lost", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const t = setup({ post: async () => (await held, "posted") });
    t.commit(end("t5"));
    await vi.waitFor(() => expect(t.batches).toHaveLength(1));
    expect(t.handlers().onKeepalive("0/50")).toBeUndefined();
    t.handlers().onInactive(new Error("lost"));
    release();
    await t.projector.idle();
    // The source replays what was not acknowledged: nothing of the lost activation is.
    expect(t.acknowledged).toEqual([]);
  });
});
