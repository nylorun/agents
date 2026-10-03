import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "./errors.js";

/**
 * Studio's anonymous usage analytics. Studio's dashboard reports page views,
 * with every id replaced by `:id`, to this Google Analytics property unless the
 * developer opted out. `nylorun start` decides and passes the id to the
 * Studio container (`NYLORUN_STUDIO_ANALYTICS_ID`); Studio never decides itself.
 */
export const STUDIO_ANALYTICS_ID = "G-K6RPDFH6Q6";

/** `~/.nylorun/telemetry.json`: the developer's choice, for every stack on the machine. */
export interface TelemetryFile {
  format: 1;
  /** False after `nylorun telemetry disable`; absent until a choice is made. */
  enabled?: boolean;
  /** When `nylorun start` showed the notice (ISO time); it is shown once. */
  noticeShown?: string;
}

export type TelemetryDecision = Readonly<{ enabled: boolean; reason: string }>;

export const TELEMETRY_NOTICE = [
  "Studio collects anonymous usage data: which pages are opened, with every",
  "Tenant, agent and session id removed. Nothing you send to agents is collected.",
  'Turn it off with "nylorun telemetry disable" or NYLORUN_TELEMETRY_DISABLED=1.',
  "Learn more: https://github.com/nylorun/agents/blob/main/nylorun/README.md#telemetry",
].join("\n");

export function telemetryPath(nylorunRoot: string): string {
  return join(nylorunRoot, "telemetry.json");
}

export async function readTelemetry(nylorunRoot: string): Promise<TelemetryFile> {
  try {
    const parsed = JSON.parse(await readFile(telemetryPath(nylorunRoot), "utf8")) as unknown;
    if (parsed && typeof parsed === "object") {
      const { enabled, noticeShown } = parsed as Record<string, unknown>;
      return {
        format: 1,
        ...(typeof enabled === "boolean" ? { enabled } : {}),
        ...(typeof noticeShown === "string" ? { noticeShown } : {}),
      };
    }
  } catch {
    /* missing or unreadable: no choice yet */
  }
  return { format: 1 };
}

export async function writeTelemetry(nylorunRoot: string, file: TelemetryFile): Promise<void> {
  await mkdir(nylorunRoot, { recursive: true });
  const path = telemetryPath(nylorunRoot);
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`);
  await rename(temporary, path);
}

/** An environment flag is set unless it is empty, `0`, `false` or `no`. */
function flag(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? "";
  return trimmed !== "" && !/^(0|false|no)$/i.test(trimmed);
}

/** On unless the environment or the developer's choice turns it off. */
export function telemetryDecision(
  env: Readonly<Record<string, string | undefined>>,
  file: TelemetryFile,
): TelemetryDecision {
  if (flag(env.NYLORUN_TELEMETRY_DISABLED))
    return { enabled: false, reason: "NYLORUN_TELEMETRY_DISABLED is set" };
  if (flag(env.DO_NOT_TRACK)) return { enabled: false, reason: "DO_NOT_TRACK is set" };
  if (flag(env.CI)) return { enabled: false, reason: "CI is set" };
  if (file.enabled === false)
    return { enabled: false, reason: 'turned off with "nylorun telemetry disable"' };
  return { enabled: true, reason: "on by default" };
}

const USAGE = "Usage: nylorun telemetry [status|enable|disable]";

/** `nylorun telemetry [status|enable|disable]`. */
export async function telemetryCommand(
  args: readonly string[],
  context: {
    nylorunRoot: string;
    env: Readonly<Record<string, string | undefined>>;
    out(line: string): void;
  },
): Promise<number> {
  const [action = "status", ...rest] = args;
  if (rest.length || !["status", "enable", "disable"].includes(action))
    throw new CliError(USAGE, 2);
  const file = await readTelemetry(context.nylorunRoot);
  if (action !== "status") {
    const enabled = action === "enable";
    await writeTelemetry(context.nylorunRoot, { ...file, enabled });
    context.out(
      `Studio telemetry ${enabled ? "enabled" : "disabled"}. Running stacks pick this up on the next "nylorun start".`,
    );
  }
  const decision = telemetryDecision(context.env, await readTelemetry(context.nylorunRoot));
  context.out(`Studio telemetry is ${decision.enabled ? "on" : "off"} (${decision.reason}).`);
  if (action === "status") context.out(TELEMETRY_NOTICE);
  return 0;
}
