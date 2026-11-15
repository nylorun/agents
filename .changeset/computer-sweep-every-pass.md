---
"@nylorun/runtime": patch
---

The sweep reconciles every computer the Runtime wants running on each pass, whatever its row says:
a resumed computer's row doesn't follow the resume, so the earlier rule (a running row at rest)
missed it, and a drain that moved it to another worker went unrecorded. Now `agent.suspended`
(reason `drain`) is recorded within a minute while a harness still holds its ticket.
