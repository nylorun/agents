/**
 * `nylorun apply [dir…]`: saves the agent manifest each folder describes (protocol 16, track T2),
 * through the Runtime API. A folder's `agent.manifest.json` names its harness and runtime files;
 * `composeManifest` (`@nylorun/agents`) resolves them, hashes the skills, plugins and runtime
 * files they name and checks the harness file's `requires`. Each manifest is planned first
 * (a dry run: from → to, each change, warnings, errors), and saved under `If-Match` set to the
 * version the plan was made against, so a save that raced another fails (`412 manifest_changed`)
 * instead of overwriting it. A folder without an `agent.manifest.json` applies each subfolder
 * that has one (`nylorun apply agents/`).
 */
import { resolve } from "node:path";
import {
  ComposeError,
  PluginError,
  SkillsError,
  composeManifest,
  manifestFolders,
  type AgentManifestPlan,
  type ComposedManifest,
} from "@nylorun/agents";
import { CliError } from "../errors.js";
import type { StackDeps } from "../stack/commands.js";
import { integerFlag, parseFlags, runtimeCall, runtimeClient, runtimeFlagsUsage, usageError } from "./runtime.js";

export const applyUsage = `nylorun apply [<dir>...] [--dry-run] [--if-match <n>]

Saves the agent manifest each folder describes (default .), through the Runtime API with an
application key (or NYLORUN_TOKEN). A folder holds agent.manifest.json, which names its
harness.manifest.json and runtime.manifest.json (paths relative to the file that names them);
a folder without one applies each subfolder that has one.

Each manifest is planned first: the version it moves from and to, each change (section, path,
op), warnings and errors. With no errors it is saved, its skills', plugins' and runtime files
uploaded first, under If-Match set to the version planned against (0 for a new manifest).
Errors, the gaps between its sections included, save nothing and exit 1.

  --dry-run                           print the plans and save nothing
  --if-match <n>                      save only over version n (one folder)

${runtimeFlagsUsage}`;

/** What a folder could not be composed for, as a person reads it. */
function composeFailure(folder: string, error: unknown): never {
  if (error instanceof ComposeError || error instanceof SkillsError || error instanceof PluginError || error instanceof TypeError)
    throw new CliError(`${folder}: ${error.message}`, 1);
  throw error;
}

/** A plan as lines: the move, then each change, warning and error. */
export function planLines(plan: AgentManifestPlan): string[] {
  const move = plan.unchanged
    ? `unchanged at version ${plan.to}`
    : plan.from === null
      ? `new, version ${plan.to}`
      : `version ${plan.from} → ${plan.to}`;
  return [
    `${plan.name}: ${move}${plan.behind > 0 ? ` (${plan.behind} ${plan.behind === 1 ? "Agent" : "Agents"} on older versions)` : ""}`,
    ...plan.changes.map((change) => `  ${change.section} ${change.path} ${change.op}`),
    ...plan.warnings.map((warning) => `  warning: ${warning.message}`),
    ...plan.errors.map((error) => `  error: ${error}`),
  ];
}

/** `nylorun apply [dir…] [--dry-run] [--if-match <n>]` */
export async function applyCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    deps.out(applyUsage);
    return 0;
  }
  const usage = "nylorun apply [<dir>...] [--dry-run] [--if-match <n>]";
  const flags = parseFlags(args, { booleans: ["--dry-run"], values: ["--if-match"] }, usage);
  const ifMatch = integerFlag(flags, "--if-match");
  const cwd = deps.cwd ?? process.cwd();
  const folders: string[] = [];
  for (const dir of flags.rest.length > 0 ? flags.rest : ["."]) {
    const found = await manifestFolders(resolve(cwd, dir)).catch((error: unknown) => composeFailure(dir, error));
    if (found.length === 0) throw usageError(`${dir} holds no agent.manifest.json, and no subfolder does.`);
    folders.push(...found);
  }
  if (ifMatch !== undefined && folders.length > 1) throw usageError("--if-match takes one manifest: name one folder.");
  // Every folder composes before anything is sent: a broken file stops the whole apply.
  const composed: { folder: string; manifest: ComposedManifest }[] = [];
  for (const folder of folders)
    composed.push({ folder, manifest: await composeManifest(folder).catch((error: unknown) => composeFailure(folder, error)) });
  const { client, connection } = await runtimeClient(deps, flags);
  let blocked = false;
  for (const { manifest } of composed) {
    for (const warning of manifest.warnings) deps.err(`${manifest.manifest.name}: warning: ${warning}`);
    // The plan's errors include the gaps the composer found (its sections, the harness's requires).
    const plan = await runtimeCall(() =>
      client.agentManifests.plan(manifest, ifMatch === undefined ? {} : { ifMatch }),
    );
    for (const line of planLines(plan)) deps.out(line);
    if (plan.errors.length > 0) {
      blocked = true;
      continue;
    }
    if (flags.booleans.has("--dry-run") || plan.unchanged) continue;
    const saved = await runtimeCall(() =>
      client.agentManifests.save(manifest, { ifMatch: ifMatch ?? plan.from ?? 0 }),
    );
    deps.err(
      saved.unchanged
        ? `Agent manifest ${saved.manifest.name} is unchanged at version ${saved.manifest.version} on ${connection.label}.`
        : `Saved agent manifest ${saved.manifest.name} version ${saved.manifest.version} on ${connection.label}.`,
    );
    for (const warning of saved.warnings) deps.err(`  warning: ${warning.message}`);
  }
  if (blocked) deps.err("Nothing was saved for a manifest with errors.");
  return blocked ? 1 : 0;
}
