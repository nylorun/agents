/**
 * The fix-its an agent folder's diagnostics carry (track T7, `nylorun check --fix`): a rename to
 * the one did-you-mean, CRLF line ends, and a `SKILL.md`'s `secrets` moved to `AGENT.md`, each
 * attached only where one edit fixes it; and `applyFolderFixes`, which makes them.
 */
import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { AgentFolderDiagnosticSchema } from "../src/contracts.js";
import {
  applyFolderFixes,
  compileAgentFolder,
  folderTextPaths,
  type AgentFolderDiagnostic,
  type AgentFolderEntry,
  type AgentFolderFix,
} from "../src/folder/index.js";

const encoder = new TextEncoder();

function compile(files: Record<string, string>) {
  const entries: AgentFolderEntry[] = [];
  const bytes = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) {
    const data = encoder.encode(content);
    entries.push({ path, size: data.byteLength, sha256: bytesToHex(sha256(data)) });
    bytes.set(path, data);
  }
  return compileAgentFolder({ entries, files: new Map(folderTextPaths(entries).map((path) => [path, bytes.get(path)!])) });
}

const fixes = (diagnostics: readonly AgentFolderDiagnostic[]) => diagnostics.flatMap((item) => (item.fix ? [item.fix] : []));

/** The folder with every fix-it made, and what changed. */
function fixed(files: Record<string, string>) {
  const result = applyFolderFixes(new Map(Object.entries(files)), fixes(compile(files).diagnostics));
  return { ...result, folder: { ...files, ...Object.fromEntries(result.files) } };
}

const AGENT = "---\nname: shop\ndescription: Looks up orders.\n---\nLook up the order the user names.\n";
/** A sandbox with the slots the skills' secrets name. */
const RUNTIME = JSON.stringify({
  kind: "virtual",
  secrets: Object.fromEntries(["LABELS_TOKEN", "LABELS_URL", "NOTES_TOKEN"].map((name) => [name, { type: "environment_secret", allowedHosts: ["labels.example.com"] }])),
});
const SKILL = (extra = "") => `---\nname: labels\ndescription: Pick a label.\n${extra}---\nUse the house labels.\n`;

