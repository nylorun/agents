---
"nylorun": minor
"@nylorun/agents": patch
---

**`nylorun` does what `@nylorun/agents` does: `agents`, `sessions`, `environments` and `artifacts`.** Each is a group on the Runtime API, with the installation's application key, an identity provider's token (`NYLORUN_TOKEN`), and `--as <subject> [--scope <scope>]...` to act for a person.

- **`agents list | get | save`:** `save <manifest.json|-> --files <dir>...` saves an agent from its manifest, uploading the definition files it names (found by their SHA-256) that the Runtime lacks.
- **`sessions`:** `list`, `create`, `get`, `send` (text, `--data` JSON, or `--file <artifact>[@<version>]` parts), `approve [--deny]`, `respond`, `cancel`, `watch [--follow]` (events as JSON lines), `history`, `usage`, `calls [--tool]`, `trace`, and `exec <id> -- <command>` (bash in the session's sandbox; exits with its exit code).
- **`environments`:** `list`, `get`, `put <id> [<recipe.json|->] [--kind] [--label]`, `stop`, `reset`, `delete`, `snapshot`, `versions`, `restore`, `delete-version`, `events`, and `secrets list|get|put|rm`; a secret's JSON comes from a file or standard input, never the command line.
- **`artifacts`:** `list`, `get`, `upload <file|->` (`--to <id>` for a new version), `download`, `tree`, `diff`, `zip`, `link`, `rm`.
- **`nylorun` now depends on `@nylorun/agents`.** A release of `@nylorun/agents` releases nylorun too.
- **`@nylorun/agents`:** an incompatible Runtime's remedy names `npx nylorun@latest start` instead of a `nylorun runtime restart` that no longer exists.
