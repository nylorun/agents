---
"nylorun": minor
---

**`nylorun environments` for manifests and forks (protocol 14).**

- `nylorun environments manifests list | get <name> [--version n] | versions <name> | save <file>... [--if-match n] [--dry-run] | rm <name>`. `save` reads each JSON file (dropping `$schema`). A `files` entry with `"from": "<folder>"`, relative to the file, becomes files by content hash; `save` uploads those the Runtime lacks. `--dry-run` prints the plan and exits 1 when the Runtime would refuse the save.
- `nylorun environments put <id> --manifest <name[@n]>` makes an Environment from a manifest version.
- `nylorun environments fork <id> <new-id> [--manifest name@n] [--disk latest|n|empty] [--secrets copy|none] [--label k=v]... [--dry-run]` forks an Environment onto a new manifest version, and names the required slots still to set.
- `nylorun environments list` shows each Environment's manifest and version. `--behind` keeps those made from an older version than their manifest's latest.
- `nylorun environments secrets put <id> <name>`, with no file, writes a slot's value piped in on standard input.
- `nylorun agents save --dry-run` checks a definition and saves nothing.
