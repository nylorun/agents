---
"@nylorun/core": minor
"@nylorun/runtime": minor
---

**Action endpoints: register them (nothing is delivered yet).** An application registers, for each agent, the URL that will run its Actions. The Runtime stores the registration and its health; deliveries follow in a later release.

- **Routes (application key only).**
  - `PUT /v1/endpoints` registers or updates up to 64 endpoints: `agentId`, `url` (http or https, no credentials or fragment), `implementationVersion`, optional `manifestHash`, `timeoutMs` (default 60 000, at most 840 000) and `maxConcurrent` (default 16).
  - `GET /v1/endpoints` lists them with their health: last delivery, last success, last error, consecutive failures, and what the last ping reported.
  - `DELETE /v1/endpoints/:agentId` removes one.
  - Subjects, subject tokens and executors are refused.
- **One path per agent.** Registering an endpoint removes the agent's executor and ends its streams. `PUT /v1/executors` for an agent with an endpoint is `409`, naming the endpoint to remove first.
- **Health.** Registering the same URL again keeps an endpoint's health; a new URL starts with none.
- **Store.** Postgres migration 5 adds the `endpoints` table and a `deadline_at` column on Actions.
- **Core.** Adds `DeleteEndpointResponseSchema`. The endpoint response schemas are strict.
