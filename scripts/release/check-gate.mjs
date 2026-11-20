#!/usr/bin/env node
/**
 * The gate `validate` of publish.yml runs before anything is built: the CI check
 * run that covers the release commit must be a pass. It reads the commit's
 * check runs and waits, for a bounded time, until the one it wants has
 * completed:
 *
 * - no check run of that name yet (the queue's `ci` can still be registering
 *   when the push-triggered workflow starts) reads again after a backoff;
 * - a run still `queued` or `in_progress` reads again after a backoff;
 * - a read that fails reads again after a backoff;
 * - a completed run ends the wait at once: `success` lets the release go on,
 *   any other conclusion fails, because a finished check cannot turn into a
 *   pass by waiting;
 * - the deadline (ten minutes, well inside the job's 45) fails the step with
 *   the state it last saw, so the message names what was still pending.
 *
 * The deploy and publish steps are not retried; only this read is.
 */
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

/** The wait, the backoff and the app whose check run counts as CI. */
export const CHECK_GATE = {
  windowMs: 600_000,
  initialDelayMs: 5_000,
  maxDelayMs: 30_000,
  app: "github-actions",
};

/**
 * The state of the check run the gate waits for, from the commit's check runs:
 * `{ state: "absent" }`, `{ state: "pending", status }` or
 * `{ state: "completed", status, conclusion, detailsUrl }`. Runs of another app
 * (a bot's, a third-party's) are ignored, as are runs of another name, because
 * the API is asked for that name only.
 */
export function readCheckRun(checkRuns, { app = CHECK_GATE.app } = {}) {
  const mine = (Array.isArray(checkRuns) ? checkRuns : []).filter(
    (checkRun) => checkRun?.app?.slug === app,
  );
  if (mine.length === 0) return { state: "absent" };
  // `filter=latest` returns one run per name; the last is the newest.
  const latest = mine[mine.length - 1];
  if (latest.status !== "completed" || !latest.conclusion)
    return { state: "pending", status: latest.status ?? null };
  return {
    state: "completed",
    status: latest.status,
    conclusion: latest.conclusion,
    detailsUrl: latest.details_url ?? null,
  };
}

/** What the last read saw, for the log line and the failure message. */
export function describeCheckRun(seen) {
  if (seen.state === "absent") return "no check run yet";
  if (seen.state === "unreadable") return `the check-run read failed (${seen.error})`;
  if (seen.state === "pending") return `still ${seen.status ?? "not completed"}`;
  return `completed with ${seen.conclusion}`;
}

const complaint = (error) => String(error?.message ?? error).split("\n")[0];

/**
 * Reads the check run until it completes or `windowMs` passes. `read` returns
 * the commit's check runs; `pause` and `now` are there so a test can run the
 * wait without waiting.
 */
export async function waitForCheckRun({
  read,
  name,
  sha,
  windowMs = CHECK_GATE.windowMs,
  initialDelayMs = CHECK_GATE.initialDelayMs,
  maxDelayMs = CHECK_GATE.maxDelayMs,
  pause = sleep,
  now = Date.now,
  log = () => {},
}) {
  const startedAt = now();
  const seconds = Math.round(windowMs / 1000);
  let delay = initialDelayMs;
  let polls = 0;
  let seen = { state: "absent" };
  for (;;) {
    polls += 1;
    try {
      seen = readCheckRun(await read());
    } catch (error) {
      seen = { state: "unreadable", error: complaint(error) };
    }
    if (seen.state === "completed") {
      if (seen.conclusion === "success")
        return {
          polls,
          waitedMs: now() - startedAt,
          status: seen.status,
          conclusion: seen.conclusion,
          detailsUrl: seen.detailsUrl,
        };
      throw new Error(
        `${name} on ${sha} completed with ${seen.conclusion}; refusing to publish` +
          (seen.detailsUrl ? ` (${seen.detailsUrl})` : ""),
      );
    }
    const waitedMs = now() - startedAt;
    const remainingMs = windowMs - waitedMs;
    if (remainingMs <= 0)
      throw new Error(
        `${name} on ${sha}: ${describeCheckRun(seen)} after ${seconds}s ` +
          `(${polls} ${polls === 1 ? "read" : "reads"}); it has not completed, so nothing was published. ` +
          `Rerun this workflow once that check has finished.`,
      );
    const waitMs = Math.min(delay, remainingMs);
    log(
      `${name} on ${sha}: ${describeCheckRun(seen)}; ${Math.round(waitedMs / 1000)}s of ${seconds}s, ` +
        `reading again in ${Math.round(waitMs / 1000)}s`,
    );
    await pause(waitMs);
    delay = Math.min(delay * 2, maxDelayMs);
  }
}

/**
 * The commit's check runs, as the gate reads them: the same `gh api` query the
 * step made inline before (`filter=latest` asks for the newest run of that
 * name). `gh` reads GH_TOKEN from the environment.
 */
export async function githubCheckRuns({
  repository,
  sha,
  name,
  run = promisify(execFile),
}) {
  const args = [
    "api",
    "--method",
    "GET",
    `repos/${repository}/commits/${sha}/check-runs`,
    "-f",
    `check_name=${name}`,
    "-f",
    "filter=latest",
  ];
  try {
    const { stdout } = await run("gh", args, {
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout).check_runs ?? [];
  } catch (error) {
    // `gh` prints the API's own message on stderr ("No commit found for SHA …
    // (HTTP 422)"), which names the cause without the command twice.
    const detail = String(error?.stderr ?? "")
      .trim()
      .split("\n")
      .pop();
    throw new Error(detail || complaint(error));
  }
}

async function main() {
  const name = process.env.CHECK;
  const sha = process.env.RELEASE_SHA;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!name || !repository || !/^[a-f0-9]{40}$/u.test(sha ?? "")) {
    console.error(
      "check-gate: CHECK, GITHUB_REPOSITORY and a 40-character RELEASE_SHA are required.",
    );
    process.exitCode = 2;
    return;
  }
  const result = await waitForCheckRun({
    name,
    sha,
    read: () => githubCheckRuns({ repository, sha, name }),
    log: (line) => console.log(line),
  });
  console.log(
    `${name} on ${sha}: ${result.conclusion} after ${Math.round(result.waitedMs / 1000)}s ` +
      `(${result.polls} ${result.polls === 1 ? "read" : "reads"})`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch((error) => {
    console.error(`::error::${complaint(error)}`);
    process.exitCode = 1;
  });
