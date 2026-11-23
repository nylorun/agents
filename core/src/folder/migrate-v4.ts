/**
 * `agent-folder/3` → `agent-folder/4` (ADR-164): each subagent folder becomes one file,
 * `agents/<id>.md`, and what it held moves into the manifest's library. `nylorun migrate folder
 * <dir> --to 4` plans it here, applies it to a copy, and writes it only when the copy compiles to
 * the same agent manifest.
 *
 * - `agents/<id>/AGENT.md` → `agents/<id>.md`, listing exactly what the subagent had: `tools`
 *   (its HTTP tools and Runtime plugin tools, or `[]`), and `skills` and `mcpServers` when the
 *   library holds more than it had. Its `plugins:` and `mcpServers.nylorun` go: a file inherits
 *   the root's.
 * - Its `tools/`, `skills/` and `mcp.json` servers move to the root's; one the root already has, with
 *   the same bytes, is dropped. Under a root driven by a model loop, a tool that moves up joins the
 *   root's `disallowedTools`, so the root gains none.
 * - `output.schema.json` → `agents/<id>.schema.json`; `flow.json` → `agents/<id>.flow.json`.
 *
 * It stops, naming why, on what it can't keep: a name the root holds with other bytes, a skill or
 * server that would join a root driven by a model loop, instructions/, or any other file.
 */
import { isMap, isSeq, parseDocument, YAMLSeq } from "yaml";
import { RUNTIME_SERVER } from "../plugins/index.js";
import { AGENT_FOLDER_V4 } from "./subagent-files.js";

/** Keeps long lines as written and lists as `[a, b]`. */
const YAML_OPTIONS = { lineWidth: 0, flowCollectionPadding: false } as const;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** A folder's file as the migration reads it: its path and hash, and its text when it is one the migration edits. */
export interface FolderV4Input {
  readonly entries: readonly { readonly path: string; readonly sha256: string }[];
  /** The text of a file, for `AGENT.md` files and `mcp.json` files. */
  readonly text: (path: string) => string | undefined;
  /**
   * What each subagent has, by id, from the folder compiled as it is: its HTTP tool names, its
   * Runtime plugin tools, its skills and its servers.
   */
  readonly subagents: ReadonlyMap<string, { readonly tools: readonly string[]; readonly pluginTools: readonly string[]; readonly skills: readonly string[]; readonly servers: readonly string[] }>;
}

export type FolderV4Plan =
  | {
      readonly ok: true;
      /** Files to write, by path, with their text. */
      readonly writes: ReadonlyMap<string, string>;
      /** Files to copy, from → to. */
      readonly moves: readonly (readonly [string, string])[];
      /** Files to delete once the rest is written: every file of every subagent folder. */
      readonly deletes: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

function split(text: string): { front: string; body: string; eol: string; bom: string } | undefined {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const lines = text.slice(bom.length).split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end < 0) return undefined;
  return { front: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join(eol), eol, bom };
}

function join(parts: { front: string; body: string; eol: string; bom: string }, front: string): string {
  const lines = front.replace(/\n$/, "").split("\n");
  return parts.bom + ["---", ...lines, "---"].join(parts.eol) + parts.eol + parts.body;
}

const flowList = (items: readonly string[]) => {
  const seq = new YAMLSeq<string>();
  seq.flow = true;
  for (const item of items) seq.add(item);
  return seq;
};

