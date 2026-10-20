/**
 * `nylorun migrate v8 <agent.json>`: a one-off for protocol 16 (track T2). It writes the three
 * authoring files `nylorun apply` reads from an agent manifest v7 (or a workflow manifest v3), as
 * `agents save` took it, and the environment manifest v1 its sessions ran in, if any:
 *
 * - `agent.manifest.json`: the name (the v7 id), description and metadata, naming the two files;
 * - `harness.manifest.json`: the loop (`harnessSectionOf`: instructions, tools, skills, MCP
 *   servers, output schema, the plugins they came from), the environment manifest's `harness` as
 *   `id`, and v7's `requires`, which the composer checks against the runtime;
 * - `runtime.manifest.json`: the environment manifest's fields without its identity; with none,
 *   kind `pod` when the agent requires one, `virtual` when it has skills or requires a sandbox,
 *   else `none`.
 *
 * It writes nothing over an existing file, reads nothing from a Runtime, and prints the gaps
 * `nylorun apply` would refuse, to fix in the files first.
 *
 * `nylorun migrate folder <dir>` (`convert.ts`, track T7) writes the agent folder of a three-file
 * folder.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { requirementGaps } from "@nylorun/agents";
import {
  AgentManifestSchema,
  RuntimeManifestFileSchema,
  WorkflowManifestSchema,
  isAgentManifestName,
  type AgentManifest,
  type RuntimeSection,
  type WorkflowManifest,
} from "@nylorun/core/contracts";
import { harnessSectionOf, sectionGaps } from "@nylorun/core/define";
import { CliError } from "../errors.js";
import { parseStackFlags, type StackDeps } from "../stack/commands.js";
import { migrateFolderCommand, migrateFolderUsage } from "./convert.js";
import { readJson, usageError } from "./runtime.js";

export const migrateUsage = `nylorun migrate v8 <agent.json> [--runtime <environment-manifest.json>] [--name <name>] [--out <dir>]

Writes agent.manifest.json, harness.manifest.json and runtime.manifest.json (in --out, default
.) from an agent manifest v7 or a workflow manifest v3, as nylorun agents save took it, and the
environment manifest v1 its sessions ran in. Then save it with nylorun apply <dir>.

  --runtime <file>                    the environment manifest: its fields become the runtime
                                      section, its harness the harness file's id
  --name <name>                       the manifest's name (default: the agent's id)
  --out <dir>                         where the files are written; none is overwritten`;

const SCHEMAS = {
  agent: "https://docs.nylorun.com/schemas/agent-manifest/v8.json",
  harness: "https://docs.nylorun.com/schemas/harness-manifest/v1.json",
  runtime: "https://docs.nylorun.com/schemas/runtime-manifest/v1.json",
};

/** Environment manifest v1's identity: the agent manifest holds it now, or nothing does. */
const ENVIRONMENT_IDENTITY = ["$schema", "name", "description", "manifestSchemaVersion", "harness"];

function issuesOf(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => `  ${issue.path.length ? `${issue.path.map(String).join(".")}: ` : ""}${issue.message}`)
    .join("\n");
}

/** The loop manifest in `path`: an agent manifest v7 or a workflow manifest v3. */
async function loopManifest(path: string): Promise<AgentManifest | WorkflowManifest> {
  const { $schema: _, ...raw } = await readJson(path, "The agent manifest");
  const parsed = raw.kind === "workflow" ? WorkflowManifestSchema.safeParse(raw) : AgentManifestSchema.safeParse(raw);
  if (!parsed.success) throw usageError(`${path} is not an agent manifest v7 or a workflow manifest v3:\n${issuesOf(parsed.error)}`);
  return parsed.data as AgentManifest | WorkflowManifest;
}

/** Whether a loop manifest, or an agent it embeds or delegates to, carries skills. */
function hasSkills(loop: AgentManifest | WorkflowManifest): boolean {
  if ("kind" in loop) return Object.values(loop.agents).some(hasSkills);
  if (Object.keys(loop.skills ?? {}).length > 0) return true;
  return (loop.tools ?? []).some((tool) => tool.agent !== undefined && hasSkills(tool.agent as AgentManifest));
}

