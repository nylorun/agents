---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
---

**Choose a session's sandbox when you open it.** `createSession({ sandbox })` (`PutSessionRequest.sandbox`) now takes `false`, `{ session }` to share, or an inline sandbox: `image`, `network.allow` and `resources`. Omit it for the Tenant's default. The agent definition needs no `.sandbox()`: the Runtime resolves the request against the Tenant's limits, pins it on the session and adds the six sandbox tools to that session only (capability `nylorun.sandbox`). The registered definition is unchanged.

- **Tenant configuration.** `GET /v1/tenant/sandbox` adds `config`; `PUT /v1/tenant/sandbox` sets `default` (`none`, `virtual` or an inline sandbox) and `limits` (`network` ceiling, `resources` maximum, `defaultResources`, `idle`). Unset, a Tenant's default is `none` and its ceiling is the package registries and code hosts of today's `dev` preset. `SeedTenantConfigRequest.sandbox.config` seeds it.
- **Checks at open.** A request outside the limits is a `400` that lists every problem. An inline sandbox from a caller acting for a subject is a `403`; such callers get the Tenant default or `false`. An `image` is refused: the virtual sandbox has no images. The sandbox is fixed for the session's life: a different one on a later `PUT` is a `409`.
- **Trees inherit.** The agent sessions of a flow agent, the agents a session uses as tools, and sessions attached with `{ session }` use the sandbox the session was opened with, and get its tools.
- **Compatible.** An agent that declares `.sandbox()` keeps working as before; opening its session with a `sandbox` value is a `400` that says to remove `.sandbox()` from the agent.