describe("agent folders: fix-its on diagnostics", () => {
  it("renames an unknown key to its one did-you-mean, at the key, with the message as it was", () => {
    const result = compile({ "AGENT.md": "---\nname: shop\ndescription: Orders.\nmemmory: { access: read_only }\n---\nGo.\n" });
    expect(result.diagnostics).toContainEqual({
      severity: "error",
      code: "unknown_key",
      message: "Unknown key 'memmory'. Did you mean 'memory'?",
      file: "AGENT.md",
      line: 4,
      column: 1,
      fix: { kind: "rename_key", file: "AGENT.md", line: 4, column: 1, from: "memmory", to: "memory" },
    });
    for (const item of result.diagnostics) expect(AgentFolderDiagnosticSchema.safeParse(item).success).toBe(true);
  });

  it("attaches no rename with two keys as close, or when the key it would be is already there", () => {
    // tputSchema is two edits from inputSchema and from outputSchema.
    const tie = compile({ "AGENT.md": "---\nname: shop\ndescription: Orders.\ntputSchema: { type: object }\n---\nGo.\n" });
    expect(tie.diagnostics).toContainEqual(expect.objectContaining({ code: "unknown_key", message: "Unknown key 'tputSchema'. Did you mean 'inputSchema'?" }));
    expect(fixes(tie.diagnostics)).toEqual([]);
    const twice = compile({ "AGENT.md": "---\nname: shop\ndescription: Orders.\nmemory: {}\nmemmory: {}\n---\nGo.\n" });
    expect(twice.diagnostics).toContainEqual(expect.objectContaining({ code: "unknown_key", message: "Unknown key 'memmory'. Did you mean 'memory'?" }));
    expect(fixes(twice.diagnostics)).toEqual([]);
    const far = compile({ "AGENT.md": "---\nname: shop\ndescription: Orders.\nzzzzzz: 1\n---\nGo.\n" });
    expect(fixes(far.diagnostics)).toEqual([]);
  });

  it("renames in every file the compiler checks keys of: frontmatter, nested maps, JSON and schemas", () => {
    const rename = (files: Record<string, string>) => fixes(compile({ "AGENT.md": AGENT, ...files }).diagnostics).filter((fix) => fix.kind === "rename_key");
    expect(rename({ "AGENT.md": "---\nname: shop\ndescription: Orders.\nmemory:\n  acess: read_only\n---\nGo.\n" })).toEqual([
      { kind: "rename_key", file: "AGENT.md", line: 5, column: 3, from: "acess", to: "access" },
    ]);
    expect(rename({ "triggers/daily.md": '---\nschedule: "0 9 * * *"\nsesion: new\n---\nGo.\n' })).toEqual([
      { kind: "rename_key", file: "triggers/daily.md", line: 3, column: 1, from: "sesion", to: "session" },
    ]);
    expect(rename({ "skills/labels/SKILL.md": SKILL("licence: MIT\n") })).toEqual([
      { kind: "rename_key", file: "skills/labels/SKILL.md", line: 4, column: 1, from: "licence", to: "license" },
    ]);
    expect(rename({ "tools/get_order.json": '{\n  "descripton": "One order.",\n  "inputSchema": { "type": "object" },\n  "http": { "url": "https://shop.example.com/o" }\n}\n' })).toEqual([
      { kind: "rename_key", file: "tools/get_order.json", line: 2, column: 3, from: "descripton", to: "description" },
    ]);
    expect(rename({ "runtime.json": '{ "knd": "none" }' })).toEqual([{ kind: "rename_key", file: "runtime.json", line: 1, column: 3, from: "knd", to: "kind" }]);
    expect(rename({ "mcp.json": '{ "mcpServers": { "docs": { "type": "sse", "ulr": "https://docs.example.com/sse" } } }' })).toEqual([
      { kind: "rename_key", file: "mcp.json", line: 1, column: 44, from: "ulr", to: "url" },
    ]);
    expect(rename({ "out.schema.json": '{ "type": "object", "proprties": {} }', "AGENT.md": "---\nname: shop\ndescription: Orders.\noutputSchema: ./out.schema.json\n---\nGo.\n" })).toEqual([
      { kind: "rename_key", file: "out.schema.json", line: 1, column: 21, from: "proprties", to: "properties" },
    ]);
  });

  it("renames in flow.json and in a subagent's folder, by its path in the uploaded folder", () => {
    const agent = (name: string, extra = "") => `---\nname: ${name}\ndescription: Does ${name}.\n${extra}---\nDo it.\n`;
    const flow = compile({ "AGENT.md": "---\nname: brief\ndescription: Writes a brief.\n---\n", "flow.json": '{ "chian": [] }', "agents/writer/AGENT.md": agent("writer") });
    expect(fixes(flow.diagnostics)).toContainEqual({ kind: "rename_key", file: "flow.json", line: 1, column: 3, from: "chian", to: "chain" });
    const nested = compile({ "AGENT.md": AGENT, "agents/research/AGENT.md": agent("research", "memmory: {}\n") });
    expect(fixes(nested.diagnostics)).toEqual([{ kind: "rename_key", file: "agents/research/AGENT.md", line: 4, column: 1, from: "memmory", to: "memory" }]);
  });

  it("notes CRLF line ends with their fix, and compiles the same manifest as LF", () => {
    const lf = { "AGENT.md": AGENT, "triggers/daily.md": '---\nschedule: "0 9 * * *"\nsession: new\n---\nGo.\n' };
    const crlf = { ...lf, "AGENT.md": AGENT.replace(/\n/g, "\r\n") };
    const result = compile(crlf);
    expect(result.manifest).toEqual(compile(lf).manifest);
    expect(result.diagnostics).toEqual([
      { severity: "note", code: "crlf", message: "The file has CRLF line ends, read as LF. Fix: save it with LF line ends", file: "AGENT.md", fix: { kind: "crlf", file: "AGENT.md" } },
    ]);
    expect(compile(lf).diagnostics).toEqual([]);
  });

  it("moves a SKILL.md's secrets to AGENT.md, only where AGENT.md lists none for the skill or all of them", () => {
    const skill = { "skills/labels/SKILL.md": SKILL("secrets: [LABELS_TOKEN]\n") };
    const result = compile({ "AGENT.md": AGENT, ...skill });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "skill_secrets",
        file: "skills/labels/SKILL.md",
        line: 4,
        fix: { kind: "move_skill_secrets", file: "skills/labels/SKILL.md", skill: "labels", secrets: ["LABELS_TOKEN"] },
      }),
    );
    const listing = (secrets: string) => `---\nname: shop\ndescription: Orders.\nskills:\n  labels:\n    secrets: ${secrets}\n---\nGo.\n`;
    expect(fixes(compile({ "AGENT.md": listing("[LABELS_TOKEN, OTHER]"), ...skill }).diagnostics)).toHaveLength(1);
    expect(fixes(compile({ "AGENT.md": listing("[OTHER]"), ...skill }).diagnostics)).toEqual([]);
    expect(fixes(compile({ "AGENT.md": AGENT, "skills/labels/SKILL.md": SKILL("secrets: lowercase-name\n") }).diagnostics)).toEqual([]);
    // Only the root agent's skills get secrets.
    const nested = compile({ "AGENT.md": AGENT, "agents/research/AGENT.md": AGENT.replace("shop", "research"), "agents/research/skills/labels/SKILL.md": SKILL("secrets: [A]\n") });
    expect(nested.diagnostics).toContainEqual(expect.objectContaining({ code: "skill_secrets", file: "agents/research/skills/labels/SKILL.md" }));
    expect(fixes(nested.diagnostics)).toEqual([]);
  });
});

