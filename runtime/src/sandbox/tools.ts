/**
 * The six built-in sandbox tools, implemented once over `SandboxHandle` so every backend behaves
 * the same. Expected problems are returned as failed outcomes; only infrastructure errors throw.
 */
import { posix } from "node:path";
import { SANDBOX_WORKSPACE, type SandboxToolName } from "@nylorun/core/define";
import type { ExecResult, SandboxHandle } from "./types.js";

export type SandboxToolOutcome =
  | { readonly kind: "completed"; readonly output: unknown }
  | { readonly kind: "failed"; readonly code: string; readonly message: string };

/** What the Runtime reports about a tool call on the session stream. */
export interface SandboxToolReport {
  readonly command?: string;
  readonly path?: string;
  readonly exitCode?: number;
  readonly killed?: boolean;
}

const OUTPUT_LIMIT = 30_000;
const DEFAULT_TIMEOUT_S = 120;
const DEFAULT_READ_LINES = 2000;
const LINE_LIMIT = 2000;
const DEFAULT_GREP_RESULTS = 200;
const GLOB_LIMIT = 500;
const GLOB_SCAN_LIMIT = 20_000;

export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * An absolute path inside the sandbox. Relative paths are relative to the workspace; on a backend
 * whose workspace is not `/workspace` (OpenShell uses `/sandbox`), `/workspace/…` still names it.
 */
export function resolveSandboxPath(path: string, workspace: string = SANDBOX_WORKSPACE): string {
  if (workspace !== SANDBOX_WORKSPACE && (path === SANDBOX_WORKSPACE || path.startsWith(`${SANDBOX_WORKSPACE}/`)))
    path = workspace + path.slice(SANDBOX_WORKSPACE.length);
  return posix.normalize(path.startsWith("/") ? path : posix.join(workspace, path));
}

/** Keep the head and tail of long output so the model sees both the start and the error. */
export function truncateMiddle(value: string, limit = OUTPUT_LIMIT): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  const half = Math.floor(limit / 2);
  const omitted = value.length - half * 2;
  return {
    text: `${value.slice(0, half)}\n… [${omitted} characters omitted] …\n${value.slice(-half)}`,
    truncated: true,
  };
}

const failed = (code: string, message: string): SandboxToolOutcome => ({
  kind: "failed",
  code,
  message,
});

