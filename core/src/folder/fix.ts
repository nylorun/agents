/**
 * The compiler's fix-its, applied to text (`nylorun check --fix`, track T7): each diagnostic's
 * `fix` (`AgentFolderFix`) is one edit, and this makes it, touching nothing else. Like the
 * compiler it is pure: it is given the text of each file a fix names, and answers the new text
 * of each it changed.
 *
 * - `crlf`: every CRLF line end becomes LF.
 * - `rename_key`: the key token at the line and column, a JSON string or a YAML key (plain or
 *   quoted), is renamed; every other byte stays, quotes and spacing included.
 * - `move_skill_secrets`: the `secrets` lines leave the `SKILL.md`'s frontmatter, and
 *   `AGENT.md`'s frontmatter gets `skills: { <skill>: { secrets } }` written as `migrate folder`
 *   writes it, in the `skills` block (or the skill's) that is there, else as a new one at its end.
 *
 * A fix whose text is not where it says (the file changed since it was checked), or that would
 * need more than its own lines rewritten (a frontmatter in flow style), is skipped, with why.
 */
import { isMap, isPair, isScalar, LineCounter, parseDocument, stringify, type YAMLMap } from "yaml";
import type { AgentFolderFix } from "../contracts.js";

/** What applying a folder's fix-its did: the new text of each file changed, and each change. */
export interface AppliedFolderFixes {
  /** The new text of each file a fix changed, by path. */
  readonly files: ReadonlyMap<string, string>;
  /** Each change made, by file, as a person reads it. */
  readonly changes: readonly { readonly file: string; readonly change: string }[];
  /** Each fix not made, and why. */
  readonly skipped: readonly { readonly fix: AgentFolderFix; readonly reason: string }[];
}

const AGENT_FILE = "AGENT.md";
const FENCE = /^---[ \t]*$/;
const BOM = "﻿";
/** How `migrate folder` writes frontmatter (`decompile.ts`). */
const YAML_OUT = { version: "1.2", schema: "core", aliasDuplicateObjects: false, lineWidth: 0 } as const;

/**
 * Applies `fixes` to `files`, the text of each file they name (with `AGENT.md` for a
 * `move_skill_secrets`). Line ends first, then renames, then moved secrets, so every position is
 * still the one the compiler gave. A fix given twice is made once.
 */
export function applyFolderFixes(files: ReadonlyMap<string, string>, fixes: readonly AgentFolderFix[]): AppliedFolderFixes {
  const texts = new Map<string, string>();
  const changes: { file: string; change: string }[] = [];
  const skipped: { fix: AgentFolderFix; reason: string }[] = [];
  const seen = new Set<string>();
  const unique = fixes.filter((fix) => {
    const key = JSON.stringify(fix);
    return seen.has(key) ? false : (seen.add(key), true);
  });
  const textOf = (path: string) => texts.get(path) ?? files.get(path);
  const order = { crlf: 0, rename_key: 1, move_skill_secrets: 2 } as const;
  // Renames on one line from its end, so a rename leaves the columns before it as they were.
  const sorted = [...unique].sort(
    (a, b) =>
      order[a.kind] - order[b.kind] ||
      (a.kind === "rename_key" && b.kind === "rename_key" ? (a.file < b.file ? -1 : a.file > b.file ? 1 : b.line - a.line || b.column - a.column) : 0),
  );
  for (const fix of sorted) {
    const text = textOf(fix.file);
    if (text === undefined) {
      skipped.push({ fix, reason: `${fix.file} was not read` });
      continue;
    }
    if (fix.kind === "crlf") {
      if (!text.includes("\r\n")) continue;
      texts.set(fix.file, text.replace(/\r\n/g, "\n"));
      changes.push({ file: fix.file, change: "CRLF line ends made LF" });
      continue;
    }
    if (fix.kind === "rename_key") {
      const renamed = renameKey(text, fix);
      if (typeof renamed !== "string") skipped.push({ fix, reason: renamed.reason });
      else {
        texts.set(fix.file, renamed);
        changes.push({ file: fix.file, change: `renamed '${fix.from}' to '${fix.to}' at line ${fix.line}` });
      }
      continue;
    }
    const agent = textOf(AGENT_FILE);
    if (agent === undefined) {
      skipped.push({ fix, reason: `${AGENT_FILE} was not read` });
      continue;
    }
    const moved = moveSkillSecrets(text, agent, fix);
    if ("reason" in moved) {
      skipped.push({ fix, reason: moved.reason });
      continue;
    }
    texts.set(fix.file, moved.skill);
    changes.push({ file: fix.file, change: `secrets moved to ${AGENT_FILE}'s skills block` });
    if (moved.agent !== agent) {
      texts.set(AGENT_FILE, moved.agent);
      changes.push({ file: AGENT_FILE, change: `skills.${fix.skill}.secrets: ${fix.secrets.join(", ")}, from ${fix.file}` });
    }
  }
  const changed = new Map([...texts].filter(([path, text]) => text !== files.get(path)));
  return { files: changed, changes, skipped };
}

