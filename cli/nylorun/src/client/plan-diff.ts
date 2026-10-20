/**
 * The text diff `nylorun apply` prints under a plan's change to the instructions (track T7): the
 * plan carries the instructions before and after (`from`, `to`), and the lines that differ print
 * as `-` and `+`, without the lines both keep. Pure.
 */
import type { AgentManifestPlan } from "@nylorun/agents";

/** The most diff lines one change prints. */
const MAX_LINES = 40;

/** Instructions as text: a string, or each block of an array, a blank line between. */
function textOf(value: unknown): string | undefined {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join("\n\n");
  return undefined;
}

/**
 * The lines that differ between `before` and `after`, in order: `- line` for a removed one and
 * `+ line` for an added one, with `…` between changes that are apart. A longest common
 * subsequence of lines, so a moved block shows as removed and added.
 */
export function lineDiff(before: string, after: string): string[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  // Lines both start and end with stay out of the table.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const ops: { op: "-" | "+" | "="; line: string }[] = [];
  if (x.length * y.length > 4_000_000) {
    ops.push(...x.map((line) => ({ op: "-" as const, line })), ...y.map((line) => ({ op: "+" as const, line })));
  } else {
    // lengths[i][j]: the longest common subsequence of x[i..] and y[j..].
    const lengths = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i -= 1)
      for (let j = y.length - 1; j >= 0; j -= 1)
        lengths[i]![j] = x[i] === y[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        ops.push({ op: "=", line: x[i]! });
        i += 1;
        j += 1;
      } else if (i < x.length && (j === y.length || lengths[i + 1]![j]! >= lengths[i]![j + 1]!)) {
        ops.push({ op: "-", line: x[i]! });
        i += 1;
      } else {
        ops.push({ op: "+", line: y[j]! });
        j += 1;
      }
    }
  }
  const lines: string[] = [];
  let gap = false;
  for (const { op, line } of ops) {
    if (op === "=") {
      gap = lines.length > 0;
      continue;
    }
    if (gap) lines.push("…");
    gap = false;
    lines.push(`${op} ${line}`.trimEnd());
  }
  return lines;
}

/** The diff lines to print under one of a plan's changes: the instructions' text, else none. */
export function changeDiffLines(change: AgentManifestPlan["changes"][number], indent = "    "): string[] {
  if (change.section !== "harness" || change.path !== "instructions") return [];
  const before = textOf(change.from);
  const after = textOf(change.to);
  if (before === undefined || after === undefined) return [];
  const lines = lineDiff(before, after);
  const shown = lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more lines`] : lines;
  return shown.map((line) => `${indent}${line}`);
}
