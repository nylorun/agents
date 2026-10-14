#!/usr/bin/env node
import "./baseline.js";
import { runCommand } from "./command.js";
import { CliError } from "./errors.js";

/**
 * `nylo` became part of `nylorun`. For one release this command names the `nylorun` command that
 * replaces each of its own and exits 2; a later release removes it.
 */
const REPLACEMENTS: Record<string, string> = {
  status: "nylorun status",
  reset: "nylorun tenant reset",
  access: "nylorun tenant signing-keys list|rotate|revoke",
  configure: "nylorun tenant models set",
  doctor: "nylorun doctor sandbox",
  env: 'nothing: the SDKs read the Project link themselves; for a process outside the project, "nylorun tenant keys put <id>" and the Runtime URL "nylorun status" prints',
};

function nyloMessage(argv: readonly string[]): string {
  const replacement = REPLACEMENTS[argv[0] ?? ""];
  return replacement
    ? `nylo is part of nylorun now: nylo ${argv[0]} is ${replacement}.`
    : "nylo is part of nylorun now: run nylorun --help.";
}

runCommand(async () => {
  throw new CliError(nyloMessage(process.argv.slice(2)), 2);
});
