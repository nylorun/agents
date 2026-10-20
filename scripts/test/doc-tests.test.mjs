// The doc tests (scripts/doc-tests.mjs) against Markdown written here. They need the built
// packages: @nylorun/core for the tool policy schema, @nylorun/agents for agent folders.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { docTests, markedBlocks, rulesOf } from "../doc-tests.mjs";

const fence = "```";

async function run(markdown) {
  const dir = mkdtempSync(join(tmpdir(), "doc-tests-"));
  try {
    const file = join(dir, "page.md");
    writeFileSync(file, markdown);
    return await docTests([file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("finds marked blocks only, stacked markers and blocks indented in a list item", () => {
  const { blocks, problems } = markedBlocks(
    [
      `${fence}json`,
      `{ "ignored": true }`,
      fence,
      "",
      "<!-- doc-test: tool-policy -->",
      "<!-- doc-test: typescript -->",
      `${fence}ts`,
      "const rules = [];",
      fence,
      "- a list item:",
      "",
      "  <!-- doc-test: folder hello AGENT.md -->",
      `  ${fence}markdown`,
      "  ---",
      "  name: hello",
      "  ---",
      `  ${fence}`,
      "<!-- doc-test: tool-policy -->",
      "Some prose instead of a block.",
    ].join("\n"),
  );
  assert.deepEqual(
    blocks.map(({ check, args, line }) => ({ check, args, line })),
    [
      { check: "tool-policy", args: [], line: 8 },
      { check: "typescript", args: [], line: 8 },
      { check: "folder", args: ["hello", "AGENT.md"], line: 14 },
    ],
  );
  assert.equal(blocks[2].text, "---\nname: hello\n---\n");
  assert.deepEqual(problems, [{ line: 18, message: "doc-test marker is not followed by a code block" }]);
});

test("reads rules from TypeScript, a shell command's JSON body, or a rule alone", () => {
  assert.deepEqual(rulesOf(`await admin.toolPolicy.put({\n  rules: [\n    { effect: "deny", tool: "x", when: { n: { gt: 10_000 } } }, // a comment ]\n  ],\n});`), [
    { effect: "deny", tool: "x", when: { n: { gt: 10000 } } },
  ]);
  assert.deepEqual(rulesOf(`curl -d '{"rules": [{"effect": "ask", "server": "github"}]}'`), [{ effect: "ask", server: "github" }]);
  assert.deepEqual(rulesOf(`{ "effect": "allow" }`), [{ effect: "allow" }]);
  assert.throws(() => rulesOf(`put({ rules: [ruleFor("x")] })`), /not a literal list/);
});

test("a tool policy rule with a model-facing server__tool name fails (the 0.31 review's C1)", async () => {
  const c1 = `<!-- doc-test: tool-policy -->\n${fence}ts\nawait createAdmin().toolPolicy.put({\n  rules: [\n    { effect: "ask", server: "github", tool: "github__delete_*" },\n  ],\n});\n${fence}\n`;
  const { failures } = await run(c1);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /rule 1 .*github__delete_\*.*Name an MCP tool by `server` and `tool`/);
  assert.equal(failures[0].line, 3);
  const fixed = await run(c1.replace("github__delete_*", "delete_*"));
  assert.deepEqual(fixed.failures, []);
  assert.equal(fixed.counts["tool-policy"], 1);
});

test("tool-policy refused passes only when a rule is refused", async () => {
  const block = (rule) => `<!-- doc-test: tool-policy refused -->\n${fence}json\n${rule}\n${fence}\n`;
  assert.deepEqual((await run(block(`{ "effect": "ask", "tool": "github__create_issue" }`))).failures, []);
  const { failures } = await run(block(`{ "effect": "ask", "server": "github", "tool": "create_issue" }`));
  assert.match(failures[0].message, /marked refused, but the Runtime takes every rule/);
});

test("an agent folder's blocks compile together; an error names the block's line", async () => {
  const agent = `<!-- doc-test: folder hello AGENT.md -->\n${fence}markdown\n---\nname: hello\ndescription: Says hello.\n---\nSay hello.\n${fence}\n`;
  const tool = (type) =>
    `\nText between the files.\n\n<!-- doc-test: folder hello tools/now.json -->\n${fence}json\n{\n  "description": "The time.",\n  "inputSchema": { "type": "${type}" },\n  "http": { "url": "https://time.example.com/now" }\n}\n${fence}\n`;
  const good = await run(agent + tool("object"));
  assert.deepEqual(good.failures, []);
  assert.equal(good.counts.folders, 1);
  const { failures } = await run(agent + tool("objekt"));
  assert.ok(failures.length > 0);
  assert.equal(failures[0].line, 14);
  assert.match(failures[0].message, /^agent folder hello: tools\/now\.json:\d+:\d+ error: .*objekt/);
});

test("unknown checks and malformed folder markers fail", async () => {
  const { failures } = await run(`<!-- doc-test: spelling -->\n${fence}\nx\n${fence}\n\n<!-- doc-test: folder hello -->\n${fence}\nx\n${fence}\n`);
  assert.deepEqual(
    failures.map((failure) => failure.line),
    [1, 6],
  );
});

test("a TypeScript block that does not typecheck fails at its Markdown line", async () => {
  const { failures } = await run(
    `<!-- doc-test: typescript -->\n${fence}ts\nimport { createClient } from "@nylorun/agents";\n\nconst client: number = await createClient();\n${fence}\n`,
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0].line, 5);
  assert.match(failures[0].message, /^TypeScript TS2322/);
});
