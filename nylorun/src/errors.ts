/** Exit codes are part of both commands' contract; see nylorun/README.md ("Exit codes"). */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1
  ) {
    super(message);
    this.name = "CliError";
  }
}
