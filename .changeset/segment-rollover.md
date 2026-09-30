---
"@nylorun/harness": minor
"@nylorun/runtime": minor
---

**Long turns roll over.** A turn no longer fails when it runs past the 50-minute advance deadline.

- **How it works.** At a step boundary with no open work, a long turn ends its segment and continues in the next one: same turn, a new checkpoint, woken at once. By default this happens after 50 steps or 20 minutes in a segment; `TenantConfig.rollover` changes both.
- **What clients see.** A rolled-over turn emits no `turn.*` event, and clients still see one turn.
- **Storage.** Each finished segment's model effects are slimmed.
- **Harness.** `runDurable` takes `yieldAfter: { steps, ms }` and can return `yielded`, and `RunResult` adds `yielded`. The durable host writes the next checkpoint at `segment + 1` with `{ kind: "continue" }`. Agents used as tools never roll over.
