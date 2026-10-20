import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  diagnosticPlace,
  diffSummary,
  fileText,
  folderName,
  FolderRefusedError,
  FOLDER_MEDIA_TYPE,
  hashFolder,
  pickedFolder,
  planChangeLines,
  planHeadline,
  sendFolder,
  sha256Hex,
  sortedDiagnostics,
  sourceTree,
  uploadMissing,
} from "../web/src/agent-folder.ts";

const encoder = new TextEncoder();
const hex = (text) => createHash("sha256").update(text).digest("hex");

/** A file as `<input webkitdirectory>` gives it. */
const browserFile = (path, text) => {
  const bytes = encoder.encode(text);
  return {
    webkitRelativePath: path,
    name: path.split("/").at(-1),
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.slice().buffer,
  };
};

const AGENT = "---\nname: triage\ndescription: Triage issues.\n---\nTriage the issue.\n";

test("a picked folder is its files by path inside it, sorted, without .git, .hg, .svn and node_modules", () => {
  const folder = pickedFolder([
    browserFile("triage/mcp.json", "{}"),
    browserFile("triage/AGENT.md", AGENT),
    browserFile("triage/.git/HEAD", "ref"),
    browserFile("triage/skills/notes/node_modules/x/index.js", "x"),
    browserFile("triage/skills/notes/SKILL.md", "---\nname: notes\n---\n"),
    browserFile("triage/.svn/entries", "e"),
    browserFile("triage/.gitignore", "dist\n"),
  ]);
  assert.equal(folder.dir, "triage");
  assert.deepEqual(
    folder.files.map((file) => file.path),
    [".gitignore", "AGENT.md", "mcp.json", "skills/notes/SKILL.md"],
  );
  assert.equal(folder.skipped, 3);
});

test("files hash to the SHA-256 the Runtime checks, with AGENT.md's text kept for the name", async () => {
  assert.equal(await sha256Hex(encoder.encode("abc")), hex("abc"));
  assert.equal(await sha256Hex(new Uint8Array()), hex(""));
  const seen = [];
  const hashed = await hashFolder(
    pickedFolder([browserFile("triage/AGENT.md", AGENT), browserFile("triage/README.md", "# Triage\n")]),
    (done, total) => seen.push(`${done}/${total}`),
  );
  assert.deepEqual(hashed.entries, [
    { path: "AGENT.md", size: encoder.encode(AGENT).byteLength, sha256: hex(AGENT) },
    { path: "README.md", size: 9, sha256: hex("# Triage\n") },
  ]);
  assert.deepEqual(seen, ["1/2", "2/2"]);
  assert.equal(hashed.agentMd, AGENT);
  assert.deepEqual(await hashed.bytesOf.get(hex("# Triage\n"))(), encoder.encode("# Triage\n"));
});

test("the manifest is named by AGENT.md's frontmatter, else by its directory", () => {
  assert.equal(folderName(AGENT, "dir"), "triage");
  assert.equal(folderName('﻿---\r\ndescription: x\r\nname: "repo-brief"  # the flow\r\n---\r\nBody\r\n', "dir"), "repo-brief");
  assert.equal(folderName("---\nname: 'quoted'\n---\n", "dir"), "quoted");
  assert.equal(folderName("No frontmatter.\nname: not-this\n", "support"), "support");
  assert.equal(folderName("---\ndescription: none\n---\n", "support"), "support");
  assert.equal(folderName(undefined, "support"), "support");
});

test("only the files the Runtime does not hold are uploaded, once per hash", async () => {
  const held = new Set([`sha256:${hex("same")}`]);
  const calls = [];
  const runtime = {
    has: async (sha256) => (calls.push(`HEAD ${sha256}`), held.has(sha256)),
    upload: async (bytes, sha256) => {
      calls.push(`PUT ${sha256} ${new TextDecoder().decode(bytes)}`);
      held.add(sha256);
    },
    fetch: async () => assert.fail("no save"),
  };
  const folder = await hashFolder(
    pickedFolder([
      browserFile("f/AGENT.md", AGENT),
      browserFile("f/a.txt", "same"),
      browserFile("f/b.txt", "new"),
      browserFile("f/c.txt", "new"),
    ]),
  );
  assert.equal(await uploadMissing(runtime, folder), 2);
  assert.deepEqual(calls, [
    `HEAD sha256:${hex(AGENT)}`,
    `PUT sha256:${hex(AGENT)} ${AGENT}`,
    `HEAD sha256:${hex("same")}`,
    `HEAD sha256:${hex("new")}`,
    `PUT sha256:${hex("new")} new`,
  ]);
  calls.length = 0;
  assert.equal(await uploadMissing(runtime, folder), 0, "a second upload uploads nothing");
  assert.equal(calls.filter((call) => call.startsWith("PUT")).length, 0);
});

