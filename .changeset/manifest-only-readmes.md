---
"@nylorun/agents": patch
"@nylorun/cli": patch
---

**READMEs for manifest-only agents.** Documentation only; no code changes.

- `@nylorun/agents`: the Flow agents example opens the PR with an `http()` tool stage instead of a code tool, and shows how to keep a person's approval: a flow stage cannot take `approval` yet (`flow.approval-unsupported`), so the HTTP tool goes to an agent stage with `approval: "always"`. Requests set `Nylorun-Protocol` 8. The subagents section says `ctx.state`, `ctx.agent` and `ctx.ask`/`ctx.approve` apply only to `tool({ run })` in the local engine.
- `@nylorun/cli`: no longer says `nylo endpoints` uses the Runtime API or replaces `nylo tenant endpoints`; it was removed with Action endpoints and exits 2.