describe("agent folders: applyFolderFixes", () => {
  it("renames the key token only, keeping every other byte, in YAML and JSON", () => {
    const files = {
      "AGENT.md": "---\nname: shop   # the name\ndescription: Orders.\n'memmory' :   { access: read_only }  # memory\n---\nGo.\r\n",
      "tools/t.json": '{\n  "inputSchema": {"type":"object"},\t"htp" : { "url": "https://shop.example.com/t" }\n}',
    };
    const result = fixed(files);
    expect(result.skipped).toEqual([]);
    expect(result.folder["AGENT.md"]).toBe("---\nname: shop   # the name\ndescription: Orders.\n'memory' :   { access: read_only }  # memory\n---\nGo.\n");
    expect(result.folder["tools/t.json"]).toBe('{\n  "inputSchema": {"type":"object"},\t"http" : { "url": "https://shop.example.com/t" }\n}');
    expect(result.changes).toEqual([
      { file: "AGENT.md", change: "CRLF line ends made LF" },
      { file: "AGENT.md", change: "renamed 'memmory' to 'memory' at line 4" },
      { file: "tools/t.json", change: "renamed 'htp' to 'http' at line 2" },
    ]);
    expect(compile(result.folder).diagnostics).toEqual([]);
    // Fixed once, there is nothing left to fix.
    expect(fixed(result.folder).files.size).toBe(0);
  });

  it("makes two renames on one line, and skips a rename whose key is no longer there", () => {
    const fixes: AgentFolderFix[] = [
      { kind: "rename_key", file: "a.json", line: 1, column: 3, from: "ab", to: "abc" },
      { kind: "rename_key", file: "a.json", line: 1, column: 12, from: "cd", to: "c" },
      { kind: "rename_key", file: "a.json", line: 1, column: 3, from: "zz", to: "z" },
    ];
    const result = applyFolderFixes(new Map([["a.json", '{ "ab": 1, "cd": 2 }']]), fixes);
    expect(result.files.get("a.json")).toBe('{ "abc": 1, "c": 2 }');
    expect(result.skipped).toEqual([{ fix: fixes[2], reason: "'zz' is no longer at line 1, column 3: check again" }]);
  });

  it("moves secrets as migrate folder writes them: a new skills block, the skill's entry, or the skill's settings", () => {
    const skill = SKILL("secrets:\n  - LABELS_TOKEN\n  - LABELS_URL\nlicense: MIT\n");
    const fresh = fixed({ "AGENT.md": AGENT, "skills/labels/SKILL.md": skill, "runtime.json": RUNTIME });
    expect(fresh.folder["skills/labels/SKILL.md"]).toBe(SKILL("license: MIT\n"));
    expect(fresh.folder["AGENT.md"]).toBe(
      "---\nname: shop\ndescription: Looks up orders.\nskills:\n  labels:\n    secrets:\n      - LABELS_TOKEN\n      - LABELS_URL\n---\nLook up the order the user names.\n",
    );
    expect(fresh.changes).toEqual([
      { file: "skills/labels/SKILL.md", change: "secrets moved to AGENT.md's skills block" },
      { file: "AGENT.md", change: "skills.labels.secrets: LABELS_TOKEN, LABELS_URL, from skills/labels/SKILL.md" },
    ]);
    const compiled = compile(fresh.folder);
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.manifest!.harness.skills!.labels!.secrets).toEqual(["LABELS_TOKEN", "LABELS_URL"]);

    const other = SKILL().replace(/labels/g, "notes");
    const beside = fixed({
      "AGENT.md": "---\nname: shop\ndescription: Orders.\nskills:\n    notes:\n        secrets: [NOTES_TOKEN]\nmetadata: { team: ops }\n---\nGo.\n",
      "skills/labels/SKILL.md": SKILL("secrets: [LABELS_TOKEN]\n"),
      "skills/notes/SKILL.md": other,
      "runtime.json": RUNTIME,
    });
    expect(beside.folder["AGENT.md"]).toBe(
      "---\nname: shop\ndescription: Orders.\nskills:\n    notes:\n        secrets: [NOTES_TOKEN]\n    labels:\n      secrets:\n        - LABELS_TOKEN\nmetadata: { team: ops }\n---\nGo.\n",
    );
    expect(compile(beside.folder).manifest!.harness.skills!.labels!.secrets).toEqual(["LABELS_TOKEN"]);

    const settings = fixed({ "AGENT.md": "---\nname: shop\ndescription: Orders.\nskills:\n  labels:\n    other: 1\n---\nGo.\n", "skills/labels/SKILL.md": SKILL("secrets: [LABELS_TOKEN]\n") });
    expect(settings.folder["AGENT.md"]).toBe("---\nname: shop\ndescription: Orders.\nskills:\n  labels:\n    other: 1\n    secrets:\n      - LABELS_TOKEN\n---\nGo.\n");

    // Listed in AGENT.md already: the SKILL.md loses them, and AGENT.md stays.
    const listed = "---\nname: shop\ndescription: Orders.\nskills:\n  labels:\n    secrets: [LABELS_TOKEN]\n---\nGo.\n";
    const same = fixed({ "AGENT.md": listed, "skills/labels/SKILL.md": SKILL("secrets: [LABELS_TOKEN]\n"), "runtime.json": RUNTIME });
    expect([...same.files.keys()]).toEqual(["skills/labels/SKILL.md"]);
    expect(compile(same.folder).diagnostics).toEqual([]);
  });

  it("skips a move it cannot make line by line, and one whose secrets changed", () => {
    const fix: AgentFolderFix = { kind: "move_skill_secrets", file: "skills/labels/SKILL.md", skill: "labels", secrets: ["LABELS_TOKEN"] };
    const flow = applyFolderFixes(
      new Map([
        ["AGENT.md", "---\nname: shop\ndescription: Orders.\nskills: { notes: {} }\n---\nGo.\n"],
        ["skills/labels/SKILL.md", SKILL("secrets: [LABELS_TOKEN]\n")],
      ]),
      [fix],
    );
    expect(flow.files.size).toBe(0);
    expect(flow.skipped[0]!.reason).toContain("AGENT.md's skills is not a block of key: value lines");
    const changed = applyFolderFixes(new Map([["AGENT.md", AGENT], ["skills/labels/SKILL.md", SKILL("secrets: [OTHER]\n")]]), [fix]);
    expect(changed.skipped).toEqual([{ fix, reason: "skills/labels/SKILL.md's secrets are not the ones checked: check again" }]);
  });
});
