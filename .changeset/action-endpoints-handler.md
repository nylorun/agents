---
"@nylorun/agents": minor
---

**Action endpoints: `createActionHandler` (preview; needs a Runtime with the `action-endpoints` feature to register).** An application serves its agents' tools, hooks and workflow functions from one HTTP handler, which the Runtime will call, in place of `connectAgents`.

- `createActionHandler({ agents })` returns `{ fetch, node, register }`. `fetch` is a web-standard handler and `node` serves `node:http` and Express. Each request is verified before any code runs: its delivery token (`Nylorun-Signature`) must be an ES256 token signed by the Tenant's signing key, for this Tenant, this URL, this Action and generation, and the exact body. The Action then runs through the same code executors use, with the request's signal as `ctx.signal`. The answer is the tagged outcome (`Nylorun-Outcome: 1`). An agent or tool it does not serve answers `404`, and a workflow Action for another version of the workflow answers `409`. A token signed with a key the handler has not seen yet (just after a rotation) answers `503`, which the Runtime retries.
- A process that only serves Actions needs no key: set `runtime: { url, tenant }` and it reads the Tenant's public keys, or pass them in `jwks`. Verification uses WebCrypto; the SDK takes no JWT dependency.
- `register({ url })` saves the definitions (`saveDefinitions: false` skips it), registers the URL for every served agent, and pings each one through the Runtime. It refuses a Runtime without `action-endpoints` before sending anything.
- `ctx.sandbox` calls back with the delivery token. `createActionSandbox` accepts no claim for this case, and `Transport.withKey` copies a transport with another bearer, sharing its compatibility check.
