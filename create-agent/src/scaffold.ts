import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import type { Compatibility } from "./contracts.js";

/** The only renderer used by creation, development, and examples synchronization. */
/**
 * npm never packs files named `.gitignore` and treats them as ignore rules for
 * their directory, so the template stores them as `_gitignore`.
 */
function templatePath(path: string): string {
  return path
    .split(sep)
    .map((segment) => (segment === "_gitignore" ? ".gitignore" : segment))
    .join("/");
}

export async function starterFiles(
  compatibility: Compatibility
): Promise<Readonly<Record<string, string>>> {
  const root = fileURLToPath(new URL("./starter/", import.meta.url));
  const files: Record<string, string> = {};
  async function walk(directory: string) {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else
        files[templatePath(relative(root, absolute))] = (
          await readFile(absolute, "utf8")
        )
          .replaceAll("{{CORE_VERSION}}", compatibility.core)
          .replaceAll("{{HARNESS_VERSION}}", compatibility.harness)
          .replaceAll("{{AGENTS_VERSION}}", compatibility.agents)
          .replaceAll("{{ADMIN_VERSION}}", compatibility.admin)
          .replaceAll("{{RUNTIME_VERSION}}", compatibility.runtime);
    }
  }
  await walk(root);
  if (!("." + "gitignore" in files))
    throw new Error("Starter template is missing its .gitignore.");
  return Object.freeze(files);
}
