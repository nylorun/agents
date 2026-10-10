---
"@nylorun/core": patch
"@nylorun/runtime": patch
"@nylorun/agents": patch
---

Add opt-in artifact metadata pagination to `GET /v1/artifacts?limit=…`, shared
`ArtifactListItem`/`ArtifactPage` contracts and SDK `artifacts.page()` (default 50,
maximum 200). Hosts advertise `artifact-reads`. Pages order by creation time and
ID descending, filter by session, kind and labels, bind cursors to the Tenant and
filters, and reapply ownership and agent grants on each read. Legacy unpaged
responses remain unchanged. A Drizzle migration adds the creation-order index;
pages reuse the existing bounded read-only pool. Studio and every other Runtime
client can consume this public API without database access.
