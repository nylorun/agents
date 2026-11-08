---
"@nylorun/harness": minor
"@nylorun/runtime": patch
---

An agent that keeps a plan is reminded to move it. When a turn set its plan with `update_plan` and has made 8 more tool calls without calling it again, while the plan still has an open step, the next model call ends with one line naming the step the plan says is current and asking the model to call `update_plan` if that step is done or another has started. It comes again after every 8 more calls. The reminder is read from the transcript alone, so a replay sends the same prompt, and it is never written into the transcript. Models that set their plan once and never move it left callers watching step 1 until the end.
