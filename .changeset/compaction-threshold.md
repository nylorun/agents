---
"@nylorun/harness": minor
"@nylorun/runtime": minor
"@nylorun/core": minor
---

An Agent sets when its sessions compact (ADR-157): `harness.loop.compaction` (`loop.compaction` in `AGENT.md`) takes `threshold` and `keepTokens`, positive whole numbers of tokens, and `roles.<role>` over them for sessions opened with that role. Our harness compacts before a model call whose estimate passes the lower of `threshold` and the model's window minus the reply reserve, and keeps `keepTokens` word for word; unset, sessions compact as before. A value that is not a positive integer is ignored with an `engine.diagnostic` (`compaction_setting_ignored`), and the folder compiler refuses it. `turn.start` names the session's role (`role`) to our harness.
