/**
 * `nylorun apply [dir…]`: saves the agent manifest each folder describes (protocol 16, track T2),
 * through the Runtime API. A folder's `agent.manifest.json` names its harness and runtime files;
 * `composeManifest` (`@nylorun/agents`) resolves them, hashes the skills, plugins and runtime
 * files they name and checks the harness file's `requires`. Each manifest is planned first
 * (a dry run: from → to, each change, warnings, errors), and saved under `If-Match` set to the
 * version the plan was made against, so a save that raced another fails (`412 manifest_changed`)
 * instead of overwriting it. A folder without an `agent.manifest.json` applies each subfolder
 * that has one (`nylorun apply agents/`).
 *
 * An agent folder (a folder with `AGENT.md`, track T6) is compiled offline first, and one that does
 * not compile sends nothing; otherwise its files go up by hash and the Runtime compiles it again
 * and keeps it as the version's source. Its plan adds the compiler's notes, and `--dry-run` prints
 * the compiled manifest.
 *
 * Track T7: a plan's change to the instructions prints their text diff (`plan-diff.ts`);
 * `--agent [<id>]` makes or moves the Agent after a save (`apply-agent.ts`); `--watch` checks and
 * plans again on each change, saving only with `--save` (`watch.ts`).
 */
import { resolve } from "node:path";
import {
  ComposeError,
  PluginError,
  SkillsError,
  checkFolder,
  composeManifest,
  isAgentFolder,
  manifestFolders,
  type AgentManifestPlan,
  type ComposedManifest,
  type PackedFolder,
  type SaveAgentManifestResponse,
} from "@nylorun/agents";
import { CliError } from "../errors.js";
import type { StackDeps } from "../stack/commands.js";
import { putAgent, takeAgentFlag } from "./apply-agent.js";
import { agentFolders, diagnosticLines, packed } from "./folder.js";
import { changeDiffLines } from "./plan-diff.js";
import { integerFlag, parseFlags, runtimeCall, runtimeClient, runtimeFlagsUsage, usageError } from "./runtime.js";

export const applyUsage = `nylorun apply [<dir>...] [--dry-run] [--if-match <n>] [--agent [<id>]] [--watch [--save]]

Saves the agent manifest each folder describes (default .), through the Runtime API with an
application key (or NYLORUN_TOKEN). An agent folder holds AGENT.md (nylorun init): it is checked
offline as nylorun check does, sent by hash, and kept as the version's source. A folder may hold
agent.manifest.json instead, which names its harness.manifest.json and runtime.manifest.json
(paths relative to the file that names them). A folder with neither applies each subfolder that
has one.

Each manifest is planned first: the version it moves from and to, each change (section, path,
op), warnings and errors. With no errors it is saved, its skills', plugins' and runtime files
uploaded first, under If-Match set to the version planned against (0 for a new manifest).
Errors, the gaps between its sections included, save nothing and exit 1.

  --dry-run                           print the plans, and an agent folder's compiled manifest, and
                                      save nothing
  --if-match <n>                      save only over version n (one folder)
  --agent [<id>]                      then make the Agent <id> (default the manifest's name) from
                                      the manifest, or move it to the version saved, as nylorun
                                      agents put does; --agent=<id> when <id> names a directory
  --watch                             check and plan again on each change to the folders, until
                                      interrupted; with --save, also save each change

${runtimeFlagsUsage}`;

/** How `--watch` runs an apply (`watch.ts`). */
export interface ApplyOptions {
  /** Plan, and save nothing. */
  planOnly?: boolean;
  /** `nylorun check` printed each folder's diagnostics already. */
  checked?: boolean;
}

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
    ...plan.changes.flatMap((change) => [`  ${change.section} ${change.path} ${change.op}`, ...changeDiffLines(change)]),
    ...plan.warnings.map((warning) => `  warning: ${warning.message}`),
    ...plan.errors.map((error) => `  error: ${error}`),
  ];
}

function reportSaved(deps: StackDeps, saved: SaveAgentManifestResponse, label: string): void {
  deps.err(
    saved.unchanged
      ? `Agent manifest ${saved.manifest.name} is unchanged at version ${saved.manifest.version} on ${label}.`
      : `Saved agent manifest ${saved.manifest.name} version ${saved.manifest.version} on ${label}.`,
  );
  for (const warning of saved.warnings) deps.err(`  warning: ${warning.message}`);
}

