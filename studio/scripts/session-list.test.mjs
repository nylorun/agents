import assert from "node:assert/strict";
import test from "node:test";
import { loadSessions, sortSessions } from "../web/src/session-list.ts";
import { fullTime, shortTime } from "../web/src/time-format.ts";

const row = (session, lastEventAt, createdAt = null) => ({ session, lastEventAt, createdAt });

test("sortSessions orders by last activity, falling back to when a session opened", () => {
  const sessions = [
    row("a", "2026-10-15T10:00:00.000Z"),
    row("b", null, "2026-10-15T12:00:00.000Z"),
    row("c", null, null),
    row("d", "2026-10-15T11:00:00.000Z"),
  ];
  assert.deepEqual(
    sortSessions(sessions, "newest").map((s) => s.session),
    ["b", "d", "a", "c"],
  );
  // A session with no time goes last in either order.
  assert.deepEqual(
    sortSessions(sessions, "oldest").map((s) => s.session),
    ["a", "d", "b", "c"],
  );
});

test("sortSessions breaks ties by id and leaves its input as it was", () => {
  const sessions = [row("z", "2026-10-15T10:00:00Z"), row("y", "2026-10-15T10:00:00Z"), row("x", null)];
  assert.deepEqual(sortSessions(sessions, "newest").map((s) => s.session), ["y", "z", "x"]);
  assert.deepEqual(sessions.map((s) => s.session), ["z", "y", "x"]);
});

test("loadSessions reads every page when the Runtime offers session reads", async () => {
  const cursors = [];
  const client = {
    hostFeatures: async () => ["session-reads"],
    sessions: {
      page: async ({ limit, cursor }) => {
        assert.equal(limit, 200);
        cursors.push(cursor);
        const item = (id) => ({
          id,
          agentId: "orders",
          ownerUserId: "u",
          status: "idle",
          activeTurnId: null,
          lastTurnId: null,
          environmentId: null,
          createdAt: "2026-10-15T10:00:00.000Z",
          lastEventAt: "2026-10-15T11:00:00.000Z",
        });
        return cursor === undefined
          ? { sessions: [item("s1")], nextCursor: "next" }
          : { sessions: [item("s2")], nextCursor: null };
      },
    },
    listSessions: async () => assert.fail("the plain list is not read"),
  };
  const sessions = await loadSessions(client);
  assert.deepEqual(cursors, [undefined, "next"]);
  assert.deepEqual(sessions[1], {
    session: "s2",
    agentId: "orders",
    ownerUserId: "u",
    status: "idle",
    createdAt: "2026-10-15T10:00:00.000Z",
    lastEventAt: "2026-10-15T11:00:00.000Z",
  });
});

test("loadSessions falls back to the plain list, with no times, without session reads", async () => {
  const client = {
    hostFeatures: async () => [],
    sessions: { page: async () => assert.fail("no pages without the feature") },
    listSessions: async () => ({
      sessions: [{ id: "s1", agentId: "orders", ownerUserId: "u", status: "idle", activeTurnId: null }],
    }),
  };
  assert.deepEqual(await loadSessions(client), [
    { session: "s1", agentId: "orders", ownerUserId: "u", status: "idle", createdAt: null, lastEventAt: null },
  ]);
});

test("shortTime shows the time today, the day this year, and the date before", () => {
  const now = new Date(2026, 9, 16, 15, 0);
  assert.equal(shortTime(new Date(2026, 9, 16, 9, 5).toISOString(), now), "09:05");
  assert.equal(shortTime(new Date(2026, 9, 15, 23, 59).toISOString(), now), "Oct 15, 23:59");
  assert.equal(shortTime(new Date(2025, 0, 2, 8, 0).toISOString(), now), "Jan 2, 2025");
  assert.equal(shortTime("not a time", now), "");
  assert.equal(fullTime(new Date(2026, 9, 16, 9, 5, 7).toISOString()), "2026-10-16 09:05:07");
});
