---
"@nylorun/studio": patch
---

**Studio opens every session it lists.** Opening a session no longer sends `PUT /v1/sessions/:id`: Studio reads the session, so one an application created with another `ownerUserId`, a `sandbox` or `info` shows its history instead of `Runtime HTTP 409 … different creation parameters`. Only **New session** (the agent page and the sidebar) creates a session, as before for `local-developer`; any other unknown session id shows "Session not found" and is not created. A flow's child session opens from the Workflow tree through `/sessions/:id`, also when its agent is embedded in the flow and not registered: Studio shows the agent from the flow's manifest, or by its id, instead of the home page.