/** `nylorun apply [dir…] [--dry-run] [--if-match <n>] [--agent [<id>]] [--watch [--save]]` */
export async function applyCommand(deps: StackDeps, given: readonly string[], options: ApplyOptions = {}): Promise<number> {
  if (given[0] === "--help" || given[0] === "-h") {
    deps.out(applyUsage);
    return 0;
  }
  const usage = "nylorun apply [<dir>...] [--dry-run] [--if-match <n>] [--agent [<id>]] [--watch [--save]]";
  const cwd = deps.cwd ?? process.cwd();
  const { args, agent } = takeAgentFlag(given, cwd);
  const flags = parseFlags(args, { booleans: ["--dry-run", "--watch", "--save"], values: ["--if-match"] }, usage);
  if (flags.booleans.has("--save") && !flags.booleans.has("--watch")) throw usageError("--save goes with --watch: apply saves anyway.");
  if (flags.booleans.has("--watch")) {
    if (flags.booleans.has("--dry-run")) throw usageError("--watch saves nothing unless --save: drop --dry-run.");
    const { watchApply } = await import("./watch.js");
    return watchApply(deps, {
      dirs: flags.rest,
      args: given.filter((arg) => arg !== "--watch" && arg !== "--save"),
      save: flags.booleans.has("--save"),
    });
  }
  const ifMatch = integerFlag(flags, "--if-match");
  const folders: string[] = [];
  for (const dir of flags.rest.length > 0 ? flags.rest : ["."]) {
    const at = resolve(cwd, dir);
    const found = (await isAgentFolder(at))
      ? [at]
      : [
          ...new Set([
            ...(await manifestFolders(at).catch((error: unknown) => composeFailure(dir, error))),
            ...(await agentFolders(at)),
          ]),
        ].sort();
    if (found.length === 0) throw usageError(`${dir} holds no AGENT.md or agent.manifest.json, and no subfolder does.`);
    folders.push(...found);
  }
  if (ifMatch !== undefined && folders.length > 1) throw usageError("--if-match takes one manifest: name one folder.");
  if (agent?.id !== undefined && folders.length > 1) throw usageError("--agent <id> takes one manifest: name one folder, or drop the id.");
  // Every folder composes, or compiles, before anything is sent: a broken file stops the whole apply.
  const work: ({ folder: string; manifest: ComposedManifest } | { folder: string; pack: PackedFolder })[] = [];
  let blocked = false;
  for (const folder of folders) {
    if (await isAgentFolder(folder)) {
      const pack = await packed(folder);
      const compiled = await checkFolder(pack);
      if (!compiled.manifest) {
        if (!options.checked) for (const line of diagnosticLines(folder, cwd, compiled.diagnostics)) deps.err(line);
        blocked = true;
      }
      work.push({ folder, pack });
    } else work.push({ folder, manifest: await composeManifest(folder).catch((error: unknown) => composeFailure(folder, error)) });
  }
  if (blocked) {
    deps.err("Nothing was sent: an agent folder does not compile (nylorun check).");
    return 1;
  }
  const { client, connection } = await runtimeClient(deps, flags);
  const dryRun = flags.booleans.has("--dry-run") || options.planOnly === true;
  // `--agent`: make or move the Agent once its manifest is saved, or found unchanged.
  const agentFor = async (name: string) => {
    if (agent && !dryRun) await putAgent(deps, client, connection.label, agent.id ?? name, name);
  };
  for (const item of work) {
    const saveOptions = ifMatch === undefined ? {} : { ifMatch };
    if ("pack" in item) {
      const plan = await runtimeCall(() => client.agentManifests.planFolder(item.pack, saveOptions));
      for (const line of planLines(plan)) deps.out(line);
      if (!options.checked)
        for (const line of diagnosticLines(item.folder, cwd, (plan.diagnostics ?? []).filter((d) => d.severity !== "error")))
          deps.out(`  ${line}`);
      if (flags.booleans.has("--dry-run") && plan.manifest) deps.out(JSON.stringify(plan.manifest, null, 2));
      if (plan.errors.length > 0) {
        blocked = true;
        continue;
      }
      if (dryRun) continue;
      if (!plan.unchanged)
        reportSaved(deps, await runtimeCall(() => client.agentManifests.saveFolder(item.pack, { ifMatch: ifMatch ?? plan.from ?? 0 })), connection.label);
      await agentFor(plan.name);
      continue;
    }
    const { manifest } = item;
    for (const warning of manifest.warnings) deps.err(`${manifest.manifest.name}: warning: ${warning}`);
    // The plan's errors include the gaps the composer found (its sections, the harness's requires).
    const plan = await runtimeCall(() => client.agentManifests.plan(manifest, saveOptions));
    for (const line of planLines(plan)) deps.out(line);
    if (plan.errors.length > 0) {
      blocked = true;
      continue;
    }
    if (dryRun) continue;
    if (!plan.unchanged) {
      const saved = await runtimeCall(() =>
        client.agentManifests.save(manifest, { ifMatch: ifMatch ?? plan.from ?? 0 }),
      );
      reportSaved(deps, saved, connection.label);
    }
    await agentFor(plan.name);
  }
  if (blocked) deps.err("Nothing was saved for a manifest with errors.");
  return blocked ? 1 : 0;
}