test("a folder is sent by hash as the folder media type: the plan with dryRun, the save under If-Match", async () => {
  const sent = [];
  const plan = { name: "triage", from: 2, to: 3, unchanged: false, changes: [], warnings: [], errors: [], behind: 0, moves: { now: 1, nextStart: 0, secrets: 0 } };
  const runtime = {
    has: async () => true,
    upload: async () => {},
    fetch: async (path, init) => {
      sent.push({ path, init });
      return Response.json(path.endsWith("?dryRun=true") ? plan : { manifest: { name: "triage", version: 3 }, unchanged: false, warnings: [] });
    },
  };
  const entries = [{ path: "AGENT.md", size: 3, sha256: "a".repeat(64), extra: true }];
  assert.deepEqual(await sendFolder(runtime, "triage", entries, { dryRun: true }), plan);
  const saved = await sendFolder(runtime, "triage", entries, { ifMatch: 2 });
  assert.equal(saved.manifest.version, 3);
  assert.deepEqual(
    sent.map(({ path, init }) => `${init.method} ${path} ${init.headers["content-type"]} ${init.headers["if-match"] ?? "-"}`),
    [
      `PUT /v1/agent-manifests/triage?dryRun=true ${FOLDER_MEDIA_TYPE} -`,
      `PUT /v1/agent-manifests/triage ${FOLDER_MEDIA_TYPE} 2`,
    ],
  );
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.format, "nylorun.folder.v2");
  assert.equal(typeof body.requestId, "string");
  assert.deepEqual(body.entries, [{ path: "AGENT.md", size: 3, sha256: "a".repeat(64) }]);
});

test("a refused folder carries the Runtime's code, message and the compiler's diagnostics", async () => {
  const diagnostics = [{ severity: "error", code: "key_unknown", message: "Unknown key netwrk", file: "runtime.json", line: 3, column: 3 }];
  const runtime = {
    has: async () => true,
    upload: async () => {},
    fetch: async () =>
      Response.json({ message: "Agent folder triage does not compile", code: "folder_invalid", details: { diagnostics } }, { status: 422 }),
  };
  await assert.rejects(sendFolder(runtime, "triage", [], { dryRun: true }), (error) => {
    assert.ok(error instanceof FolderRefusedError);
    assert.equal(error.status, 422);
    assert.equal(error.code, "folder_invalid");
    assert.equal(error.message, "Agent folder triage does not compile");
    assert.deepEqual(error.diagnostics, diagnostics);
    return true;
  });
  const bare = { ...runtime, fetch: async () => new Response("bad gateway", { status: 502 }) };
  await assert.rejects(sendFolder(bare, "triage", [], {}), /refused the folder \(502\)/);
});

