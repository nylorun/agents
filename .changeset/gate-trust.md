---
"@nylorun/runtime": minor
---

**Gate trust (F5): run tokens and two gate credentials.** A model or MCP call through the gates service reaches only its own run, and the gate takes the call's scope from a token instead of believing the request body.

- **Run tokens.** Each advance that takes a session's lease mints a run token (`tenant/run-token.ts`): an ES256 JWT of `typ` `nylorun-run+jwt` and `aud` `nylorun-gates`, signed by the keys service with the Tenant's current signing key, naming the session (`sub`), its active turn (`trn`), its root agent (`agt`) and the lease epoch (`epc`), for 15 minutes. The lease heartbeat re-mints it when less than 5 minutes remain, and it is dropped when the advance ends or loses the lease. The tokens are internal: not in `openapi.json`, and the JWKS is unchanged.
- **Two credentials at the gateway.** Model calls and their cancels accept only a run token. Tool calls, their cancels and the MCP connect, list and close routes accept a run token, or `NYLORUN_GATES_TOKEN` (now core's credential) for requests made outside a run. Keys, `/deliveries` and endpoint pings accept only core's credential.
- **Scope from the token.** The model-call body no longer carries `sessionId`, `turnId` or `agentId` (a body naming them is refused with `400`), and MCP requests under a run token leave out `server.sessionId`: ledger rows, turn and agent caps, and MCP manifest and vault-grant lookup use the token's claims.
- **Stale tokens die.** Every call under a run token checks that the session's epoch and active turn are still the token's and that it is not cancelled, and answers `409 run_stale` otherwise. A keyed call joins a call already running at the gate only for the same session at the same or a newer epoch, so the new owner's re-send after a takeover keeps working (P1.2, F4.1) and the old owner's is refused. A cancel stops only its own session's call (`403 gate_forbidden` otherwise).
- In process nothing changes: embedding, `startEphemeralRuntime` and Runtimes without the gates service mint no token. No protocol bump: the public API, protocol 5, the Action endpoint wire and `docker/.env` are unchanged. See `DEPLOYMENT.md`.
