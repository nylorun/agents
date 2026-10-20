---
"@nylorun/core": minor
"@nylorun/agents": minor
"nylorun": minor
---

Agent folders convert both ways (track T7, D80). `folderOfManifest(manifest)` in `@nylorun/core/folder` (also exported by `@nylorun/agents`) writes the agent folder that compiles back to the same manifest: name, description, metadata, harness, memory, loop and server and skill settings in `AGENT.md`, the first instruction as its body and the rest as `instructions/NN-*.md`, HTTP tools as `tools/<name>.json`, MCP servers in `mcp.json` with `Bearer ${SLOT}` or `${SLOT}` for a credential, triggers as `triggers/<id>.md`, and `runtime.json` without the slots the compiler derives the same way. It checks itself by compiling the folder, says whether the hash is the same (`exact`), and notes what it writes differently. Skills are written from their bytes when given them, else as a placeholder with the files to copy in; flows and subagent tools wait for the compiler.

`nylorun export --folder <name>[@<version>]` writes the folder of a saved manifest, from JSON or TypeScript; `nylorun migrate folder <dir>` writes the folder of a three-file folder, offline, with its skills; `nylorun pull <name>[@<version>]` writes back the folder a version was saved from, byte for byte, and says to use `export --folder` for a version saved as JSON. None writes over a file with other bytes.

Deprecated, still read: the three-file format (`agent.manifest.json`), whose `composeManifest` and `nylorun apply` now warn and name `nylorun migrate folder`, and `secrets` in a `SKILL.md`, which the skills loader warns about (a `DeprecationWarning` from `.skills()`): an agent folder lists a skill's secrets in `AGENT.md`.
