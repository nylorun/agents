# Deterministic identifiers

Mints the ids the engine puts on what it creates, and can make them reproducible. Inside a seeded scope `createId` counts calls per prefix instead of drawing a random UUID, so the same work run again makes the same ids, which the effect journal needs.

## Interface

- `withDeterministicIds(seed, fn)` (`ids.ts`): runs `fn` in a seeded scope held in an `AsyncLocalStorage`.
- `createId(prefix)` (`ids.ts`): `<prefix>_<uuid>` outside a scope; `<prefix>_<seed>_<count>` inside one, counting each prefix from 1.
- `withNestedIds(suffix, fn)` (`ids.ts`): runs `fn` in a scope of its own, seeded as `<seed>_<suffix>`, so concurrent work stays deterministic.

## Rules

- Each prefix has its own counter, and a nested scope starts its counters at zero (`ids.ts`, `createId`, `withNestedIds`).
- Outside a seeded scope ids are random, never counted (`ids.ts`, `createId`).

## Side effects

- None found.

## Verification

- Run: `npm test` from `runtime/harness/`
