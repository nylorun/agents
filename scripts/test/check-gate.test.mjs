import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHECK_GATE,
  describeCheckRun,
  githubCheckRuns,
  readCheckRun,
  waitForCheckRun,
} from "../release/check-gate.mjs";

const SHA = "268fa04bd0f03f29eac68cf0225f2b8b45f42d97";
const run = (status, conclusion, slug = "github-actions") => ({
  name: "ci",
  status,
  conclusion,
  app: { slug },
  details_url:
    slug === "github-actions" && conclusion !== "success"
      ? "https://github.com/nylorun/agents/actions/runs/1/job/2"
      : undefined,
});

/** A clock the gate only moves by pausing, so a ten-minute wait runs at once. */
function fakeClock() {
  let time = 0;
  let longest = 0;
  return {
    now: () => time,
    pause: async (ms) => {
      assert.ok(ms > 0, "the gate pauses for more than nothing");
      longest = Math.max(longest, ms);
      time += ms;
    },
    get elapsed() {
      return time;
    },
    get longest() {
      return longest;
    },
  };
}

test("the gate reads the check run the way publish.yml asks for it", () => {
  assert.deepEqual(readCheckRun([]), { state: "absent" });
  // Another app's check run is not CI, whatever it concluded.
  assert.deepEqual(readCheckRun([run("completed", "failure", "some-bot")]), {
    state: "absent",
  });
  assert.deepEqual(readCheckRun([run("queued", null)]), {
    state: "pending",
    status: "queued",
  });
  assert.deepEqual(readCheckRun([run("in_progress", null)]), {
    state: "pending",
    status: "in_progress",
  });
  assert.deepEqual(readCheckRun([run("completed", "success")]), {
    state: "completed",
    status: "completed",
    conclusion: "success",
    detailsUrl: null,
  });
  assert.match(describeCheckRun({ state: "absent" }), /no check run yet/);
});

test("the gate waits for a check run that registers a few reads later", async () => {
  const clock = fakeClock();
  let reads = 0;
  const result = await waitForCheckRun({
    name: "ci",
    sha: SHA,
    read: async () => (++reads < 6 ? [] : [run("completed", "success")]),
    now: clock.now,
    pause: clock.pause,
  });
  assert.equal(reads, 6);
  assert.equal(result.polls, 6);
  assert.equal(result.conclusion, "success");
  // 5s, 10s, 20s, 30s, then the backoff stays at its cap of 30s.
  assert.equal(result.waitedMs, 95_000);
  assert.equal(clock.elapsed, 95_000);
});

test("the gate waits while the check run is queued or in progress", async () => {
  const clock = fakeClock();
  const states = [
    run("queued", null),
    run("in_progress", null),
    run("in_progress", null),
  ];
  const result = await waitForCheckRun({
    name: "ci",
    sha: SHA,
    read: async () => (states.length > 0 ? [states.shift()] : [run("completed", "success")]),
    now: clock.now,
    pause: clock.pause,
  });
  assert.equal(result.polls, 4);
  assert.equal(clock.elapsed, 35_000);
});

test("the gate fails at its deadline, naming the check that never completed", async () => {
  const clock = fakeClock();
  const lines = [];
  await assert.rejects(
    waitForCheckRun({
      name: "ci",
      sha: SHA,
      read: async () => [run("in_progress", null)],
      windowMs: 60_000,
      now: clock.now,
      pause: clock.pause,
      log: (line) => lines.push(line),
    }),
    new RegExp(`ci on ${SHA}: still in_progress after 60s \\(5 reads\\)`),
  );
  // Bounded: it stops at the deadline, not a pause later, and never past the cap.
  assert.equal(clock.elapsed, 60_000);
  assert.ok(clock.longest <= CHECK_GATE.maxDelayMs);
  assert.ok(lines.length >= 4);
  assert.match(lines[0], /no check run yet|still in_progress/);
});

test("the gate fails at its deadline when no check run ever appears", async () => {
  const clock = fakeClock();
  await assert.rejects(
    waitForCheckRun({
      name: "ci",
      sha: SHA,
      read: async () => [],
      windowMs: 30_000,
      now: clock.now,
      pause: clock.pause,
    }),
    new RegExp(`ci on ${SHA}: no check run yet after 30s \\(4 reads\\)`),
  );
  assert.equal(clock.elapsed, 30_000);
});

test("a completed check that is not a pass fails at once instead of waiting", async () => {
  const clock = fakeClock();
  let reads = 0;
  await assert.rejects(
    waitForCheckRun({
      name: "ci",
      sha: SHA,
      read: async () => {
        reads++;
        return [run("completed", "failure")];
      },
      now: clock.now,
      pause: clock.pause,
    }),
    new RegExp(
      `ci on ${SHA} completed with failure; refusing to publish \\(https://`,
    ),
  );
  assert.equal(reads, 1);
  assert.equal(clock.elapsed, 0);
});

test("a failed check-run read is retried, and its reason reaches the deadline message", async () => {
  const clock = fakeClock();
  let reads = 0;
  const result = await waitForCheckRun({
    name: "ci",
    sha: SHA,
    read: async () => {
      if (++reads === 1) throw new Error("gh: HTTP 502\nsecond line");
      return [run("completed", "success")];
    },
    now: clock.now,
    pause: clock.pause,
  });
  assert.equal(reads, 2);
  assert.equal(clock.elapsed, 5_000);

  const lines = [];
  await assert.rejects(
    waitForCheckRun({
      name: "ci",
      sha: SHA,
      read: async () => {
        throw new Error("gh: HTTP 502\nsecond line");
      },
      windowMs: 10_000,
      now: clock.now,
      pause: clock.pause,
      log: (line) => lines.push(line),
    }),
    /the check-run read failed \(gh: HTTP 502\) after 10s/,
  );
});

test("the gate reads this commit's check runs with the query the step used", async () => {
  const calls = [];
  const withRun = (behaviour) => async (...args) => {
    calls.push(args);
    return behaviour();
  };
  const checkRuns = await githubCheckRuns({
    repository: "nylorun/agents",
    sha: SHA,
    name: "ci",
    run: withRun(() => ({ stdout: JSON.stringify({ check_runs: [run("completed", "success")] }) })),
  });
  assert.equal(checkRuns.length, 1);
  assert.deepEqual(calls[0][1], [
    "api",
    "--method",
    "GET",
    `repos/nylorun/agents/commits/${SHA}/check-runs`,
    "-f",
    "check_name=ci",
    "-f",
    "filter=latest",
  ]);
  await assert.rejects(
    githubCheckRuns({
      repository: "nylorun/agents",
      sha: SHA,
      name: "ci",
      run: withRun(() => {
        throw Object.assign(new Error("Command failed: gh api …"), {
          stderr: `No commit found for SHA: ${SHA} (HTTP 422)\n`,
        });
      }),
    }),
    /^Error: No commit found for SHA/,
  );
});

test("the wait stays well inside validate's own timeout", () => {
  assert.equal(CHECK_GATE.windowMs, 600_000);
  assert.ok(CHECK_GATE.windowMs < 45 * 60_000);
  assert.ok(CHECK_GATE.initialDelayMs <= CHECK_GATE.maxDelayMs);
});