test("the plan renders as a diff: + added, - removed, ~ replaced, by section and path", () => {
  const lines = planChangeLines([
    { section: "manifest", path: "description", op: "replace", from: "Old.", to: "New." },
    { section: "harness", path: "mcpServers.github", op: "add", to: { url: "https://api.githubcopilot.com/mcp/" } },
    { section: "harness", path: "tools.lookup", op: "remove", from: { http: { url: "https://x" } } },
    { section: "runtime", path: "", op: "add", to: { kind: "virtual" } },
    { section: "runtime", path: "kind", op: "replace", from: "virtual", to: "pod" },
    { section: "harness", path: "instructions", op: "replace", from: ["a".repeat(60)], to: ["b"] },
  ]);
  assert.deepEqual(
    lines.map((line) => `${line.mark} ${line.field}  ${line.text}`),
    [
      '~ description  "Old." → "New."',
      '+ harness.mcpServers.github  {"url":"https://api.githubcopilot.com/mcp/"}',
      '- harness.tools.lookup  {"http":{"url":"https://x"}}',
      '+ runtime  {"kind":"virtual"}',
      '~ runtime.kind  "virtual" → "pod"',
      `~ harness.instructions  ["${"a".repeat(35)}… → ["b"]`,
    ],
  );
  const base = { name: "triage", from: 2, to: 3, unchanged: false, errors: [] };
  assert.equal(planHeadline(base), "Saves v3 of triage, over v2");
  assert.equal(planHeadline({ ...base, from: null, to: 1 }), "Saves triage v1, a new manifest");
  assert.equal(planHeadline({ ...base, unchanged: true, to: 2 }), "Unchanged: v2 already holds this manifest");
  assert.equal(planHeadline({ ...base, errors: ["a", "b"] }), "Not saved: 2 errors");
});

test("diagnostics read errors first, each at its file, line and column", () => {
  const sorted = sortedDiagnostics([
    { severity: "note", code: "file_not_compiled", message: "Kept with the source", file: "README.md" },
    { severity: "warning", code: "secret_literal", message: "A token", file: "mcp.json", line: 6, column: 9 },
    { severity: "error", code: "key_unknown", message: "Unknown", file: "runtime.json", line: 3, column: 3 },
    { severity: "error", code: "key_unknown", message: "Earlier", file: "runtime.json", line: 2 },
  ]);
  assert.deepEqual(
    sorted.map((item) => `${item.severity} ${diagnosticPlace(item)} ${item.message}`),
    [
      "error runtime.json:2 Earlier",
      "error runtime.json:3:3 Unknown",
      "warning mcp.json:6:9 A token",
      "note README.md Kept with the source",
    ],
  );
  assert.equal(diagnosticPlace({ severity: "error", code: "x", message: "m" }), "");
});

test("a version's source is a tree, directories first, its files marked against the version before", () => {
  const entries = [
    { path: "AGENT.md", size: 120, sha256: "1" },
    { path: "mcp.json", size: 80, sha256: "2" },
    { path: "skills/notes/SKILL.md", size: 40, sha256: "3" },
    { path: "skills/notes/data/a.csv", size: 10, sha256: "4" },
    { path: "files/seed.txt", size: 5, sha256: "5" },
  ];
  const rows = sourceTree(entries, {
    added: [{ path: "files/seed.txt", size: 5, sha256: "5" }],
    changed: [{ path: "AGENT.md", from: { size: 100, sha256: "0" }, to: { size: 120, sha256: "1" } }],
  });
  assert.deepEqual(
    rows.map((row) => `${"  ".repeat(row.depth)}${row.kind === "dir" ? `${row.name}/` : row.name}${row.change ? ` (${row.change})` : ""}`),
    [
      "files/",
      "  seed.txt (added)",
      "skills/",
      "  notes/",
      "    data/",
      "      a.csv",
      "    SKILL.md",
      "AGENT.md (changed)",
      "mcp.json",
    ],
  );
  assert.equal(rows.find((row) => row.name === "a.csv").path, "skills/notes/data/a.csv");
  assert.equal(rows.find((row) => row.name === "a.csv").size, 10);
  const diff = (changed, added, removed) => ({ name: "t", from: 2, to: 3, changed, added, removed, unchanged: 0 });
  assert.equal(diffSummary(diff([], [], [])), "Same files as v2");
  assert.equal(diffSummary(diff([{}], [], [])), "1 changed since v2");
  assert.equal(diffSummary(diff([{}, {}], [{}], [{}])), "2 changed, 1 added and 1 removed since v2");
});

test("a file is text when it decodes as UTF-8 and holds no NUL; a preview may end inside a character", () => {
  assert.equal(fileText(encoder.encode("héllo")), "héllo");
  assert.equal(fileText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00])), undefined);
  assert.equal(fileText(new Uint8Array([0xff, 0xfe, 0x41])), undefined);
  const cut = encoder.encode("é").slice(0, 1);
  assert.equal(fileText(cut), undefined);
  assert.equal(fileText(cut, true), "");
});
