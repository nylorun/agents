import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Compatibility } from "./contracts.js";
import { starterFiles } from "./scaffold.js";

export interface ExamplesRecipe {
  name: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  index: string;
}
export async function examplesFiles(
  compatibility: Compatibility,
  recipe: ExamplesRecipe
) {
  const rendered = await starterFiles(compatibility);
  const files = Object.fromEntries(
    Object.entries(rendered).filter(([path]) => managed(path))
  );
  const manifest = JSON.parse(files["package.json"]!);
  manifest.name = recipe.name;
  for (const field of ["dependencies", "devDependencies", "scripts"] as const)
    manifest[field] = { ...manifest[field], ...recipe[field] };
  // Recipe additions belong beside the corresponding starter commands.
  const scriptOrder = [
    "configure",
    "dev",
    "inspect",
    "build",
    "start",
    "check",
    "test",
  ];
  const rank = (name: string) => {
    const index = scriptOrder.indexOf(name);
    return index < 0 ? scriptOrder.length : index;
  };
  manifest.scripts = Object.fromEntries(
    Object.entries(manifest.scripts).sort(
      ([left], [right]) => rank(left) - rank(right) || left.localeCompare(right)
    )
  );
  manifest.scripts.build = manifest.scripts.build.replace(
    "tsc -p tsconfig.json",
    "tsc -p tsconfig.build.json"
  );
  files["tsconfig.build.json"] =
    JSON.stringify(
      {
        extends: "./tsconfig.json",
        compilerOptions: { noEmit: false, rootDir: ".", outDir: "dist" },
        include: ["agents/**/*.ts", "src/**/*.ts"],
      },
      null,
      2
    ) + "\n";
  files["package.json"] = JSON.stringify(manifest, null, 2) + "\n";
  files["src/index.ts"] = recipe.index;
  const tsconfig = JSON.parse(files["tsconfig.json"]!);
  tsconfig.compilerOptions.noEmit = true;
  delete tsconfig.compilerOptions.rootDir;
  delete tsconfig.compilerOptions.outDir;
  tsconfig.include.push("test/**/*.ts");
  files["tsconfig.json"] = JSON.stringify(tsconfig, null, 2) + "\n";
  return files;
}
function managed(path: string): boolean {
  return (
    !path.startsWith("agents/") &&
    !path.startsWith("config/") &&
    path !== "README.md"
  );
}
const manifestPath = ".scaffold-manifest.json";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
interface Provenance {
  version: 1;
  creatorVersion: string;
  compatibility: Compatibility;
  templateHash: string;
  files: Record<string, string>;
}

/** Preflight the whole tree before edits. Authored paths and local state are never eligible. */
export async function synchronize(
  root: string,
  files: Readonly<Record<string, string>>,
  compatibility: Compatibility,
  options: { check?: boolean; adopt?: boolean; creatorVersion: string }
): Promise<readonly string[]> {
  root = resolve(root);
  async function pathFor(path: string) {
    if (
      !path ||
      path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      !managed(path) ||
      path.startsWith("test/") ||
      (path.startsWith("scripts/") && path !== "scripts/dev.mjs") ||
      path === ".env" ||
      path === ".env.local" ||
      path === ".nylorun" ||
      path.startsWith(".nylorun/") ||
      path.startsWith(".data/") ||
      path.startsWith("node_modules/") ||
      (path.startsWith(".env/") &&
        ![".env/README.md", ".env/.gitignore"].includes(path))
    )
      throw new Error(`Refusing unmanaged path: ${path}`);
    let current = root;
    for (const part of path.split("/")) {
      current = join(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${path}`);
        if (current !== join(root, path) && !stat.isDirectory())
          throw new Error(
            `Cannot write ${path}: relocate the legacy .env file before syncing; its contents will not be changed.`
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return join(root, path);
  }
  async function read(path: string): Promise<string | undefined> {
    try {
      return await readFile(await pathFor(path), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  const priorText = await read(manifestPath);
  const prior: Provenance | undefined = priorText
    ? JSON.parse(priorText)
    : undefined;
  if (
    prior &&
    (prior.version !== 1 || !prior.files || typeof prior.files !== "object")
  )
    throw new Error("Invalid scaffold manifest.");
  const hashes = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((path) => [path, hash(files[path]!)])
  );
  const provenance: Provenance = {
    version: 1,
    creatorVersion: options.creatorVersion,
    compatibility,
    templateHash: hash(JSON.stringify(hashes)),
    files: hashes,
  };
  const changes: string[] = [];
  const writes = new Map<string, string>();
  const removals: string[] = [];
  for (const path of new Set([
    ...Object.keys(prior?.files ?? {}),
    ...Object.keys(files),
  ])) {
    const existing = await read(path);
    const desired = files[path];
    if (existing === desired) continue;
    changes.push(path);
    if (
      !options.check &&
      existing !== undefined &&
      hash(existing) !== prior?.files[path] &&
      !(options.adopt && !prior)
    )
      throw new Error(
        `Generated-file conflict: ${path}. Move the intended change into the creator template or recipe before syncing.`
      );
    if (desired === undefined) removals.push(path);
    else writes.set(path, desired);
  }
  const next = JSON.stringify(provenance, null, 2) + "\n";
  if (priorText !== next) changes.push(manifestPath);
  if (options.check) return changes;
  for (const [path, content] of writes) {
    const file = await pathFor(path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  for (const path of removals) await rm(await pathFor(path));
  await writeFile(await pathFor(manifestPath), next);
  return changes;
}
