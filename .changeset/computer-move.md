---
"@nylorun/runtime": minor
"@nylorun/core": minor
---

A `virtual` Agent can become a computer (ADR-154, Host feature `computer-move`): on a Runtime whose pod Agents are computers, a `PUT /v1/agents/{id}` naming a `pod` version of its manifest changes its kind in place, keeping its id, sessions, memory, vault, triggers, events and labels. `from` seeds the new volume from a disk version of another Agent with the same owner. Its virtual workspace is deleted, and the move is `agent.version_changed` with `kindFrom` and `kindTo`. It is refused while a turn runs or its disk is copied (`agent_busy`), on a version that would wait for a secret (`request_rejected`), and for any other kind change or on a Runtime without computers (`agent_fixed_field`). A manifest save never changes an Agent's kind.
