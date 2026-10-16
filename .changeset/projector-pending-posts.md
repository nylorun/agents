---
"@nylorun/runtime": patch
---

**The trace projector's status counts the batch it is posting.** `pendingTxs` now includes the transactions of a post in flight, which are not acknowledged until it settles; it said `0` while one was still being retried.
