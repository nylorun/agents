---
"@nylorun/agents": minor
"nylorun": minor
---

Agent folders in the SDK and the CLI (track T6). `@nylorun/agents` adds `packFolder(dir)`, which lists a folder's files with their sizes and hashes (skipping `.git` and `node_modules`, following no symbolic link), `checkFolder`, which compiles it offline with the Runtime's compiler, and `client.agentManifests.saveFolder` and `planFolder`, which upload the files the Runtime lacks and send the folder by hash; `source` and `sourceFile` read a version's folder back. `nylorun init <name>` writes a new folder's `AGENT.md`, `nylorun check [dir…]` prints every problem by file, line and column with no Runtime, and `nylorun apply` saves a folder with `AGENT.md` (`--dry-run` prints the compiled manifest). A folder that does not compile sends nothing.
