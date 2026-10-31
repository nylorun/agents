#!/usr/bin/env node
/**
 * Reads the A2A TCK's JUnit report and fails only on failures the known-failures list does not
 * name (A2A-E18):
 *
 *   node runtime/server/test/a2a/tck/compare.mjs <junitreport.xml> <tck-known-failures.txt>
 *
 * A failure is a test case with a <failure> or <error>, named `<classname>::<name>`. The list
 * holds one such name per line; `#` starts a comment. A listed case that now passes is reported,
 * so the list can shrink, but does not fail the run. Writes a Markdown summary to
 * GITHUB_STEP_SUMMARY when it is set.
 */
import { appendFileSync, readFileSync } from "node:fs";

const [report, listPath] = process.argv.slice(2);
if (!report || !listPath) {
  console.error("Usage: compare.mjs <junitreport.xml> <tck-known-failures.txt>");
  process.exit(2);
}
const xml = readFileSync(report, "utf8");
const known = new Set(
  readFileSync(listPath, "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean),
);
const unescape = (value) =>
  value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const cases = [];
for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
  const attributes = Object.fromEntries(
    [...match[1].matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, unescape(value)]),
  );
  const body = match[3] ?? "";
  const outcome = /<(failure|error)\b/.test(body) ? "failed" : /<skipped\b/.test(body) ? "skipped" : "passed";
  cases.push({ name: `${attributes.classname}::${attributes.name}`, outcome });
}
if (cases.length === 0) {
  console.error(`No test cases in ${report}: the TCK did not run`);
  process.exit(1);
}
const failed = cases.filter((item) => item.outcome === "failed");
const unexpected = failed.filter((item) => !known.has(item.name));
const fixed = cases.filter((item) => item.outcome === "passed" && known.has(item.name));
const count = (outcome) => cases.filter((item) => item.outcome === outcome).length;
const lines = [
  `## A2A TCK`,
  ``,
  `${count("passed")} passed, ${failed.length} failed (${failed.length - unexpected.length} known), ${count("skipped")} skipped.`,
  ...(unexpected.length ? [``, `### New failures`, ``, ...unexpected.map((item) => `- \`${item.name}\``)] : []),
  ...(fixed.length ? [``, `### Known failures that now pass (remove them from the list)`, ``, ...fixed.map((item) => `- \`${item.name}\``)] : []),
];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
process.exit(unexpected.length > 0 ? 1 : 0);
