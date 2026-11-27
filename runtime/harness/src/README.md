# The harness's source

The engine `@nylorun/harness` publishes: the run entry points, the turn loop, the durable flow engine, the Harness API harness, the engine's own tools, the definition and the saved-state types. `index.ts` is the package's root export and `compatibility.ts` the versions a checkpoint is checked against.

## Interface

- `compatibility.ts`: `CHECKPOINT_VERSION`, `ENGINE_VERSION`, `FLOW_ENGINE_VERSION`, and `checkCompatibility` re-exported.
- `index.ts`: the package's root exports: the run API, the execution and client types, the file model, the sandbox, skill, MCP, tool-search, tool-result and outputs exports.
- [api](./api/README.md): a harness over the Harness API: leases, executors and the DurableHost.
- [definition](./definition/README.md): an agent or a manifest made into the definition a run uses.
- [flow](./flow/README.md): the durable flow engine for workflow manifest v3.
- [loop](./loop/README.md): one turn's loop, its steps, its model calls and its compaction.
- [run](./run/README.md): `run` and `runDurable`, the package's `./run` subpath.
- [tools](./tools/README.md): the engine's own tools and the text the model reads with them.
- [types](./types/README.md): the execution and client contracts.
- [utils](./utils/README.md): the ids the engine mints, deterministic under a seed.

## Rules

- The root exports are only what `index.ts` and `run/index.ts` name; a removed or unexpected export fails `scripts/check-package.mjs`.
- No file here imports `@nylorun/runtime`, `@nylorun/agent`, `@nylorun/studio` or `@nylorun/create-harness`, and none of them is a production dependency (`scripts/check-package.mjs`).
- A checkpoint is refused unless its `version`, `engineVersion` and `manifestHash` match (`run/durable.ts`, `flow/engine.ts`).
- The harness makes no model call: a step hands its `ModelCall` to the host (`loop/step/run.ts`).

## Side effects

- Everything outside the engine goes through the host: a `DurableHost` for every effect, and the Harness API channel in `api/`.
- With a sandbox, a turn's skills are mounted at `/skills/<name>@<hash>/` and its outputs saved as a folder artifact (`tools/skills.ts`, `tools/outputs.ts`).

## Verification

- Run: `npm test` from `runtime/harness/`
