---
"@nylorun/runtime": patch
---

The stream relay's lag is never negative: an idle relay confirms one byte past `pg_current_wal_lsn()`, which reported a lag of -1 and failed `/v1/admin/status` validation (400), so Studio showed an idle, healthy Tenant as unavailable.
