---
"@nylorun/runtime": patch
---

A Tenant's stream wiring no longer logs after it stops. A basin repair that failed after the Tenant closed could write to a Tenant log directory that was already removed and end the process with an unhandled rejection.
