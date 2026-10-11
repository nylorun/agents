#!/usr/bin/env node
/**
 * nylorun-harness-conformance --runtime <url> --key <app key> --manage-key <management key>
 *   --harness <id> [--profile container|pod] [--image <ref>] [--restart "<command>"] [--long]
 *   [--workspace] [--mcp-url <url> --mcp-tool <name> [--mcp-args <json>]] [--secret <value>]...
 *   [--only HC01,HC05] [--json]
 *
 * Exits 0 when every check that applies passed, 1 when one failed, 2 on a usage error.
 */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { CHECKS } from "./catalog.js";
import { jsonLine, summary, tableRow } from "./report.js";
import { runConformance, type ConformanceOptions } from "./run.js";

export const USAGE = `Usage: nylorun-harness-conformance --runtime <url> --key <app key> --manage-key <management key> --harness <id>
  [--profile container|pod] [--image <ref>]   the pod profile runs the image as the harness (HC15)
  [--restart "<command>"]                      restarts the harness: runs HC07 and HC08
  [--long]                                     runs HC10, a 16-minute turn
  [--workspace]                                the harness declares workspace: runs HC16
  [--mcp-url <url> --mcp-tool <name> [--mcp-args <json>]]   runs HC17 against that MCP server
  [--secret <value>]...                        values HC14 must never find (e.g. the harness's token)
  [--only HC01,HC05] [--turn-timeout <s>] [--json]

Environment: NYLORUN_RUNTIME_URL, NYLORUN_API_KEY and NYLORUN_MANAGEMENT_KEY stand in for the first three.
Run it against a Tenant for testing: it turns the Tenant's fixture model on, and it stays on.`;

/** The options a command line names, or a usage error. */
export function parseCommandLine(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = {},
): { options: ConformanceOptions; json: boolean } {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      runtime: { type: "string" },
      key: { type: "string" },
      "manage-key": { type: "string" },
      harness: { type: "string" },
      profile: { type: "string" },
      image: { type: "string" },
      restart: { type: "string" },
      long: { type: "boolean" },
      workspace: { type: "boolean" },
      "mcp-url": { type: "string" },
      "mcp-tool": { type: "string" },
      "mcp-args": { type: "string" },
      secret: { type: "string", multiple: true },
      only: { type: "string" },
      "turn-timeout": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) throw new UsageError("", true);
  const runtime = values.runtime ?? env.NYLORUN_RUNTIME_URL;
  const key = values.key ?? env.NYLORUN_API_KEY;
  const manageKey = values["manage-key"] ?? env.NYLORUN_MANAGEMENT_KEY;
  const missing = [
    ["--runtime", runtime],
    ["--key", key],
    ["--manage-key", manageKey],
    ["--harness", values.harness],
  ].filter(([, value]) => !value);
  if (missing.length) throw new UsageError(`Missing ${missing.map(([name]) => name).join(", ")}`);
  const profile = values.profile ?? "container";
  if (profile !== "container" && profile !== "pod")
    throw new UsageError("--profile is container or pod");
  if (profile === "pod" && !values.image) throw new UsageError("--profile pod needs --image <ref>");
  if (Boolean(values["mcp-url"]) !== Boolean(values["mcp-tool"]))
    throw new UsageError("--mcp-url and --mcp-tool go together");
  let mcpArgs: Record<string, unknown> | undefined;
  if (values["mcp-args"] !== undefined) {
    try {
      mcpArgs = JSON.parse(values["mcp-args"]);
    } catch {
      throw new UsageError("--mcp-args is a JSON object");
    }
  }
  const only = values.only
    ?.split(",")
    .map((id) => id.trim().toUpperCase())
    .filter(Boolean);
  const unknown = only?.filter((id) => !CHECKS.some((check) => check.id === id));
  if (unknown?.length) throw new UsageError(`Unknown checks: ${unknown.join(", ")}`);
  const timeout = values["turn-timeout"] === undefined ? undefined : Number(values["turn-timeout"]);
  if (timeout !== undefined && !(timeout > 0))
    throw new UsageError("--turn-timeout is a number of seconds");
  return {
    json: values.json === true,
    options: {
      runtime: runtime!,
      key: key!,
      manageKey: manageKey!,
      harness: values.harness!,
      profile,
      ...(values.image ? { image: values.image } : {}),
      ...(values.restart ? { restart: values.restart } : {}),
      ...(values.long ? { long: true } : {}),
      ...(values.workspace ? { workspace: true } : {}),
      ...(values["mcp-url"]
        ? {
            mcp: {
              url: values["mcp-url"],
              tool: values["mcp-tool"]!,
              ...(mcpArgs ? { args: mcpArgs } : {}),
            },
          }
        : {}),
      ...(values.secret?.length ? { secrets: values.secret } : {}),
      ...(only?.length ? { only } : {}),
      ...(timeout ? { turnTimeoutMs: timeout * 1000 } : {}),
    },
  };
}

export class UsageError extends Error {
  constructor(
    message: string,
    readonly help = false,
  ) {
    super(message);
  }
}

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  out = console.log,
  err = console.error,
): Promise<number> {
  let parsed;
  try {
    parsed = parseCommandLine(argv, env);
  } catch (error) {
    if (
      error instanceof UsageError ||
      (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
    ) {
      if (error instanceof UsageError && error.help) {
        out(USAGE);
        return 0;
      }
      if ((error as Error).message) err((error as Error).message);
      err(USAGE);
      return 2;
    }
    throw error;
  }
  const { options, json } = parsed;
  if (!json)
    out(`Harness conformance: ${options.harness} on ${options.runtime} (${options.profile})\n`);
  try {
    const report = await runConformance({
      ...options,
      onResult: (result) => out(json ? jsonLine(result) : tableRow(result)),
      ...(json ? {} : { log: (line: string) => err(`… ${line}`) }),
    });
    if (!json) out(`\n${summary(report)}`);
    return report.ok ? 0 : 1;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

const invoked =
  process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (invoked) process.exitCode = await main(process.argv.slice(2), process.env);
