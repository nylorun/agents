---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
---

An agent keeps a durable plan (A2A profile v2, `progress/v1`; A2A-E10).

- **`plan.updated`**, a new durable session event: `{ steps: [{ label, state, note? }] }`, the agent's whole plan each time, never a diff. `state` is `pending`, `active`, `done`, `blocked` or `skipped`; at most 20 steps, labels of at most 120 and notes of at most 280 characters (`PLAN_LIMITS`, `PLAN_STEP_STATES`, `PlanUpdatedPayloadSchema` in `@nylorun/core/contracts`). The Runtime records and serves it like any public event, with the harness as its writer (evidence `claimed`), and the OpenAPI document lists it.
- **`update_plan`**, a built-in tool of our engine, off by default. A version opts in with `harness.loop.plan: true` (in an agent folder, `loop: { plan: true }` in `AGENT.md`'s frontmatter); the session's root agent then gets the tool, unless it declares its own tool of that name. A call takes `{ steps: [...] }`, cuts long labels and notes (ending in `…`) and steps past 20 rather than refusing them, claims one `plan.updated` and answers `Plan updated`. A malformed plan is a failed result the model sees.
- **Harness API**: `plan.updated` is a claim a harness may make (`HARNESS_CLAIMS`), additive within v5. The JSON Schema document is now published as `https://docs.nylorun.com/schemas/harness-api/v5.1.json`; `v5.json` is retired.
- The agent folder compiler takes `loop.plan` (true or false) and suggests it for a close typo.
