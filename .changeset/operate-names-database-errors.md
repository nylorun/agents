---
"@nylorun/runtime": patch
---

**`nylorun-operate keys` names a database error.** When the Tenant's database cannot be read (a connection or driver failure), `nylorun-operate keys` now exits 2 with `The Tenant's database cannot be read: <cause>` instead of reporting that the database holds no Tenant.
