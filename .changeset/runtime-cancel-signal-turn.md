---
"@nylorun/runtime": patch
---

**A late cancel signal no longer stops the next turn.** The `session.cancel` signal on `tenant/control` now names the turn it cancelled, and a Worker aborts only an advance of that turn. Before, a signal delivered after S2 came back (an append the SDK retried, or a control reader catching up) aborted whatever advance the session was running, which could be a turn started after the cancel.
