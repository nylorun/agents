# Changelog

## 0.19.1-beta

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [bf1c2da]
- Updated dependencies [ba1b239]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
- Updated dependencies [bf1c2da]
  - @nylorun/core@0.6.0-beta

## 0.19.0-beta

### Minor Changes

- fd9fd87: Add workflows: compose agents and `tool()` with `Chain`, `Switch`, `Parallel`, `Map`, and `Loop`. A workflow is a registered runnable (`kind: "workflow"`) with the same session API as an agent — `export const agents`, `saveAgent` (saves referenced agents first), `createSession`, `input` (`content` or `data`), `observe({ follow })`, `pending`, `approve`, `cancel`. Slots (`{ run, id?, input? }`) reshape data between nodes. The flow engine (`runFlowDurable`) returns effects only; `harness/src/loop/` and `runDurable` are unchanged.

  HostEffect gains flow kinds `agent`, `tool` (node), `fn`, and `verify`, each with `path`, `key`, and `iterations`. The Runtime drives agent nodes through the public session contract (linked sessions, shared sandbox via `PutSession.sandbox`), offers `fn` / `verify` again on lease expiry, and routes executor Actions by `(workflowId, key)` with claim-scoped `ctx.sandbox`. Optional `message.manifest` is a turn-only variant of the session pin (turn manifests). Studio shows the manifest tree, live node status, and session links. Examples under `examples/agents/{chain,switch,parallel,map,loop,ship-feature}/`.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [c49efed]
- Updated dependencies [c49efed]
- Updated dependencies [fd9fd87]
  - @nylorun/core@0.5.0-beta

## 0.18.0-beta

### Minor Changes

- 1cd7dc7: Add subagents: put an agent in another agent's `tools` (`Agent({ tools: [lookupOrder, researcher] })` or `.use({ tools: [researcher] })`) and the model can delegate to it. The tool is named after the agent's id, takes `{ task: string }`, and its description is the agent's `description`, which is now required for an agent used as a tool. The engine runs the child inside the parent's turn as a durable branch: fresh context, its own tools and hooks served by the root agent's executor, its own MCP servers, the session's sandbox, and only its final output (or `outputSchema` result) returned. Empty output, failures (with partial output marked as evidence), and requests for input or approval inside a child reach the parent as failed tool results. Parallel delegation calls run concurrently, completed child work is never re-run on replay, and cancelling the session cancels every child.

  v1 is one level deep and non-interactive. Nested delegation, child tools that declare `approval`, and differing sandboxes across the tree fail the build with a named diagnostic. The manifest adds an optional `agent` body on a tool (schema version unchanged), actions and effects carry `agent: { id, path, delegationId }`, tool context gains `ctx.agent`, the durable host resolves a new `delegation` effect kind, and the Runtime emits `delegation.started` / `delegation.completed` events and filters history with `?agent=` (`session.history({ agent })`). Studio shows delegations, labels child actions with their agent, and filters events by agent.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [1cd7dc7]
  - @nylorun/core@0.4.0-beta

## 0.17.0-beta

### Minor Changes

- b8d822a: Breaking beta: replace `beforeModelCall` / `afterModelCall` with scoped hooks. Register `before("turn" | "step", fn)` and `after("step" | "turn", fn)` on the agent, or `before: { turn, step }` / `after: { step, turn }` on a capability. `before("turn")` runs once per turn and its `Patch` applies to every model call in the turn; the new `after("turn")` returns a `TurnDecision` for the final answer. `after` hooks take one argument and receive `attempt`, and `retry` now retries instead of failing the run. The manifest moves to `manifestSchemaVersion: 4` with `capabilities[].hooks`, and `BeforeModelCallFn`, `AfterModelCallFn` and the `beforeModelCall` / `afterModelCall` action kinds are removed. Every capability registered at a hook point now runs in one `hook` executor action, an expired hook claim is offered again instead of becoming uncertain, and the durable engine version is `hosted-2`. Hook toggles now hide a capability's tools, or one tool of a multi-tool capability, instead of having no effect or failing. Studio lists each capability's hooks with how often they run and labels hook actions. See MIGRATION.md.

### Patch Changes

- b8d822a: Studio Model Settings lists multiple vault-stored providers, adds credentials through a sheet, and switches the active provider/model via Runtime host vault APIs.
- Pin core to the tested release.
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
- Updated dependencies [b8d822a]
  - @nylorun/core@0.3.0-beta

## 0.16.0-beta

### Minor Changes

- 3a88f51: Ship Agent-Plugins (`plugin()` / `loadPlugin`), Skills (`load_skill` / skill resources), Runtime MCP pool + vault credentials, and manifest v3 capability fields. Validate completed tool `output` against the tool output schema so ordinary tools with `outputSchema` no longer false-fail as `tool.invalid-output`.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [3a88f51]
  - @nylorun/core@0.2.0-beta

