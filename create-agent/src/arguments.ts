import type { CreateOptions } from "./contracts.js";

export const usage =
  "Usage: npm create @nylorun/agent@beta <directory> [--no-open] [--yes]";

/** Printed when `--no-studio` is passed; the flag is accepted and ignored. */
export const NO_STUDIO_DEPRECATED =
  "--no-studio is deprecated and ignored: Studio runs in the local Docker stack, so generated projects no longer depend on @nylorun/studio. Use --no-open to keep the browser closed.";

export function parse(argv: readonly string[]): CreateOptions {
  const [directory, ...flags] = argv;
  if (!directory || directory.startsWith("-")) throw new Error(usage);
  if (
    flags.some(
      (flag) => !["--no-studio", "--no-open", "--yes"].includes(flag)
    )
  )
    throw new Error(usage);
  return Object.freeze({
    directory,
    open: !flags.includes("--no-open"),
    yes: flags.includes("--yes"),
    notes: Object.freeze(
      flags.includes("--no-studio") ? [NO_STUDIO_DEPRECATED] : []
    ),
  });
}
