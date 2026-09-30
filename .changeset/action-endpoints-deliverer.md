---
"@nylorun/core": minor
"@nylorun/runtime": minor
---

**Action endpoints: the Runtime delivers Actions (Host feature `action-endpoints`).** For an agent with a registered endpoint, each tool call, hook and workflow `fn`, `verify` or tool node is POSTed to the endpoint and the answer settles it. Agents without one keep their executors.

- **The request.** `{ type: "action", action, sandbox }`, with a delivery token in `Nylorun-Signature` (for this Tenant, URL, Action, generation and body) and the Action id as `Idempotency-Key`. Deliveries of one Action never overlap, and at most `maxConcurrent` are in flight per endpoint.
- **The answer.**
  - `200` with `Nylorun-Outcome: 1` is the outcome. A plain `200` is a tool's output, or what an `fn` or `verify` returned; the tool's output schema still applies.
  - `202` means the result comes later.
  - `429` and `503` (honouring `Retry-After`), a version mismatch (`409`) and anything that never reached the endpoint are retried, backing off from 250 ms to 30 s. The failure is reported as `action.delivery_failed` at most every 10 s.
  - Any other `4xx`, or a `3xx` (redirects are not followed), fails the Action with `endpoint.rejected`.
  - No answer after sending (timeout, reset, `5xx`) loses it: a tool becomes `uncertain`; a hook, `fn` or `verify` is delivered again. A delivery whose deadline passes (a Worker died) is lost the same way, by the Tenant sweep.
- **Cancel.** A cancelled turn aborts the request at once. The code may have run, so the Action becomes `uncertain`, as a claimed one does.
- **Events and health.** `action.delivered` and `action.delivery_failed` are new events. Endpoint health records successes and failures.
- **Ping.** `POST /v1/endpoints/:agentId/ping` sends a signed ping and records what the endpoint serves. It answers `502` when the endpoint doesn't answer.
- **Host settings.**
  - `NYLORUN_ENDPOINT_LOOPBACK=docker-host`: in the local stack, `localhost` means the Docker host.
  - `NYLORUN_ENDPOINT_PRIVATE` (`allow`/`refuse`): checked on the address actually connected to.
  - `NYLORUN_ENDPOINT_HTTP` (`allow`/`refuse`).
- **Executors unchanged.** Executor results and deliveries record outcomes through one function, so the two paths behave the same.