export async function runSandboxTool(
  handle: SandboxHandle,
  name: SandboxToolName,
  input: Record<string, any>,
  signal: AbortSignal,
  report: (value: SandboxToolReport) => void
): Promise<SandboxToolOutcome> {
  const workspace = handle.workspace ?? SANDBOX_WORKSPACE;
  const resolvePath = (path: string) => resolveSandboxPath(path, workspace);
  const exec = (command: string, timeoutMs = 60_000): Promise<ExecResult> =>
    handle.exec({ command, cwd: workspace, timeoutMs }, signal);
  switch (name) {
    case "bash": {
      const command = String(input.command);
      const timeout = (input.timeout ?? DEFAULT_TIMEOUT_S) * 1000;
      const result = await exec(command, timeout);
      report({ command, exitCode: result.exitCode, killed: result.killed });
      const stdout = truncateMiddle(result.stdout);
      const stderr = truncateMiddle(result.stderr);
      return {
        kind: "completed",
        output: {
          exitCode: result.exitCode,
          stdout: stdout.text,
          stderr: result.timedOut
            ? `${stderr.text}${stderr.text && !stderr.text.endsWith("\n") ? "\n" : ""}Command timed out after ${timeout / 1000}s and was killed.`
            : stderr.text,
          ...(stdout.truncated || stderr.truncated ? { truncated: true } : {}),
          ...(result.timedOut ? { timedOut: true } : {}),
        },
      };
    }
    case "read": {
      const path = resolvePath(String(input.path));
      report({ path });
      const content = await handle.readFile(path);
      if (content === undefined) return failed("sandbox.not_found", `No file at ${path}`);
      const lines = content.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const start = (input.offset ?? 1) - 1;
      const limit = input.limit ?? DEFAULT_READ_LINES;
      const slice = lines.slice(start, start + limit);
      const width = String(start + slice.length).length;
      const text = slice
        .map((line: string, index: number) => {
          const clipped = line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT)}…` : line;
          return `${String(start + index + 1).padStart(width, " ")}\t${clipped}`;
        })
        .join("\n");
      const remaining = lines.length - (start + slice.length);
      return {
        kind: "completed",
        output:
          lines.length === 0
            ? `${path} is empty.`
            : remaining > 0
              ? `${text}\n… ${remaining} more line(s); read again with offset ${start + slice.length + 1}.`
              : text,
      };
    }
    case "write": {
      const path = resolvePath(String(input.path));
      const content = String(input.content);
      report({ path });
      const parent = await exec(`mkdir -p ${quote(posix.dirname(path))}`);
      if (parent.exitCode !== 0)
        return failed("sandbox.write_failed", parent.stderr.trim() || `Could not create ${posix.dirname(path)}`);
      await handle.writeFile(path, content);
      return { kind: "completed", output: { path, bytes: Buffer.byteLength(content) } };
    }
    case "edit": {
      const path = resolvePath(String(input.path));
      report({ path });
      const content = await handle.readFile(path);
      if (content === undefined) return failed("sandbox.not_found", `No file at ${path}`);
      const oldString = String(input.old_string);
      const newString = String(input.new_string);
      if (oldString === newString)
        return failed("sandbox.edit_noop", "old_string and new_string are identical");
      const count = content.split(oldString).length - 1;
      if (count === 0)
        return failed("sandbox.edit_no_match", `old_string was not found in ${path}. Read the file and copy the text exactly.`);
      if (count > 1 && input.replace_all !== true)
        return failed(
          "sandbox.edit_not_unique",
          `old_string appears ${count} times in ${path}. Add surrounding context to make it unique, or set replace_all.`
        );
      await handle.writeFile(path, content.replaceAll(oldString, () => newString));
      return { kind: "completed", output: { path, replacements: input.replace_all === true ? count : 1 } };
    }
    case "grep": {
      const max = input.max_results ?? DEFAULT_GREP_RESULTS;
      const target = input.path ? String(input.path) : ".";
      const flags = ["-rnE", ...(input.ignore_case ? ["-i"] : [])];
      const include = input.glob ? ` --include=${quote(String(input.glob))}` : "";
      const command = `grep ${flags.join(" ")}${include} -e ${quote(String(input.pattern))} -- ${quote(target)} | head -n ${max + 1}`;
      report({ command });
      const result = await exec(command);
      // The pipeline's exit code is head's, so a grep error shows up as stderr with no matches.
      const lines = result.stdout.split("\n").filter(Boolean);
      if (lines.length === 0)
        return result.stderr.trim()
          ? failed("sandbox.grep_failed", result.stderr.trim())
          : { kind: "completed", output: "No matches." };
      const shown = lines.slice(0, max).map((line) => (line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT)}…` : line));
      return {
        kind: "completed",
        output: lines.length > max ? `${shown.join("\n")}\n… more matches omitted; narrow the search.` : shown.join("\n"),
      };
    }
    case "glob": {
      const root = resolvePath(input.path ? String(input.path) : ".");
      const pattern = String(input.pattern);
      const command = `find ${quote(root)} -type f -not -path '*/.git/*' 2>/dev/null | head -n ${GLOB_SCAN_LIMIT}`;
      report({ command });
      const result = await exec(command);
      const byBasename = !pattern.includes("/");
      const matches: string[] = [];
      for (const file of result.stdout.split("\n")) {
        if (!file) continue;
        const relative = posix.relative(root, file);
        if (posix.matchesGlob(byBasename ? posix.basename(relative) : relative, pattern)) {
          matches.push(file);
          if (matches.length > GLOB_LIMIT) break;
        }
      }
      if (matches.length === 0) return { kind: "completed", output: "No files matched." };
      matches.sort();
      return {
        kind: "completed",
        output:
          matches.length > GLOB_LIMIT
            ? `${matches.slice(0, GLOB_LIMIT).join("\n")}\n… more files omitted; narrow the pattern.`
            : matches.join("\n"),
      };
    }
  }
}
