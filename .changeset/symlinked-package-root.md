---
"@nylorun/agents": patch
---

`composeManifest` reads the `mcp.json` a `harness.manifest.json` names in a folder reached through a symlink, such as macOS's temporary directory (`/var` → `/private/var`). The package boundary is now resolved through `realpath` like the file, so it is no longer refused as "not a file inside the package".
