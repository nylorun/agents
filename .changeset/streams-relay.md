---
"@nylorun/runtime": minor
"nylorun": minor
---

**The stream relay, ready to wire in.** The Runtime gains the relay that will feed S2 from a Postgres record of session events over logical replication (Durable Streams v1); nothing uses it yet.

- **Relay core** (`streams/relay/`): per-session pumps appending with `matchSeq`, acknowledgements only after S2 has the rows, refills from the record on a gap, reconciliation after a new or lost slot, and rows of an old basin generation dropped.
- **Change source** (`adapters/replication/pgoutput.ts`): a persistent `pgoutput` slot, one active process per slot, always resumed from the confirmed position; a pending reconciliation is kept in `nylorun_streams.relay_slots` so a crash cannot skip it.
- **Shared schema** (`nylorun_streams`): `session_events`, `session_log_heads`, `relay_slots` and the `nylorun_stream_relay` publication, migrated by the Host.
- **Basin generations**: `basinOf(tenantId, generation)` names a Tenant's later basins (`<basin>-<g base36>`).
- **Local stack**: Postgres runs with `wal_level=logical` and `max_slot_wal_keep_size=4GB`. `nylorun start` recreates the Postgres container once; its data volume is kept. `DEPLOYMENT.md` lists the settings for a Postgres you run yourself.
