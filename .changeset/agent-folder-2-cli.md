---
"nylorun": minor
---

`nylorun check --explain` prints each engine feature the agent and its subagents get, on or off,
with what declares it and the tools and text blocks it adds (`explain` in `--json`). `nylorun
migrate folder <dir> --to 2` makes an agent folder `agent-folder/2` in place, writing the
`engine:` declarations that keep what it gets today, after checking that no agent's system text
or tool list changes (ADR-100).