type Failed = { readonly reason: string };

/** `text` with the key at the fix's line and column renamed, or why it cannot be. */
function renameKey(source: string, fix: Extract<AgentFolderFix, { kind: "rename_key" }>): string | Failed {
  const bom = source.startsWith(BOM) ? BOM : "";
  const lines = source.slice(bom.length).split("\n");
  const line = lines[fix.line - 1];
  const at = fix.column - 1;
  const stale = { reason: `'${fix.from}' is no longer at line ${fix.line}, column ${fix.column}: check again` };
  if (line === undefined) return stale;
  const tokens = fix.file.endsWith(".json")
    ? [[JSON.stringify(fix.from), JSON.stringify(fix.to)]]
    : [
        [JSON.stringify(fix.from), JSON.stringify(fix.to)],
        [`'${fix.from.replace(/'/g, "''")}'`, `'${fix.to.replace(/'/g, "''")}'`],
        [fix.from, fix.to],
      ];
  for (const [from, to] of tokens) {
    if (!line.startsWith(from!, at)) continue;
    // A plain YAML key ends at its colon, or the space before it.
    if (from === fix.from && !/^[ \t]*:/.test(line.slice(at + from.length))) continue;
    lines[fix.line - 1] = line.slice(0, at) + to + line.slice(at + from!.length);
    return bom + lines.join("\n");
  }
  return stale;
}

/** A Markdown file's frontmatter, parsed with each node's range, and the lines around it. */
interface Frontmatter {
  readonly bom: string;
  readonly lines: string[];
  /** The index of the closing `---` line. */
  readonly end: number;
  readonly yaml: string;
  readonly map: YAMLMap | null;
  readonly counter: LineCounter;
}

function frontmatterOf(source: string, file: string): Frontmatter | Failed {
  const bom = source.startsWith(BOM) ? BOM : "";
  const lines = source.slice(bom.length).split("\n");
  const end = FENCE.test(lines[0]?.replace(/\r$/, "") ?? "") ? lines.findIndex((line, index) => index > 0 && FENCE.test(line.replace(/\r$/, ""))) : -1;
  if (end < 0) return { reason: `${file} has no frontmatter between --- lines` };
  const yaml = lines.slice(1, end).join("\n");
  const counter = new LineCounter();
  const document = parseDocument(yaml, { lineCounter: counter, version: "1.2", schema: "core", uniqueKeys: true, merge: false });
  if (document.errors.length > 0) return { reason: `${file}'s frontmatter is not valid YAML` };
  const contents = document.contents;
  if (contents !== null && (!isMap(contents) || contents.flow)) return { reason: `${file}'s frontmatter is not a block of key: value lines` };
  return { bom, lines, end, yaml, map: contents, counter };
}

