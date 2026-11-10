---
"@nylorun/runtime": patch
"nylorun": patch
---

Pods on Agent Substrate (preview):

- **A crashed actor recovers.** A wake that finds the actor crashed, or that crashes it, reverts the actor to its last snapshot once and resumes it, as Substrate requires. Before, the Agent stayed failed until it was reset.
- **A wake during an idle suspend is no longer lost.** The resume waits for the suspend to finish instead of dropping the wake.
- **One resume call per wake.** It is no longer cancelled after 2 minutes, which also cancelled the restore in progress. It is tried again only while Substrate is busy, for at most 5 minutes (the Runtime's own ready deadline). It stops as soon as a later request replaces it, and holds no lock during the call.
- **Each resume is logged** as `substrate resumed` with its time in `ms`.
- **Removed:**
  - `RES_OPTIONS`, which is no longer set in the actor's environment. The edge's `/etc/hosts` pin already spares the engine any DNS lookup, and the Agent's own resolver is its own.
  - The shutdown-time sweep, since the Runtime never sends a shutdown time.