/** Plans the migration of a format 3 folder to format 4. */
export function folderV4Plan(input: FolderV4Input): FolderV4Plan {
  const sha = new Map(input.entries.map((entry) => [entry.path, entry.sha256]));
  const flowRoot = sha.has("flow.json");
  const rootText = input.text("AGENT.md");
  const root = rootText === undefined ? undefined : split(rootText);
  if (!root) return { ok: false, reason: "AGENT.md has no frontmatter" };

  const ids = [...new Set(input.entries.map((entry) => entry.path.split("/")).filter((segments) => segments[0] === "agents" && segments.length >= 3).map((segments) => segments[1]!))].sort();
  const writes = new Map<string, string>();
  const moves: [string, string][] = [];
  const deletes: string[] = [];
  /** Library files after the migration, by path, with their hash. */
  const library = new Map([...sha].filter(([path]) => path === "mcp.json" || /^(tools|skills|plugins)\//.test(path)));
  const rootServers = (() => {
    const text = input.text("mcp.json");
    if (text === undefined) return {} as Record<string, unknown>;
    const value = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
    return isObject(value.mcpServers) ? { ...value.mcpServers } : {};
  })();
  const rootMcpBefore = JSON.stringify(rootServers);
  const rootDenied: string[] = [];

  for (const id of ids) {
    const prefix = `agents/${id}/`;
    const own = [...sha.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
    const where = (path: string) => `${prefix}${path}`;
    if (sha.has(`agents/${id}.md`)) return { ok: false, reason: `agents/${id}.md already exists beside ${prefix}` };
    const flow = own.includes("flow.json");
    for (const path of own) {
      if (path === "AGENT.md" || path === "output.schema.json" || (flow && path === "flow.json") || /^tools\/[^/]+\.json$/.test(path) || /^skills\//.test(path) || path === "mcp.json") continue;
      return {
        ok: false,
        reason: `${where(path)} has no place in agent-folder/4, which writes a subagent as one file: ${
          path.startsWith("instructions/") ? "join its instructions into the body of AGENT.md" : path.startsWith("agents/") ? "move a subagent driven by a flow's stages beside it by hand" : "move or remove it"
        } first`,
      };
    }
    // HTTP tools: into the root's tools/.
    for (const path of own.filter((item) => item.startsWith("tools/"))) {
      const there = library.get(path);
      if (there === sha.get(where(path))) continue;
      if (there !== undefined) return { ok: false, reason: `${where(path)} and the root's ${path} differ: a library has one tool of a name. Rename one first` };
      library.set(path, sha.get(where(path))!);
      moves.push([where(path), path]);
      if (!flowRoot) rootDenied.push(path.slice("tools/".length, -".json".length));
    }
    // Skills: into the root's skills/, which a root driven by a model loop would gain.
    const skillNames = [...new Set(own.filter((item) => item.startsWith("skills/")).map((item) => item.split("/")[1]!))];
    for (const name of skillNames) {
      const mine = own.filter((item) => item.startsWith(`skills/${name}/`));
      const theirs = [...library.keys()].filter((path) => path.startsWith(`skills/${name}/`));
      const same = theirs.length === mine.length && mine.every((path) => library.get(path) === sha.get(where(path)));
      if (same) continue;
      if (theirs.length > 0) return { ok: false, reason: `${prefix}skills/${name}/ and the root's skills/${name}/ differ: a library has one skill of a name. Rename one first` };
      if (!flowRoot)
        return { ok: false, reason: `${prefix}skills/${name}/ would join the root's skills, and the root agent would gain it: agent-folder/4 has no skill only a subagent sees. Keep this folder on agent-folder/3, or move the skill to the root first` };
      for (const path of mine) {
        library.set(path, sha.get(where(path))!);
        moves.push([where(path), path]);
      }
    }
    // Servers: into the root's mcp.json, likewise.
    if (own.includes("mcp.json")) {
      const value = JSON.parse(input.text(where("mcp.json")) ?? "{}") as { mcpServers?: Record<string, unknown> };
      for (const [key, server] of Object.entries(isObject(value.mcpServers) ? value.mcpServers : {})) {
        if (key in rootServers) {
          if (JSON.stringify(rootServers[key]) !== JSON.stringify(server))
            return { ok: false, reason: `${prefix}mcp.json and the root's mcp.json declare ${key} differently: a library has one server of a name. Rename one first` };
          continue;
        }
        if (!flowRoot)
          return { ok: false, reason: `${prefix}mcp.json's ${key} would join the root's servers, and the root agent would gain it: agent-folder/4 has no server only a subagent sees. Keep this folder on agent-folder/3, or move the server to the root first` };
        rootServers[key] = server;
      }
    }

    // The file.
    const text = input.text(where("AGENT.md"));
    const parts = text === undefined ? undefined : split(text);
    if (!parts) return { ok: false, reason: `${where("AGENT.md")} has no frontmatter` };
    const doc = parseDocument(parts.front);
    const data = (doc.toJS() ?? {}) as Record<string, unknown>;
    doc.delete("plugins");
    if (isMap(doc.get("mcpServers"))) {
      doc.deleteIn(["mcpServers", RUNTIME_SERVER]);
      if ((doc.get("mcpServers") as { items: unknown[] }).items.length === 0) doc.delete("mcpServers");
    }
    if (flow) {
      doc.set("flow", `./${id}.flow.json`);
      moves.push([where("flow.json"), `agents/${id}.flow.json`]);
    } else {
      const had = input.subagents.get(id);
      if (!had) return { ok: false, reason: `${prefix} did not compile as a subagent` };
      doc.set("tools", flowList([...had.tools, ...had.pluginTools]));
      if ([...library.keys()].some((path) => path.startsWith("skills/") || path.startsWith("plugins/"))) {
        doc.delete("skills");
        doc.set("skills", flowList(had.skills));
      } else if (isMap(doc.get("skills")) || isSeq(doc.get("skills"))) doc.delete("skills");
      const anyServers = Object.keys(rootServers).length > 0 || [...library.keys()].some((path) => path.startsWith("plugins/"));
      if (anyServers) {
        const settings = isObject(data.mcpServers) ? data.mcpServers : {};
        const kept: Record<string, unknown> = {};
        for (const key of had.servers) kept[key] = isObject(settings[key]) ? settings[key] : {};
        doc.delete("mcpServers");
        doc.set("mcpServers", doc.createNode(kept));
      }
    }
    if (data.outputSchema !== undefined) {
      const value = String(data.outputSchema);
      if (value === "./output.schema.json" || value === "output.schema.json") {
        doc.set("outputSchema", `./${id}.schema.json`);
        moves.push([where("output.schema.json"), `agents/${id}.schema.json`]);
      } else if (!value.startsWith("/")) return { ok: false, reason: `${where("AGENT.md")}'s outputSchema ${value} is a path inside the folder: write it from the root (/schemas/...) first` };
    } else if (own.includes("output.schema.json")) return { ok: false, reason: `${where("output.schema.json")} is named by nothing: remove it first` };
    writes.set(`agents/${id}.md`, join(parts, doc.toString(YAML_OPTIONS)));
    for (const path of own) deletes.push(where(path));
  }

  // The root: format 4, and the tools that moved up kept out of its own loop.
  // Edited line by line, so the rest of the root's frontmatter stays as written.
  const lines = root.front.split("\n");
  const formatAt = lines.findIndex((line) => /^format\s*:/.test(line));
  if (formatAt >= 0) lines[formatAt] = `format: ${AGENT_FOLDER_V4}`;
  else lines.unshift(`format: ${AGENT_FOLDER_V4}`);
  let front = lines.join("\n");
  if (rootDenied.length > 0) {
    const doc = parseDocument(front);
    const existing = doc.get("disallowedTools");
    if (existing === undefined) front = `${front.replace(/\n$/, "")}\ndisallowedTools: [${[...new Set(rootDenied)].join(", ")}]`;
    else {
      doc.set("disallowedTools", flowList([...new Set([...(isSeq(existing) ? (existing.toJSON() as string[]) : []), ...rootDenied])]));
      front = doc.toString(YAML_OPTIONS);
    }
  }
  writes.set("AGENT.md", join(root, front));
  if (JSON.stringify(rootServers) !== rootMcpBefore) {
    const text = input.text("mcp.json");
    const value = text === undefined ? {} : (JSON.parse(text) as Record<string, unknown>);
    writes.set("mcp.json", `${JSON.stringify({ ...value, mcpServers: rootServers }, null, 2)}\n`);
  }
  return { ok: true, writes, moves, deletes };
}
