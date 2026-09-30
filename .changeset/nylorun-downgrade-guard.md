---
"nylorun": patch
---

`nylorun up`/`start` refuses to downgrade the shared stack. When this release pins a Runtime older than `host.json` `runtimeVersion` or the running Runtime's `/health` version, it exits 5 before changing the stack files or containers, and names the remedy: update nylorun, or pass the new `--allow-downgrade` flag. `nylorun studio` applies the same check when it starts the stack. With `NYLORUN_RUNTIME_IMAGE` set, the check is skipped and `host.json` keeps its recorded `runtimeVersion`.
