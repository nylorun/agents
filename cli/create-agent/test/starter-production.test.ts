import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { starterFiles } from "../dist/scaffold.js";
import type { Compatibility } from "../src/contracts.js";

const execFileAsync = promisify(execFile);
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const npm = "npm";

const compatibility: Compatibility = {
  core: "0.4.0-beta",
  harness: "0.18.0-beta",
  agents: "0.5.0-beta",
  admin: "0.1.0-beta",
  runtime: "0.9.0-beta",
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

it("starter source imports only @nylorun/agents among Nylorun packages", async () => {
  const files = await starterFiles(compatibility);
  const sources = Object.entries(files).filter(([path]) => path.endsWith(".ts"));
  expect(sources.map(([path]) => path).sort()).toEqual([
    "agents/assistant/agent.ts",
    "agents/index.ts",
    "src/main.ts",
  ]);
  expect(files["src/main.ts"]).toBe(
    [
      "import { readFile } from \"node:fs/promises\";",
      "import { createClient } from \"@nylorun/agents\";",
      "import { agents } from \"../agents/index.js\";",
      "",
      "// Saves each agent as an agent manifest, with the runtime it runs in, and makes the Agent its",
      "// sessions run on (named after it); nothing here keeps running. The client finds the Runtime",
      "// through the Project link, or NYLORUN_RUNTIME_URL and NYLORUN_SERVER_KEY.",
      "const client = await createClient();",
      "// The runtime section the agents share: a virtual workspace with no network.",
      "const { $schema: _, ...runtime } = JSON.parse(",
      "  await readFile(new URL(\"../runtime/scratch.runtime.json\", import.meta.url), \"utf8\"),",
      ");",
      "// `npm run dev` passes --dev: an Agent made from an older version is made again from the new one,",
      "// so new sessions run your edit (sessions already open keep the version they pinned). Elsewhere an",
      "// Agent keeps the version it was made from, and a newer one reaches it through a fork.",
      "const dev = process.argv.includes(\"--dev\");",
      "for (const agent of agents) {",
      "  const { manifest } = await client.agentManifests.save({ agent, runtime });",
      "  let made = await client.agents.put(agent.id, { manifest: agent.id });",
      "  if (dev && made.resolvedVersion < manifest.version) {",
      "    await client.agents.delete(agent.id);",
      "    made = await client.agents.put(agent.id, { manifest: agent.id });",
      "  }",
      "  console.log(`Saved agent ${agent.id} v${manifest.version} (Agent ${made.id} runs v${made.resolvedVersion})`);",
      "}",
      "",
    ].join("\n")
  );
  expect(files["environments/scratch.json"]).toBeUndefined();
  expect(JSON.parse(files["runtime/scratch.runtime.json"]!)).toEqual({
    $schema: "https://docs.nylorun.com/schemas/runtime-manifest/v1.json",
    kind: "virtual",
    network: { allowedHosts: [] },
  });
  for (const [path, content] of sources) {
    const imports = [
      ...content.matchAll(/from\s+["'](@nylorun\/[^"']+)["']/g),
    ].map((match) => match[1]);
    for (const specifier of imports) {
      expect(specifier, `${path} imports ${specifier}`).toBe("@nylorun/agents");
    }
  }
});

it("production install tree lists only @nylorun/agents and @nylorun/core from Nylorun", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "nylorun-starter-prod-"));
  roots.push(temporary);
  const artifacts = join(temporary, "artifacts");
  await mkdir(artifacts);
  const packed: Record<string, string> = {};
  const paths = { core: "core", agents: "sdks/agents" } as const;
  for (const name of ["core", "agents"] as const) {
    const { stdout } = await execFileAsync(
      npm,
      ["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts],
      { cwd: join(repo, paths[name]), encoding: "utf8" }
    );
    packed[name] = join(artifacts, JSON.parse(stdout)[0].filename);
  }

  const project = join(temporary, "app");
  await mkdir(project);
  const files = await starterFiles(compatibility);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(project, path)), { recursive: true });
    await writeFile(join(project, path), content);
  }
  const manifest = JSON.parse(files["package.json"]!);
  manifest.dependencies["@nylorun/agents"] = packed.agents;
  delete manifest.devDependencies;
  await writeFile(
    join(project, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );

  await execFileAsync(
    npm,
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      packed.agents,
      packed.core,
    ],
    {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, npm_config_fund: "false" },
    }
  );

  const { stdout } = await execFileAsync(
    npm,
    ["ls", "--omit=dev", "--all", "--json", "--silent"],
    { cwd: project, encoding: "utf8" }
  );
  const tree = JSON.parse(stdout) as {
    dependencies?: Record<string, { name?: string; dependencies?: unknown }>;
  };
  const nylorun = new Set<string>();
  const walk = (node: typeof tree | undefined) => {
    for (const [name, child] of Object.entries(node?.dependencies ?? {})) {
      if (name.startsWith("@nylorun/")) nylorun.add(name);
      walk(child as typeof tree);
    }
  };
  walk(tree);
  expect([...nylorun].sort()).toEqual(["@nylorun/agents", "@nylorun/core"]);
  expect(await readFile(join(project, "src/main.ts"), "utf8")).toContain(
    "@nylorun/agents"
  );
  expect(await readFile(join(project, "src/main.ts"), "utf8")).not.toMatch(
    /@nylorun\/(?!agents(?:["'/]|$))/
  );
}, 120_000); // packs and installs two tarballs; ~30 s on a busy machine
