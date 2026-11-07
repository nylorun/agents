---
"@nylorun/runtime": patch
---

Every running pod Agent now has an idle timer, whatever woke it. A pod woken by a disk copy or by commands through the session's sandbox route, and one whose idle timer fired during a turn, no longer runs past its idle limit; the Tenant sweep arms the timer of a pod already running past it.
