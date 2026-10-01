---
"@nylorun/runtime": patch
---

**Runtime robustness fixes.**

- **Stream relay.** After a fresh replication slot, the relay marks the record reconciled only once every re-sent row is in S2. Before, it did so once the rows were queued, so losing the connection or the process before they reached S2 left those sessions' streams missing events until their next write.
- **Vault OAuth refresh.** Concurrent uses of an expired grant in one process share one refresh, instead of each spending the refresh token. A refresh that loses a race with another process uses the token that process stored instead of failing with `refresh_failed`. A token endpoint that takes more than 30 s fails the refresh (`VaultServiceOptions.refreshTimeoutMs`).
- **Postgres.** Connections of the Host's pool have `statement_timeout` and `idle_in_transaction_session_timeout` of 60 s, so a hung statement or abandoned transaction no longer holds a shared connection and its locks forever (`PostgresClientOptions.statementTimeoutMs` and `idleInTransactionTimeoutMs`; 0 turns either off). Schema migrations and Tenant deletion run without the statement timeout.
- **Ephemeral runtime.** `startEphemeralRuntime` closes what it opened, and removes its Host root unless retained, when it fails to start.
