import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { checkPackedConsumer } from "./check-consumer.mjs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const canonicalLicense = readFileSync("../../LICENSE", "utf8");
const forbidden = [
  "@nylorun/runtime",
  "@nylorun/agent",
  "@nylorun/studio",
  "@nylorun/create-harness",
];
if (
  manifest.description !==
  "Nylorun's TypeScript agent execution engine. See github.com/nylorun/agents."
)
  throw new Error("Harness package description must direct users to the canonical repository.");
if (!Array.isArray(manifest.keywords) || manifest.keywords.length === 0)
  throw new Error("Harness package must declare npm keywords.");
if (manifest.author !== "Nylo") throw new Error("Harness package must identify its author.");
if (manifest.homepage !== "https://github.com/nylorun/agents")
  throw new Error("Harness package homepage must point to its canonical repository.");
if (manifest.bugs !== "https://github.com/nylorun/agents/issues")
  throw new Error("Harness package bugs field must point to the canonical issue tracker.");
if (
  manifest.repository?.url !== "git+https://github.com/nylorun/agents.git" ||
  manifest.repository?.directory !== "runtime/harness"
)
  throw new Error(
    "Harness package repository metadata must point to the canonical source directory.",
  );
if (readFileSync("LICENSE", "utf8") !== canonicalLicense)
  throw new Error("Harness package LICENSE must contain the complete canonical Apache-2.0 text.");
const production = { ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) };
for (const name of forbidden) {
  if (name in production) throw new Error(`Forbidden production dependency: ${name}`);
}
const sourceFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
for (const file of sourceFiles("src").filter((path) => path.endsWith(".ts"))) {
  const source = readFileSync(file, "utf8");
  for (const name of forbidden) {
    if (source.includes(name))
      throw new Error(`Forbidden source import reference ${name} in ${file}`);
  }
  if (source.includes("message.startsWith("))
    throw new Error(`Message text must not classify a Harness outcome in ${file}`);
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["Error", "TypeError", "RangeError"].includes(node.expression.text)
    )
      throw new Error(`Unstructured ${node.expression.text} construction in ${file}`);
    ts.forEachChild(node, visit);
  };
  visit(tree);
}

const cache = mkdtempSync(join(tmpdir(), "nylo-harness-pack-"));
try {
  const npm = "npm";
  const output = execFileSync(npm, ["pack", "--json", "--dry-run", "--ignore-scripts"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: cache },
  });
  const files = JSON.parse(output)[0].files.map((entry) => entry.path);
  const allowed = (path) =>
    path === "package.json" ||
    path === "README.md" ||
    path === "HOST_CONTRACT.md" ||
    path === "CHANGELOG.md" ||
    path === "LICENSE" ||
    /^dist\/.+\.(?:js|d\.ts)$/.test(path);
  const unexpected = files.filter((path) => !allowed(path));
  if (unexpected.length) throw new Error(`Unexpected tarball files: ${unexpected.join(", ")}`);
  for (const required of [
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/run/index.js",
    "dist/run/index.d.ts",
  ]) {
    if (!files.includes(required)) throw new Error(`Missing tarball file: ${required}`);
  }
  const entry = await import(new URL("../dist/index.js", import.meta.url));
  for (const removed of [
    "Session",
    "SessionRecorder",
    "SessionRecord",
    "InputHandle",
    "BuiltAgent",
    "defineToolFamily",
  ])
    if (removed in entry) throw new Error(`Obsolete Harness session export: ${removed}`);
  for (const path of [
    "definition/bind-agent.js",
    "definition/agent-definition.js",
    "definition/bound.js",
    "loop/step/runtime.js",
    // Removed: model calls are the Runtime's (its Model Gate), not the harness's.
    "model/adapters",
  ]) {
    try {
      await import(`@nylorun/harness/${path}`);
      throw new Error(`Internal subpath must not be importable: ${path}`);
    } catch (error) {
      if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    }
  }
  const definitions = await import("@nylorun/core/define");
  for (const name of [
    "AgentBuilder",
    "AgentBuildError",
    "AgentLifecycleError",
    "HarnessError",
    "isHarnessError",
    "Agent",
    "tool",
    "capability",
    "ToolError",
    "model",
    "middleware",
    "checkCompatibility",
    "hashManifest",
  ]) {
    if (!(name in (name === "checkCompatibility" ? entry : definitions)))
      throw new Error(`Missing public export: ${name}`);
  }
  const execution = await import(new URL("../dist/run/index.js", import.meta.url));
  for (const name of [
    "run",
    "createRunState",
    "runDurable",
    "createDurableCheckpoint",
    "runFlowDurable",
    "createFlowCheckpoint",
    "createExecutionState",
    "validateExecutionState",
    "bindingFromAgent",
    "checkCompatibility",
  ]) {
    if (!(name in execution)) throw new Error(`Missing run export: ${name}`);
  }
  if (files.some((path) => path.startsWith("dist/loop/model/adapters.")))
    throw new Error("The harness ships no provider adapters: dist/loop/model/adapters.*");
  checkPackedConsumer(cache);
  console.log(`Tarball and dependency boundary passed (${files.length} files).`);
} finally {
  rmSync(cache, { recursive: true, force: true });
}

const independentManifest = JSON.parse(readFileSync("package.json", "utf8"));
for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])
  if (independentManifest[field]?.["@nylorun/runtime"])
    throw new Error("Harness must not depend on Runtime.");