/** The pair of `map` with key `name`. */
function pairOf(map: YAMLMap | null, name: string) {
  return map?.items.find((item) => isPair(item) && isScalar(item.key) && item.key.value === name);
}

/** The 0-based line, in the frontmatter's YAML, of the last character a pair's value holds. */
function lastLine(front: Frontmatter, pair: NonNullable<ReturnType<typeof pairOf>>): number {
  const key = pair.key as { range: [number, number, number] };
  const value = (pair.value as { range?: [number, number, number] } | null)?.range;
  const end = Math.max(key.range[1], front.yaml.slice(0, value?.[1] ?? 0).trimEnd().length);
  return front.counter.linePos(end - 1).line - 1;
}

/** A pair's 0-based line and column in the frontmatter's YAML. */
function startOf(front: Frontmatter, node: unknown): { line: number; column: number } {
  const position = front.counter.linePos((node as { range: [number, number, number] }).range[0]);
  return { line: position.line - 1, column: position.col - 1 };
}

/** `value` as `migrate folder` writes it, each line indented by `indent`. */
const block = (value: Record<string, unknown>, indent: string) =>
  stringify(value, YAML_OUT)
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => indent + line);

/** The `SKILL.md` without its `secrets`, and `AGENT.md` with them, or why they cannot move. */
function moveSkillSecrets(skillText: string, agentText: string, fix: Extract<AgentFolderFix, { kind: "move_skill_secrets" }>): { skill: string; agent: string } | Failed {
  const skill = frontmatterOf(skillText, fix.file);
  if ("reason" in skill) return skill;
  const secrets = pairOf(skill.map, "secrets");
  const listed = (secrets?.value as { toJSON?: () => unknown } | null | undefined)?.toJSON?.();
  if (!secrets || !Array.isArray(listed) || listed.length !== fix.secrets.length || !fix.secrets.every((name) => listed.includes(name)))
    return { reason: `${fix.file}'s secrets are not the ones checked: check again` };
  const from = startOf(skill, secrets.key);
  if (from.column !== 0) return { reason: `${fix.file}'s secrets is not a line of its own` };
  const skillLines = [...skill.lines];
  skillLines.splice(from.line + 1, lastLine(skill, secrets) - from.line + 1);

  const agent = frontmatterOf(agentText, AGENT_FILE);
  if ("reason" in agent) return agent;
  const agentLines = [...agent.lines];
  const done = (lines: string[]) => ({ skill: skill.bom + skillLines.join("\n"), agent: agent.bom + lines.join("\n") });
  const insert = (after: number, lines: string[]) => {
    agentLines.splice(after + 1, 0, ...lines);
    return done(agentLines);
  };
  const settings = { secrets: fix.secrets };
  const skills = pairOf(agent.map, "skills");
  if (!skills) return insert(agent.end - 1, block({ skills: { [fix.skill]: settings } }, ""));
  const where = { reason: `${AGENT_FILE}'s skills is not a block of key: value lines: add skills: { ${fix.skill}: { secrets: [...] } } by hand` };
  if (!isMap(skills.value) || skills.value.flow || skills.value.items.length === 0) return where;
  const own = pairOf(skills.value, fix.skill);
  if (!own) {
    const indent = " ".repeat(startOf(agent, skills.value.items[0]!.key).column);
    return insert(lastLine(agent, skills) + 1, block({ [fix.skill]: settings }, indent));
  }
  if (!isMap(own.value) || own.value.flow || own.value.items.length === 0) return where;
  const present = (pairOf(own.value, "secrets")?.value as { toJSON?: () => unknown } | null | undefined)?.toJSON?.();
  if (Array.isArray(present)) return fix.secrets.every((name) => present.includes(name)) ? done(agentLines) : where;
  const indent = " ".repeat(startOf(agent, own.value.items[0]!.key).column);
  return insert(lastLine(agent, own) + 1, block(settings, indent));
}
