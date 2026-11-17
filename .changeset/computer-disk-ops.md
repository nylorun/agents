---
"@nylorun/runtime": patch
---

Disk versions of a computer (a snapshot, a restore, a seed, and a new volume from the latest version) now copy the computer's own disk, its `/workspace` and `/harness`, through a new computer route, `POST /v1/disk`, which both the engine's `--service computer` and the computer agent serve. Before, they copied a directory of the Runtime's own process: versions of computers taken before this release hold nothing of the computer, and a restore or seed wrote nothing onto it. A copy onto a restored or recovered computer reaches its new volume, not the last one. A computer whose agent has no such route yet fails the copy (`409 agent_unavailable`, "This computer's agent is too old to copy its disk; reset it or wait for its next start on the new agent") rather than copying any other disk.
