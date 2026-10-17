/** Exit codes are part of both commands' contract; see cli/nylorun/README.md ("Exit codes"). */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** `--help` or `-h`, which every command and group takes. */
export const isHelp = (arg: string | undefined): boolean => arg === "--help" || arg === "-h";

/** A command's usage, asked for with `--help`: printed on stdout, exit 0. */
export class HelpRequest extends CliError {
  constructor(usage: string) {
    super(usage, 0);
    this.name = "HelpRequest";
  }
}
