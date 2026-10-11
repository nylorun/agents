/** How results are printed: one JSON line per check, or a table a person reads. */
import type { CheckResult, ConformanceReport } from "./run.js";

/** One JSON line: `{id, ok, detail, section}`, with the status and class beside them. */
export const jsonLine = (result: CheckResult): string =>
  JSON.stringify({
    id: result.id,
    ok: result.ok,
    detail: result.detail,
    section: result.section,
    status: result.status,
    class: result.class,
    ms: result.ms,
  });

const MARK: Record<CheckResult["status"], string> = {
  pass: "pass",
  fail: "FAIL",
  skipped: "skip",
  "n/a": "n/a",
};

/** One row of the table. */
export const tableRow = (result: CheckResult): string =>
  `${result.id}  ${MARK[result.status].padEnd(4)}  ${result.class.padEnd(8)}  ${result.section.padEnd(11)}  ${result.title}\n${" ".repeat(
    6,
  )}${result.detail}`;

/** The closing line. */
export function summary(report: ConformanceReport): string {
  const count = (status: CheckResult["status"]) =>
    report.results.filter((result) => result.status === status).length;
  return `${report.harness} (${report.profile}): ${count("pass")} pass, ${count("fail")} fail, ${count("skipped")} skipped, ${count(
    "n/a",
  )} not applicable${report.ok ? "" : " — FAILED"}`;
}
