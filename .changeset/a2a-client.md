---
"@nylorun/agents": minor
---

An A2A client for the Nylorun profile v2 (A2A-E12, E13, E16), on `@nylorun/agents/a2a` and the package root.

- **`createA2aClient({ url, key?, subject?, scopes?, headers?, fetch?, extensions?, cardUrl? })`**: `send`, `get`, `list`, `listAll`, `cancel`, `answer` (an interaction under `interactions/v1`), `card` and `call`, as A2A 1.0 JSON-RPC with `A2A-Version: 1.0` and the five profile extensions activated by `A2A-Extensions`. A subject is sent as `Nylorun-Subject` with `Nylorun-Scopes: sessions:own`. A JSON-RPC error is thrown as `A2aError` (`code`, `message`, `reason` from `google.rpc.ErrorInfo`); an HTTP refusal stays a `RuntimeError`.
- **`verifyA2aPush({ secret, headers, body, toleranceSeconds?, token? })`**: checks a push delivery's Standard Webhooks signature (`whsec_` secret, several signatures allowed, 300 s tolerance) with Web Crypto, and returns its `StreamResponse`; `A2aPushVerificationError` otherwise.
- **`A2A_EXTENSIONS`** and the readers `readInteraction`, `readProgress`, `readTelemetry`, `readEffects`, `readFiles` and `readExtension`, with the profile's types and the A2A 1.0 types (`Task`, `StreamResponse`, `AgentCard`, …; the root's namespace `A2a`).
- **`listTurnChanges({ baseUrl, key, changedAfter?, sessionId?, limit? })`**: the Runtime's change feed, `GET /v1/turns` (Host feature `turns`).
- **SSE idle timeout:** `session.observe` drops a connection that sends nothing, keepalives included, for `idleTimeoutMs` (default 45 s; `0` never) and reopens it from `Last-Event-ID`.