/** `nylorun migrate v8 <agent.json> [--runtime <file>] [--name <name>] [--out <dir>]` */
export async function migrateCommand(deps: StackDeps, args: readonly string[]): Promise<number> {
  const [version, ...rest] = args;
  if (version === "--help" || version === "-h") {
    deps.out(`${migrateUsage}\n\n${migrateFolderUsage}`);
    return 0;
  }
  if (version === "folder") return migrateFolderCommand(deps, rest);
  if (version !== "v8")
    throw usageError(version === undefined ? migrateUsage : `nylorun migrate knows v8 and folder only.\n${migrateUsage}\n\n${migrateFolderUsage}`);
  const flags = parseStackFlags(rest, { values: ["--runtime", "--name", "--out"] }, migrateUsage);
  if (flags.rest.length !== 1) throw usageError(`Usage: ${migrateUsage.split("\n")[0]}`);
  const cwd = deps.cwd ?? process.cwd();
  const loop = await loopManifest(resolve(cwd, flags.rest[0]!));
  const name = flags.values.get("--name") ?? loop.id;
  if (!isAgentManifestName(name))
    throw usageError(
      `${name} is not an agent manifest's name (1-64 letters, digits, '.', '_' and '-', starting with a letter or digit): pass --name.`,
    );
  // The environment manifest: its fields are the runtime section, its harness the loop's.
  let harnessId: string | undefined;
  let runtime: RuntimeSection;
  const runtimePath = flags.values.get("--runtime");
  const requires = "kind" in loop ? undefined : loop.requires;
  if (runtimePath !== undefined) {
    const environment = await readJson(resolve(cwd, runtimePath), "The environment manifest");
    if (typeof environment.harness === "string") harnessId = environment.harness;
    const fields = Object.fromEntries(Object.entries(environment).filter(([key]) => !ENVIRONMENT_IDENTITY.includes(key)));
    // Environment manifest v1 made kind `virtual` when it named none.
    const parsed = RuntimeManifestFileSchema.safeParse({ kind: "virtual", ...fields });
    if (!parsed.success) throw usageError(`${runtimePath} does not make a runtime section:\n${issuesOf(parsed.error)}`);
    const { $schema: _, ...section } = parsed.data;
    runtime = section as RuntimeSection;
  } else {
    const kind =
      requires?.sandbox === "pod" ? "pod" : hasSkills(loop) || requires?.sandbox === "any" ? "virtual" : "none";
    runtime = { kind };
  }
  const harness = harnessSectionOf(loop, harnessId === undefined ? {} : { harness: harnessId });
  const out = resolve(cwd, flags.values.get("--out") ?? ".");
  const files = {
    "agent.manifest.json": {
      $schema: SCHEMAS.agent,
      manifestSchemaVersion: 8,
      name,
      ...(loop.description === undefined ? {} : { description: loop.description }),
      ...(loop.metadata === undefined ? {} : { metadata: loop.metadata }),
      harness: "./harness.manifest.json",
      runtime: "./runtime.manifest.json",
    },
    // A flow's harness section is the flow itself; an agent's keeps `requires` for the composer.
    "harness.manifest.json": {
      ...("kind" in harness ? {} : { $schema: SCHEMAS.harness }),
      ...harness,
      ...(requires === undefined ? {} : { requires }),
    },
    "runtime.manifest.json": { $schema: SCHEMAS.runtime, ...runtime },
  };
  const existing = Object.keys(files).filter((file) => existsSync(join(out, file)));
  if (existing.length > 0)
    throw new CliError(`${relative(cwd, out) || "."} already holds ${existing.join(", ")}: nothing was written. Pass another --out.`, 1);
  await mkdir(out, { recursive: true });
  for (const [file, body] of Object.entries(files))
    await writeFile(join(out, file), `${JSON.stringify(body, null, 2)}\n`);
  const where = relative(cwd, out) || ".";
  deps.out(`Wrote ${Object.keys(files).map((file) => join(where, file)).join(", ")}.`);
  const gaps = [
    ...requirementGaps(requires, runtime).map((gap) => `harness.${gap}`),
    ...sectionGaps({ harness, runtime }),
  ];
  for (const gap of gaps) deps.err(`  fix before apply: ${gap}`);
  if (!("kind" in harness) && harness.skills !== undefined)
    deps.err(
      "  its skills stay inline, by hash: the Runtime must hold their files. To upload them from source, set harness.manifest.json skills to their folder.",
    );
  deps.err(`Save it with nylorun apply ${where}.`);
  return 0;
}