## 0.15.0-beta

### Major Changes

- 2898d02: Extract shared definitions and contracts into core and local orchestration into
  CLI. Harness becomes execution-only; the SDK no longer installs the engine and
  Runtime no longer depends on the SDK. Author applications through agents and
  install cli for the unchanged nylorun commands. See the package architecture and
  migration guide. Cloud installs published packages from npm independently.

### Minor Changes

- 41e613c: Ship the local SDK registry workflow with an independent SQLite Runtime, connected tool executor, authenticated Studio proxy, and a text-and-tool starter. Replace the legacy Hono starter and AG-UI transport. Require Node 24 and include the SDK in exact release compatibility pins.

  Break the Harness execution import from `/engine` to `/run` and rename hosted execution APIs to durable execution APIs, including RunBinding, BoundRunOptions, and createRunState. Update all consumers without compatibility aliases; retain persisted checkpoint fields and version pins.

### Patch Changes

- Pin core to the tested release.
- Updated dependencies [2898d02]
  - @nylorun/core@0.1.1-beta

## Unreleased

### Minor Changes

- Breaking beta: replace `/engine` with `/run`; rename hosted execution to durable execution.
  Use `runDurable`, `createDurableCheckpoint`, `DurableCheckpoint`, `DurableResult`,
  `DurableHost`, `RunBinding`, `BoundRunOptions`, and `createRunState`. No aliases remain.
  Persisted checkpoint fields and the `hosted-1` compatibility pin are unchanged.

- Breaking beta: the package root is now an alias of `/define`. Import
  `createExecutionState` / `validateExecutionState` from `@nylorun/harness/run` and
  `preparedModel` from `@nylorun/harness/model/adapters`. Authoring and wire-contract specifiers remain unchanged.
- Internal source folder `execution/` is now `loop/` (one `run()` invocation). The
  `/model/adapters` specifier is unchanged.
- DX v5.6: Agent usable without `.build()`; `.use()` returns a new agent; top-level `tools` /
  `instructions` (no `model` on `Agent({})`). `tool()` accepts `input` / `output` / `run`; plain
  returns complete; export `ToolError`; tool `approval` / `effects`; `ctx.idempotencyKey`,
  `redelivery`, `state`, `session`, `progress`, and durable waits (`ask` / `approve` / `sleep` /
  `waitFor` / `step`).
- Agent-as-JSON: versioned manifest (`schemaVersion: 2`), `toJSON` / `Agent.from`, `hashManifest`,
  `checkCompatibility`; identity by manifest hash (not WeakMap-only). Session memory on
  `ExecutionState.state`. Capability `model` is no longer projected into the published manifest.
- Dynamics: `beforeModelCall` / `afterModelCall` with `Patch` / `Decision`; middleware deprecated
  but kept through 1.0. Export `@nylorun/harness/run` for run-from-checkpoint; `agent.run` is a
  1.0 alias. Export type-only `Session` / `Turn` / `Event` / `Result`.

## 0.13.0-beta

### Minor Changes

- Breaking beta: replace `AgentManifest.middleware` with a capability catalog. The published
  snapshot is `id`, `name`, optional `outputSchema`, and `capabilities` (`kind`,
  `hasMiddleware`, declared instructions / tool JSON schemas / model controls). Join traces by
  capability id. `MiddlewareManifest` is removed; import `CapabilityManifest`.
- Breaking beta: expose `BuiltAgent` as a type-only facade from `Agent(...).use(...).build()`.
  Hide compiled middleware, tool registries, and output validators. `AgentBuilder` accepts public
  agent options. `createExecutionState` requires the original built agent. Drop agent-level
  `executionVersion`; `ExecutionState.version` stays `1` and leftover keys are ignored. Model
  adapters receive immutable `ToolDescriptor` metadata only. Remove `defineToolFamily` /
  `ToolFamily` / `capability.toolFamilies` and the internal Bound\* / `SealedToolCall` root
  exports. Rename the per-run bag from `scope` to `info`.
- c5bbb1a: Breaking beta: make Harness `run()` a direct async state-in/state-out executor with
  serializable pauses, application `info`, cancellation signals, awaited recording, and
  agent-level output schemas. Runtime owns session scheduling with memory-default or exclusive
  local storage and imports Harness contracts. Isolate Node adapters under `runtime/node`, stream
  observations incrementally, and add opt-in bounded token previews with Studio reconciliation.
  Migrate consumers and deployment guidance together; legacy event records remain archived, not
  automatically replayed.

