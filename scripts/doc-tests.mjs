#!/usr/bin/env node
/**
 * Doc tests: checks the code blocks of the repository's Markdown that carry a doc-test marker,
 * without a Runtime, against the built packages (`npm run build` first). A marker is an HTML
 * comment on the line before a fenced code block, so it does not show where the Markdown is read:
 *
 *   <!-- doc-test: folder <name> <path> -->
 *     The block is the file <path> of the agent folder <name> (folders are per Markdown file, so
 *     the blocks of one folder may be spread over a page). Each folder is written to a temporary
 *     directory, packed (`packFolder`) and compiled offline (`checkFolder`), as `nylorun check`
 *     does: it must compile with no error.
 *   <!-- doc-test: tool-policy -->
 *     The block's tool policy rules (a `rules: [...]` list in JSON, TypeScript or a shell command,
 *     or the block as one rule or a list of rules) must each be a rule the Runtime takes
 *     (`ToolRuleSchema` of `@nylorun/core/contracts`). `tool-policy refused` asserts the opposite
 *     for a "before" example: at least one rule is refused.
 *   <!-- doc-test: typescript -->
 *     The block, a self-contained module, typechecks (strict, NodeNext) against the built packages.
 *
 * Markers may stack above one block. Blocks without a marker are not checked. A marker that is not followed by a code block, or
 * that names no known check, fails. `node scripts/doc-tests.mjs [file.md...]` checks the files
 * named, else every Markdown file of the repository except changelogs and changesets.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

export const root = fileURLToPath(new URL("../", import.meta.url));

const MARKER = /^\s*<!--\s*doc-test:\s*(.*?)\s*-->\s*$/u;
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)(.*)$/u;

/**
 * The marked code blocks of a Markdown text: `{ check, args, lang, text, line }`, `line` being
 * the block's first line (1-based). Problems with the markers themselves are in `problems`.
 */
