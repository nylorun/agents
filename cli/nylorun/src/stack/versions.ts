import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../errors.js";

function cliPackageJsonPath(): string {
  // src/stack/*.ts and dist/stack/*.js both sit two levels below the package root.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
}

/** This CLI's version, from its `package.json` (`nylorun --version`). */
export function cliVersion(): string {
  try {
    const version = (JSON.parse(readFileSync(cliPackageJsonPath(), "utf8")) as { version?: unknown }).version;
    if (typeof version === "string") return version;
  } catch (error) {
    throw new CliError(`Cannot read CLI package.json: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
  throw new CliError("nylorun's package.json has no version.", 1);
}

/** An image this CLI release pins in its `package.json` `nylorun` (D7). */
export type PinnedImage = "runtime" | "studio";

/**
 * The version this CLI release pins for an image, from its `package.json`
 * `nylorun.runtime` or `nylorun.studio`: the tag of `ghcr.io/nylorun/<name>`
 * a local Tenant runs unless `NYLORUN_RUNTIME_IMAGE` / `NYLORUN_STUDIO_IMAGE`
 * overrides it. The release tooling writes both pins.
 */
export function pinnedVersion(name: PinnedImage): string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(cliPackageJsonPath(), "utf8"));
  } catch (error) {
    throw new CliError(
      `Cannot read CLI package.json: ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }
  const version = (raw as { nylorun?: Record<string, unknown> })?.nylorun?.[name];
  if (typeof version !== "string" || version.trim() === "") {
    throw new CliError(
      `nylorun's package.json is missing "nylorun.${name}" (the pinned ${name} image version).`,
      1,
    );
  }
  return version;
}
