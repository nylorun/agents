/** Exit codes are part of the CLI contract; see cli/README.md. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1
  ) {
    super(message);
    this.name = "CliError";
  }
}