export function markedBlocks(markdown) {
  const lines = markdown.split(/\r?\n/u);
  const blocks = [];
  const problems = [];
  let pending = []; // the markers above the next line: { words, line }
  const unfollowed = () => {
    for (const marker of pending) problems.push({ line: marker.line, message: "doc-test marker is not followed by a code block" });
    pending = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = FENCE.exec(line);
    if (fence) {
      const [, indent, run, lang] = fence;
      const body = [];
      let end = index + 1;
      for (; end < lines.length; end++) {
        const closing = lines[end].trim();
        if (closing.startsWith(run[0].repeat(run.length)) && /^[`~]+$/u.test(closing)) break;
        // Content is indented like its fence (a block in a list item): take that indent off.
        body.push(lines[end].startsWith(indent) ? lines[end].slice(indent.length) : lines[end].trimStart());
      }
      // Several markers may stack above one block, each a check of its own.
      for (const marker of pending) {
        const [check, ...args] = marker.words;
        blocks.push({ check, args, lang, text: `${body.join("\n")}\n`, line: index + 2, marker: marker.line });
      }
      pending = [];
      index = end;
      continue;
    }
    const marker = MARKER.exec(line);
    if (marker) pending.push({ words: marker[1].split(/\s+/u).filter(Boolean), line: index + 1 });
    else if (line.trim() !== "") unfollowed();
  }
  unfollowed();
  return { blocks, problems };
}

/** The text of the bracketed literal that opens at `start`, skipping strings and comments. */
function bracketed(text, start) {
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  for (let at = start; at < text.length; at++) {
    const char = text[at];
    if (char === '"' || char === "'" || char === "`") {
      for (at++; at < text.length && text[at] !== char; at++) if (text[at] === "\\") at++;
    } else if (char === "/" && text[at + 1] === "/") {
      while (at < text.length && text[at] !== "\n") at++;
    } else if (char === "/" && text[at + 1] === "*") {
      at = text.indexOf("*/", at + 2);
      if (at < 0) break;
      at++;
    } else if (char === open) depth++;
    else if (char === close && --depth === 0) return text.slice(start, at + 1);
  }
  throw new Error(`the literal at offset ${start} does not close`);
}

/**
 * The tool policy rules a block shows: its `rules: [...]` list (JSON, TypeScript or a shell
 * command's JSON body), else the block itself as a rule or a list of rules. The literal is
 * evaluated with nothing in scope, so a rule must be written out, not computed.
 */
export function rulesOf(text) {
  const key = /["']?rules["']?\s*:\s*\[/u.exec(text);
  const literal = key ? bracketed(text, key.index + key[0].length - 1) : text.trim();
  let value;
  try {
    value = vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1000 });
  } catch (error) {
    throw new Error(`its rules are not a literal list (${error.message})`);
  }
  const rules = Array.isArray(value) ? value : Array.isArray(value?.rules) ? value.rules : [value];
  return JSON.parse(JSON.stringify(rules));
}

/** What is wrong with each rule, by its index: an empty list when the Runtime takes every rule. */
export async function toolRuleIssues(rules) {
  const { ToolRuleSchema } = await import("@nylorun/core/contracts");
  return rules.flatMap((rule, index) => {
    const parsed = ToolRuleSchema.safeParse(rule);
    return parsed.success
      ? []
      : [`rule ${index + 1} ${JSON.stringify(rule)}: ${parsed.error.issues.map((issue) => `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`).join("; ")}`];
  });
}

async function checkToolPolicy(block) {
  const refused = block.args.includes("refused");
  const unknown = block.args.filter((arg) => arg !== "refused");
  if (unknown.length > 0) return [`tool-policy takes no argument but "refused", not ${unknown.join(" ")}`];
  let rules;
  try {
    rules = rulesOf(block.text);
  } catch (error) {
    return [`tool-policy block: ${error.message}`];
  }
  if (rules.length === 0) return ["tool-policy block holds no rule"];
  const issues = await toolRuleIssues(rules);
  if (refused) return issues.length > 0 ? [] : ["tool-policy block is marked refused, but the Runtime takes every rule"];
  return issues.map((issue) => `tool policy ${issue}`);
}

/** Compiles each agent folder the blocks of one Markdown file write; every error, by block. */
async function checkFolders(folders) {
  const { checkFolder, packFolder, diagnosticLine } = await import("@nylorun/agents");
  const failures = [];
  const scratch = await mkdtemp(join(tmpdir(), "nylorun-doc-tests-"));
  try {
    for (const [name, files] of folders) {
      const dir = join(scratch, name);
      for (const [path, block] of files) {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), block.text);
      }
      const compiled = await checkFolder(await packFolder(dir));
      const first = [...files.values()][0];
      for (const diagnostic of compiled.diagnostics.filter((d) => d.severity === "error")) {
        const block = (diagnostic.file && files.get(diagnostic.file)) || first;
        failures.push({ line: block.line, message: `agent folder ${name}: ${diagnosticLine(diagnostic)}` });
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return failures;
}

/** Typechecks the marked TypeScript blocks together; each error at its Markdown line. */
async function checkTypeScript(blocks) {
  if (blocks.length === 0) return [];
  // Inside the repository, so the blocks resolve `@nylorun/*` from its node_modules (`.tmp/` is ignored).
  const dir = join(root, ".tmp", `doc-tests-${process.pid}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const files = blocks.map((block, index) => ({ ...block, file: `block-${index}.ts` }));
  await writeFile(join(dir, "package.json"), `${JSON.stringify({ type: "module", private: true })}\n`);
  await writeFile(
    join(dir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2024",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["node"],
        },
        files: files.map((block) => block.file),
      },
      null,
      2,
    )}\n`,
  );
  // Each block is a module of its own, so two blocks may declare the same name.
  for (const block of files)
    await writeFile(join(dir, block.file), /^\s*(import|export)\s/mu.test(block.text) ? block.text : `${block.text}export {};\n`);
  const tsc = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  if (!existsSync(tsc)) return [{ doc: files[0].doc, line: files[0].line, message: "tsc is missing: run npm run setup" }];
  const result = spawnSync(tsc, ["-p", join(dir, "tsconfig.json"), "--pretty", "false"], { encoding: "utf8" });
  const failures = [];
  for (const line of `${result.stdout}${result.stderr}`.split("\n")) {
    const match = /(block-(\d+)\.ts)\((\d+),(\d+)\): error (TS\d+: .*)$/u.exec(line);
    if (match) {
      const block = files[Number(match[2])];
      failures.push({ doc: block.doc, line: block.line + Number(match[3]) - 1, message: `TypeScript ${match[5]}` });
    } else if (line.trim() !== "" && result.status !== 0 && !/block-\d+\.ts/u.test(line))
      failures.push({ doc: files[0].doc, line: files[0].line, message: `tsc: ${line.trim()}` });
  }
  if (result.status !== 0 && failures.length === 0)
    failures.push({ doc: files[0].doc, line: files[0].line, message: `tsc exited ${result.status}` });
  await rm(dir, { recursive: true, force: true });
  return failures;
}

/** Every Markdown file of the repository that may carry a doc test. */
function markdownFiles() {
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.md"], {
    cwd: root,
    encoding: "utf8",
  });
  return listed
    .split("\0")
    .filter((path) => path && existsSync(join(root, path)))
    .filter((path) => !/(^|\/)(CHANGELOG\.md|node_modules\/)/u.test(path) && !/^\.(changeset|claude)\//u.test(path))
    .sort();
}

/** Runs the doc tests of `paths` (relative to the repository); the failures and the counts. */
export async function docTests(paths = markdownFiles()) {
  const failures = [];
  const counts = { files: 0, folders: 0, "tool-policy": 0, typescript: 0 };
  const typescript = [];
  for (const path of paths) {
    const doc = relative(root, resolve(root, path));
    const { blocks, problems } = markedBlocks(await readFile(join(root, doc), "utf8"));
    for (const problem of problems) failures.push({ doc, ...problem });
    if (blocks.length > 0) counts.files++;
    const folders = new Map();
    for (const block of blocks) {
      if (block.check === "folder") {
        const [name, path, ...rest] = block.args;
        if (!name || !path || rest.length > 0 || path.startsWith("/") || path.split("/").includes("..")) {
          failures.push({ doc, line: block.marker, message: "use <!-- doc-test: folder <name> <path> --> with a path inside the folder" });
          continue;
        }
        if (!folders.has(name)) folders.set(name, new Map());
        if (folders.get(name).has(path)) failures.push({ doc, line: block.marker, message: `agent folder ${name} has ${path} twice` });
        folders.get(name).set(path, block);
      } else if (block.check === "tool-policy") {
        counts["tool-policy"]++;
        for (const message of await checkToolPolicy(block)) failures.push({ doc, line: block.line, message });
      } else if (block.check === "typescript") {
        if (block.args.length > 0) failures.push({ doc, line: block.marker, message: "typescript takes no argument" });
        typescript.push({ ...block, doc });
      } else failures.push({ doc, line: block.marker, message: `unknown doc-test check "${block.check ?? ""}" (folder, tool-policy or typescript)` });
    }
    counts.folders += folders.size;
    for (const failure of await checkFolders(folders)) failures.push({ doc, ...failure });
  }
  counts.typescript = typescript.length;
  failures.push(...(await checkTypeScript(typescript)));
  return { failures, counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { failures, counts } = await docTests(process.argv.length > 2 ? process.argv.slice(2) : undefined);
  for (const failure of failures) console.error(`${failure.doc}:${failure.line}: ${failure.message}`);
  const summary = `${counts.folders} agent folders, ${counts["tool-policy"]} tool policies and ${counts.typescript} TypeScript blocks in ${counts.files} Markdown files`;
  if (failures.length > 0) {
    console.error(`Doc tests failed: ${failures.length} ${failures.length === 1 ? "problem" : "problems"} in ${summary}.`);
    process.exitCode = 1;
  } else console.log(`Doc tests passed: ${summary}.`);
}