## 0.12.0-beta

### Minor Changes

- 4badb5b: Move model execution to session startup, provide Runtime as a mountable Hono router, and generate Hono-first projects with supervised application and Studio development. Studio now resolves root-relative Runtime endpoints correctly for custom mount paths.

## 0.11.1-beta

### Patch Changes

- d27242c: Preserve opaque provider continuation metadata through assistant conversation history. Gemini tool calls now retain thought signatures when sending tool results back to the model, including signed empty text and reasoning blocks. Only the originating provider and model receive their signatures.

## 0.11.0-beta

### Minor Changes

- 54ab304: Support portable Runtime protocol version 2 while retaining legacy Studio
  manifest support. Move the Studio CLI into Runtime: use `nylorun studio
--agent-url <url>` instead of `nylo studio`. Applications should install Runtime
  directly and keep Studio as a development dependency.

  Retain session lists and media across development reloads, and recognize agent
  file changes on Windows. Validate noninteractive creator startup during release
  verification with deferred provider configuration.

  Include Harness in this release so the creator does not rely on an unpublished
  compatibility pin. Ship and verify all four packages together.

All notable changes to `@nylorun/harness` are documented in this file.

The project follows [Semantic Versioning](https://semver.org/). Before 1.0, the public API is experimental: breaking changes may occur in minor releases, while patch releases are reserved for compatible fixes.

## Unreleased

## [0.10.0-beta.1] - 2026-09-03

### Added

- Portable ordered media input parts with opaque JSON references preserved through sessions,
  transcripts, middleware, model calls, and observations.
- `preparedModel()` for adapters that need to materialize a provider request while exposing the
  JSON-safe derived call through the new `model.prepared` observation.
- Direct `inputSchema` and optional `outputSchema` tool contracts. Harness accepts Zod v4,
  synchronous Standard Schema values with JSON Schema conversion, and explicit validator-backed
  `defineSchema()` contracts.
- Structured input and output validation diagnostics on failed tool results.
- Per-turn `session.input({ ... }, { outputSchema })` contracts for locally validated terminal JSON
  results, including canonical model-call projection, JSON candidates, immutable final persistence,
  and `output.invalid` tripwires.

### Changed

- Bundled provider translators map direct URL image references and fail unsupported media with the
  stable `model.unsupported-content` error rather than dropping or stringifying it.
- Chat Completions and Responses translators project terminal output schemas without choosing
  provider strictness; Anthropic Messages reports `model.unsupported-output-schema` until an
  application supplies a custom prepared adapter.
- Tool definitions use `inputSchema` instead of `parameters`. Completed output is validated when an
  `outputSchema` is supplied; the resulting JSON is the same value recorded, observed, and sent to
  the model. Model configuration and `model.requested` observations expose optional output schemas.

### Breaking changes

- Replace every tool `parameters` field with `inputSchema`. `outputSchema` is now an optional tool
  contract and completed tool output may be any JSON value, not only a string.
- Terminal results, final events, and stream projections may now be JSON values. Consumers that
  assumed string output must render or serialize `JsonValue` safely.
- Custom model adapters receive the `reportPreparedCall` context method. Adapters that materialize
  provider requests should use it (or `preparedModel()`) to emit one JSON-safe derived request.

## [0.9.0-beta.1] - 2026-09-02

### Added

- Public provider translator helpers under `@nylorun/harness/model/adapters` for OpenAI-compatible
  Chat Completions, OpenAI Responses, and Anthropic Messages model loops.
- `MiddlewareManifest` and declared middleware contributions in `AgentManifest`, including static
  instructions, tool metadata, and model controls for host tooling such as Studio.

## [0.8.0-beta.1] - 2026-08-31

### Breaking changes

- `Agent()` now takes identity options instead of a model adapter. Migrate
  `Agent(adapter).use(...).build()` to
  `Agent({ id, name, instructions }).use(...).with(adapter).build()`.
- `.build()` exists only on `BoundAgentBuilder`, the type returned by a single `.with(onModelCall)`.
  `AgentBuilder` has `.use()` and `.with()` only.
- `AgentManifest` now includes `id` and `name`. Built agents expose the same fields as `agent.id`
  and `agent.name`.

### Added

- Optional constructor `instructions` compile as reserved `agent` middleware. A string is
  normalized to one instruction. Capability-specific instructions still go through `.use()`.

## [0.7.0-beta.1] - 2026-08-30

### Breaking changes

- Removed the bind-time directive argument: migrate `Agent(adapter, directive)` to
  `Agent(adapter).use({ id: "model", model: directive })`. `AgentManifest.model` is removed.
- Added `CapabilityDeclaration` support to `.use()`. A declaration owns one capability id, static
  tool/instruction/model contributions, and optional inline middleware.
- `ToolExecutionContext` now includes session, turn, step, and call identities.

### Added

- Declarations may own typed lazy session state through `CapabilityState`. State is shared only by
  that declaration's middleware and tools, is cold after seed recovery, and is disposed on
  `session.stop()` or recording failure.
- Added `capability.state.dispose.failed` observations for best-effort disposal failures.
- Added `capability.state.undeclared`, raised when session state is requested for a capability that
  declared none.

### Documentation

- Added concise package guidance for direct agent composition and the capability/service/host/core model.

## [0.6.0-beta.1] - 2026-08-29

### Breaking changes since 0.5.0-beta.1

- Removed tool adapters, `.with()`, `executeWith`, preflight, adapter concurrency controls, custom scheduling, adapter manifest fields, and adapter observations/errors.
- Tools now own their implementation through `execute(args, context)`. Harness centrally executes eligible siblings concurrently and commits normalized results in model-call order.
- Tool results are explicit `completed`, `denied`, and `failed` discriminated unions. Tool and model implementations may return `deferred` for a runtime handoff.

### Added

- Structural `SessionSeed` import through `agent.run({ seed })` and no-input `session.continue()`. Core validates typed JSON but deliberately leaves historical semantics and provider protocol validation to the host and model adapter.
- Optional awaited `SessionRecorder`, immutable full-state `SessionRecord` values, monotonic revisions, and effect barriers around input, model requests, candidates, tool results, waiting, final, and stop transitions.
- JSON-safe active model/tool/interaction records with stable invocation identities, tool ownership provenance, settled/deferred state, and opaque handoff tokens.
- `model.deferred`, `tool.started`, `tool.completed`, `tool.deferred`, `session.seeded`, `session.continued`, and `session.record.failed` observations.

### Reliability

- Recorder failure now fences later model/tool effects, quarantines late results, stops queued work, preserves the last successfully recorded revision, and exposes `session.record-failed` with the storage error as its cause.
- Deferred sibling batches settle fully without committing a partial model-facing `tool-results` entry.

## [0.5.0-beta.1] - 2026-08-28

### Breaking changes since 0.4.0-rc.1

- Replaced persistent `prefix` configuration with per-step `configuration`. Instructions, tools, model selection, and runtime context are assembled afresh for every model call; slot removal, context lifetimes, strict prefix policy, and Harness-owned drift auditing were removed. Middleware receives `turnId` and `stepId` to coordinate application-owned state.
- `model.prefix` and `model.started` were replaced by `model.requested`, emitted immediately before adapter invocation with the exact immutable `ModelCall` and JSON-safe attributed configuration/context snapshots.
- `tool()` now validates and normalizes its synchronous Zod object schema eagerly; raw tool literals retain first-bind preparation.

- Model adapters now receive the projected `ModelCall` as their first argument and `{ request, signal }` as their second. Implementations that consumed the prior request-shaped input must migrate to the projection and use `request` for the structured escape hatch.
- `InputHandle.consume()` and `AgentRunInput` were removed. Submit messages and interaction replies through the Session input API and await the returned completion handle instead.
- `session.observe()` now returns an idempotent unsubscribe function rather than the previous observer result. Observers remain live-only and do not replay history.
- Tool adapters and the tool facade removed the prior route-validation and route metadata methods. Tool definitions use `parameters` and `executeWith`; dispatch validation happens at the sealed Harness boundary.
- Harness-owned failures now use `HarnessError` with stable machine-readable codes. The prior outcome-code model has been replaced; see the migration table in the README for renamed and split codes. Foreign application, model, and adapter errors remain available as causes.

### Added

- `ModelCall` projection, including canonical system text, transcript messages, provider tool contracts, model directive, and session id.
- Explicit abort propagation through the Model adapter context.
- Stable structured Harness errors via `HarnessError`, `HarnessErrorCode`, and `isHarnessError`.
- Parallel sibling tool execution by default, with an optional shared per-adapter `maxConcurrentCalls` limit on `.with(adapter, options)`.

### Fixed

- Observe attributes are materialized only when a listener is registered. Transcript snapshots on `step.started` share the already-frozen step transcript rather than deep-copying it on every step.

[0.5.0-beta.1]: https://github.com/nylorun/harness/tree/main/harness
[0.6.0-beta.1]: https://github.com/nylorun/harness/tree/main/harness
[0.7.0-beta.1]: https://github.com/nylorun/harness/tree/main/harness
[0.8.0-beta.1]: https://github.com/nylorun/harness/tree/main/harness
[0.9.0-beta.1]: https://github.com/nylorun/harness/tree/main/harness
