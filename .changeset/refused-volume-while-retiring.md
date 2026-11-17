---
"@nylorun/runtime": patch
---

A pod's new volume that its sandbox refuses again fails with the reason even while the previous
volume is still being deleted, and that deletion goes on while a refused pod waits for it (it
could hold the pod in `creating`).
