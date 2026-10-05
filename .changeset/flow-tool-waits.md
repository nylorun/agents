---
"@nylorun/harness": patch
"@nylorun/runtime": patch
---

**A flow agent's tool step that asks now pauses the flow.** A tool step calling `ctx.approve(...)` or `ctx.ask(...)` used to settle its `interaction-required` outcome as the step's output, so the flow moved on and `turn.completed` carried that object, resume token and all. Now the flow session pauses with `turn.paused` and a wait (with the tool node's `path` and `toolName`); `session.approve(...)` or `session.respond(...)` on the flow's own session runs the tool again with the answer and its resume token, and the steps before it replay from the journal. A rejected approval settles the step `denied` without running the tool again, as in an agent's turn, so the turn fails with `tool.denied`. A flow's resume stays in its checkpoint segment (`FlowCheckpoint.resumes`), so its wake is keyed by the interaction. Waits a workflow copied from its linked sessions are no longer read back as its own.
