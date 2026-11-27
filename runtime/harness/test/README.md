# The module's tests

`vitest` suites for each part of the engine, the fixtures they share, the evaluation data two suites read, and a type-check project. They run from `runtime/harness` with `npm test`, and `npm run test:types` checks `test/types/`.

## Interface

- `fixtures.ts`: the fixtures the suites share: `objectSchema`, `testAgent`, `tool`, `execution`, `model`, `toolCalls`, `expectBuildError`, `turn`, `addPart`, `toolSet`, `engineConfig`.
- `run-agent.ts`: `runAgent(agent, options)`, which calls `run` with `bindingFromAgent` for a suite.
- `api/`: `harness.test.ts`, `declared-engine.test.ts` and `engine-parity.test.ts`, for a harness over a test Harness API channel.
- `flow/`: `engine.test.ts` and `subagents.test.ts`, for the flow engine.
- `fixtures/`: `compaction-eval.json` and `engine-prompt.json`, the evaluation scenarios and prompts two suites read.
- `types/`: `usage.ts`, checked through its `tsconfig.json` by `npm run test:types`.
- `*.test.ts` at the folder's root: one suite per part of the engine.

## Rules

- `npm test` is `vitest run` from the package (`package.json`).
- A suite for the Harness API or the flow engine sits in `api/` or `flow/`; every other suite sits in the folder's root.
- `test/types/` is checked with `noEmit`, so it emits nothing (`test/types/tsconfig.json`); `npm run test:types` runs it.

## Side effects

- `compaction-eval.test.ts` writes its report to `$NYLORUN_EVAL_REPORT`, or to `nylorun-compaction-eval.json` in the OS temporary directory (`compaction-eval.test.ts`).
- It runs a model only when `NYLORUN_EVAL_MODEL_ADAPTER` names an adapter module, and `NYLORUN_EVAL_ONLY` narrows the scenarios it runs (`compaction-eval.test.ts`).

## Verification

- Run: `npm test` from `runtime/harness/`; `npm run test:types` checks `test/types/`, and `npm run check` runs both.
