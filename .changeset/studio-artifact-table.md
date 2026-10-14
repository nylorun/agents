---
"@nylorun/studio": minor
---

**Studio lists the Tenant's artifacts.** **Artifacts** is back in the sidebar: one table of every artifact, newest first, 50 at a time (`artifact-reads` pages), filtered by kind, session and labels. Each row names its owner: a session, an Environment's disk (linked to its Disk tab) or the Tenant itself, such as an input file for a pod's recipe. The artifact inspector shows the owner too. A Host without `artifact-reads` gets the session lookup as before, and opening an artifact by id still works.
