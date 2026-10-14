---
"@nylorun/core": patch
"@nylorun/runtime": patch
---

**An artifact names the Environment whose disk it holds.** `ArtifactView` (and so `ArtifactListItem` in artifact pages) gains optional `environmentId`: set on the folder artifact that holds an Environment's disk versions (R2d step 3), absent on a session's or the Tenant's own artifacts. Before, such an artifact read as a Tenant-owned one with no way to tell whose disk it was.
