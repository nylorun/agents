import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DEFINITION_FILE_MAX_BYTES,
  SKILL_ENTRY,
  SKILL_FILES_MAX,
  skillFilePathIssue,
  type SkillFileSource,
} from "@nylorun/core/define";
import matter from "gray-matter";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Version control and operating system files, never part of a skill. */
const SKIPPED_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules"]);
const SKIPPED_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
/** Environment files hold secrets: never uploaded (`.env`, `.env.local`, …). */
const isEnvFile = (name: string) => name === ".env" || name.startsWith(".env.");

export interface SkillDiagnostic {
  readonly severity: "info" | "warning";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export class SkillsError extends Error {
  readonly code: string;
  readonly diagnostics: readonly SkillDiagnostic[];

  constructor(
    code: string,
    message: string,
    diagnostics: readonly SkillDiagnostic[] = []
  ) {
    super(message);
    this.name = "SkillsError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

/** One skill read from its folder: what the manifest names, and where each file's bytes are. */
export interface LoadedSkill {
  readonly name: string;
  readonly description: string;
  /** Every file of the folder by its `/`-separated path, as `sha256:<hex>`. */
  readonly files: Readonly<Record<string, string>>;
  /** Each file's bytes, by `sha256:<hex>`, for the client to upload. */
  readonly sources: Readonly<Record<string, SkillFileSource>>;
}

/** Resolve a skills catalog directory; throws when missing or not a directory. */
export function resolveSkillsRoot(directory: string): string {
  const resolved = resolve(directory);
  if (!existsSync(resolved))
    throw new SkillsError(
      "skills.missing",
      `Skills directory does not exist: ${directory}`
    );
  const real = realpathSync(resolved);
  if (!statSync(real).isDirectory())
    throw new SkillsError(
      "skills.missing",
      `Skills path is not a directory: ${directory}`
    );
  return real;
}

/**
 * Load Agent Skills (agentskills.io) from a catalog directory.
 * Each immediate subdirectory with a valid SKILL.md becomes one skill, with every file of its
 * folder (text or binary) hashed. Throws `SkillsError` for a skill the Runtime cannot hold: a
 * file over 10 MiB, more than 500 files, or a path a manifest cannot name.
 */
export function loadSkillsFromDirectory(
  directory: string,
  diagnostics: SkillDiagnostic[],
  options: { readonly boundary?: string; readonly codePrefix?: string } = {}
): Readonly<Record<string, LoadedSkill>> {
  const root = resolveSkillsRoot(directory);
  const boundary = options.boundary ?? root;
  const prefix = options.codePrefix ?? "skills";
  const skills: Record<string, LoadedSkill> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const skillDir = join(root, entry.name);
    const directoryReal = realInside(boundary, skillDir);
    if (!directoryReal) {
      diagnostics.push({
        severity: "warning",
        code: `${prefix}.skill-skipped`,
        message: `Skipped skill '${entry.name}' because its directory escapes the package`,
        path: skillDir,
      });
      continue;
    }
    const skillFile = join(directoryReal, SKILL_ENTRY);
    if (!existsSync(skillFile)) continue;
    const skillReal = realInside(boundary, skillFile);
    if (!skillReal || !statSync(skillReal).isFile()) {
      diagnostics.push({
        severity: "warning",
        code: `${prefix}.skill-skipped`,
        message: `Skipped skill '${entry.name}' because SKILL.md escapes the package`,
        path: skillFile,
      });
      continue;
    }
    const parsed = parseSkill(readFileSync(skillReal, "utf8"), entry.name);
    if (!parsed) {
      diagnostics.push({
        severity: "warning",
        code: `${prefix}.skill-skipped`,
        message: `Skipped skill '${entry.name}' because SKILL.md is not a valid Agent Skill`,
        path: skillFile,
      });
      continue;
    }
    if (skills[parsed.name]) {
      diagnostics.push({
        severity: "warning",
        code: `${prefix}.skill-skipped`,
        message: `Skipped duplicate skill '${parsed.name}'`,
        path: skillFile,
      });
      continue;
    }
    skills[parsed.name] = {
      name: parsed.name,
      description: parsed.description,
      ...readFiles(parsed.name, boundary, directoryReal, diagnostics, prefix),
    };
  }
  return skills;
}

export function parseSkill(
  text: string,
  directoryName: string
): { name: string; description: string; instructions: string } | undefined {
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(text);
  } catch {
    return undefined;
  }
  const name = asTrimmedString(parsed.data.name);
  const description = asTrimmedString(parsed.data.description);
  if (!name || !description || description.length > 1024) return undefined;
  if (name.length > 64 || !SKILL_NAME.test(name) || name !== directoryName)
    return undefined;
  return {
    name,
    description,
    instructions: parsed.content.replace(/^\r?\n/, ""),
  };
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Every file of the skill's folder, hashed, and where to read each one's bytes. */
function readFiles(
  name: string,
  boundary: string,
  directory: string,
  diagnostics: SkillDiagnostic[],
  prefix: string
): Pick<LoadedSkill, "files" | "sources"> {
  const files: Record<string, string> = {};
  const sources: Record<string, SkillFileSource> = {};
  const visited = new Set<string>();
  // `at` is the folder's path in the skill: symbolic links inside the package are followed.
  const walk = (current: string, at: string) => {
    if (visited.has(current)) return;
    visited.add(current);
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const real = realInside(boundary, full);
      if (!real) {
        diagnostics.push({
          severity: "warning",
          code: `${prefix}.resource-denied`,
          message: `Denied a file of skill '${name}' outside the package: ${entry.name}`,
          path: full,
        });
        continue;
      }
      const stats = statSync(real);
      const path = at === "" ? entry.name : `${at}/${entry.name}`;
      if (stats.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(real, path);
        continue;
      }
      if (!stats.isFile() || SKIPPED_FILES.has(entry.name) || isEnvFile(entry.name)) continue;
      const issue = skillFilePathIssue(path);
      if (issue)
        throw new SkillsError(
          `${prefix}.invalid-path`,
          `Skill '${name}' has a file whose path ${issue}: ${path}`
        );
      if (stats.size > DEFINITION_FILE_MAX_BYTES)
        throw new SkillsError(
          `${prefix}.file-too-large`,
          `Skill '${name}' file ${path} is ${stats.size} bytes; a skill file may be at most ${DEFINITION_FILE_MAX_BYTES} (10 MiB)`
        );
      const hash = `sha256:${createHash("sha256").update(readFileSync(real)).digest("hex")}`;
      files[path] = hash;
      sources[hash] = {
        size: stats.size,
        read: async () => new Uint8Array(await readFile(real)),
      };
      if (Object.keys(files).length > SKILL_FILES_MAX)
        throw new SkillsError(
          `${prefix}.too-many-files`,
          `Skill '${name}' has more than ${SKILL_FILES_MAX} files; a skill may have at most ${SKILL_FILES_MAX}`
        );
    }
  };
  walk(directory, "");
  return { files: sorted(files), sources };
}

function sorted(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
}

function realInside(root: string, candidate: string): string | undefined {
  if (!existsSync(candidate)) return undefined;
  try {
    const real = realpathSync(candidate);
    return isInside(root, real) ? real : undefined;
  } catch {
    return undefined;
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}
