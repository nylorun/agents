---
"@nylorun/core": patch
"@nylorun/harness": patch
---

**Workflow functions and tool steps reach the executor.** Several workflow nodes asked the executor for a key that core never registered, so the executor never found the function and the turn waited forever.

- A Map's `over` and a slot's `input` now use the keys core registers (`<path>/over`, `<path>/input`), as Switch's `on` already did.
- A slot `input` that wraps a Map or Switch gets its own effect id, so it no longer collides with the `over` or `on` effect on the same path.
- A slot `id` that renames a nested workflow now renames the keys inside it too.
- A verifier slot's `input` is keyed under the verifier's path (`<loop>/<part>/input`).
- A tool step passes its output to the next step, not the `{ kind: "completed", output }` outcome around it. A denied tool call fails the flow with `tool.denied`.
