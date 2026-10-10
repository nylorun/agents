import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (readFileSync("LICENSE", "utf8") !== readFileSync("../../LICENSE", "utf8"))
  throw new Error(
    "Creator LICENSE must contain the complete canonical Apache-2.0 text.",
  );

const cache = mkdtempSync(join(tmpdir(), "nylorun-create-agent-pack-"));
try {
  const output = execFileSync(
    "npm",
    ["pack", "--json", "--dry-run", "--ignore-scripts"],
    { encoding: "utf8", env: { ...process.env, npm_config_cache: cache } },
  );
  const files = JSON.parse(output)[0].files.map((entry) => entry.path);
  for (const required of [
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "compatibility.json",
    "dist/cli.js",
    "dist/project.js",
    "dist/scaffold.js",
    "dist/starter/package.json",
    "dist/starter/.env.example",
    "dist/starter/_gitignore",
    "dist/starter/agents/index.ts",
    "dist/starter/agents/assistant/agent.ts",
    "dist/starter/src/main.ts",
  ])
    if (!files.includes(required))
      throw new Error(`Missing tarball file: ${required}`);
  console.log(`Creator tarball allowlist passed (${files.length} files).`);
} finally {
  rmSync(cache, { recursive: true, force: true });
}
