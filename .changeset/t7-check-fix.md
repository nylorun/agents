---
"@nylorun/core": minor
"nylorun": minor
"@nylorun/runtime": patch
---

`nylorun check --fix` makes the edits the compiler's diagnostics carry (track T7). A diagnostic one edit fixes has a `fix` (`AgentFolderFix`, in `AgentFolderDiagnostic` and the Runtime API's): `rename_key` for an unknown key with exactly one did-you-mean (in `AGENT.md`, a trigger, a `SKILL.md`, a tool file, `runtime.json`, `mcp.json`, `flow.json` and a JSON Schema's keywords), at its line and column, and none when two keys are as close or the key it would be is already there; `crlf` for a file with CRLF line ends, which is now a `crlf` note (it is read as LF, as before); and `move_skill_secrets` for `secrets` in a root skill's `SKILL.md`, when `AGENT.md` lists none for the skill, or lists them all. Messages, manifests and hashes are unchanged. `applyFolderFixes` in `@nylorun/core/folder` makes them on text: the key token renamed with every other byte kept, LF line ends, and the secrets moved to `AGENT.md`'s `skills` block as `migrate folder` writes it, skipping (with why) a fix whose text is no longer where it was.

`nylorun check` marks each fixable problem `(fixable with --fix)` and writes nothing. `check --fix` makes the edits in the folder's files, prints each change by file, and checks again until nothing is left to fix; it leaves a file whose bytes changed since it was checked (writing nothing when one changes while it fixes), and a `runtime.json` that `extends` another. `check --json` gives each diagnostic's `fix`, and with `--fix` each folder's `fixed` and `unfixed`.
