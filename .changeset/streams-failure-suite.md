---
"@nylorun/runtime": patch
---

**Durable Streams failure suite and latency gate.** New integration tests run the stream relay on Postgres logical replication and s2-lite through a relay crash mid-stream, a 10 s S2 outage, a slot invalidated by `max_slot_wal_keep_size`, and a takeover by another process, checking that every S2 stream equals the record. An opt-in benchmark (`NYLORUN_BENCH=1`) holds commit to S2 under 200 ms at p99 with 50 sessions.
