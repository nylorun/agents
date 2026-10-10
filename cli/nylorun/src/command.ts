import { CliError } from "./errors.js";

/** Both commands refuse native Windows before acting; WSL2 runs them. */
export function refuseNativeWindows(): void {
  if (process.platform === "win32")
    throw new CliError(
      "Nylorun does not run on native Windows. Use WSL2: install Node 24 and Docker (Docker Desktop's WSL integration) inside your WSL distribution and run nylorun there (https://learn.microsoft.com/windows/wsl/install).",
      1,
    );
}

/**
 * Run a command (`nylorun` or `nylo`) and exit once stdout and stderr are flushed: with
 * `process.exitCode` (0 when unset), or after printing a failure's message with its
 * `CliError` exit code (else 1).
 */
export function runCommand(main: () => Promise<void>): void {
  void main().then(
    () => finish(process.exitCode === undefined ? 0 : Number(process.exitCode)),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      return finish(error instanceof CliError ? error.exitCode : 1);
    },
  );
}

async function finish(code: number): Promise<never> {
  process.exitCode = code;
  for (const stream of [process.stdout, process.stderr])
    await new Promise<void>((resolve) => stream.write("", () => resolve()));
  process.exit(code);
}
