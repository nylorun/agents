---
"@nylorun/runtime": minor
---

**Action endpoints: delivery tokens (groundwork; no route accepts them yet).** The Runtime can sign a token for one delivery of one Action, and recognises it when it comes back as a bearer.

- **The token.** An ES256 JWT signed with the Tenant's current signing key. Its `typ` is `nylorun-delivery+jwt`, `iss` is the Tenant, `aud` is the endpoint URL, `sub` is the Action id (or `ping`), and `agt`, `gen` and `bdy` carry the agent, generation and body hash. It lives at most 900 s.
- **As a bearer.**
  - A delivery token reaches only the routes that list it, and none does yet (every other route answers `403`).
  - It is refused from browsers (`origin_rejected`) and cannot act for a subject.
  - An expired token or a revoked key is `401 token_expired`; anything else, a ping token included, is the opaque `404`.
- **Key rotation.** It now waits for the longest token either kind may have signed, so a delivery token is never revoked while it is live, even under a short subject-token policy.
- Subject tokens share their header checks with delivery tokens (`tenant/jwt.ts`), with no change in behaviour.
