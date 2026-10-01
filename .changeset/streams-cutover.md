---
"@nylorun/core": major
"@nylorun/runtime": major
---

**Postgres is the record of every session event; S2 delivers it.** Durable Streams v1.

- **The record.** Each event is written to `nylorun_streams.session_events` in the transaction that causes it, with the session's log head. The per-Tenant outbox, its relay, its drain in the Tenant sweep and `StreamGapError` are gone: losing S2's data, the relay or its replication slot now costs delay, never events.
- **The stream relay.** With S2, every `api` or `all` Runtime process runs the relay; its Postgres replication slot (`nylorun_stream_relay`) lets exactly one be active. It appends with `matchSeq`, acknowledges the slot only after S2 has the events, refills gaps from the record, and reconciles the record with S2 after a new or lost slot. Without S2 (a local development Host), each Tenant relays its own commits.
- **Postgres needs logical replication.** The Runtime refuses to start an `api` or `all` process with S2 unless `wal_level = logical` and its role may replicate; the error names the setting. The local stack is configured for it. See `DEPLOYMENT.md`.
- **No incarnations.** A session's stream is `sessions/<id>`. A sessions reset moves the Tenant to a new **basin generation**: the old basin gets a `sessions.reset` signal, every process moves its readers, and the old basin is deleted after a grace period. Tenant deletion deletes every generation's basin and the Tenant's record rows.
- **Status.** Tenant status `streams` reports `generation` and the Tenant's `relay` instead of the outbox; the Host aggregate reports the process's `relay` (with its slot lag in bytes) instead of `outboxDepth` and `relayLagMs`.
- **Session history does not survive the upgrade.** Installs are in beta, so Tenant schema migration 8 is a fresh start for session data: a Tenant with sessions loses them, with their commands, checkpoints, effects, Actions and links, as a sessions reset does, and moves to basin generation 1; its settings, agents, Action endpoints, keys, policy and vaults stay. Clients holding cursors start again.
