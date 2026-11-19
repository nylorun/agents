---
"@nylorun/studio": minor
---

A session's Usage tab is built around the model call. It opens on the context the agent sent at its last call (with its peak and a sparkline) beside what the session sent in all, and says how much of the resent input came from the cache. One chart shows every call as a thin bar stacked by token kind, in tokens or, with the `#`/`$` switch, in cost, and marks where the context was compacted. New sections list each compaction (when, why, the context the calls measured before and after, and the summary call's time and cost) and each subagent (runs, calls, peak context, tokens, cost). The calls table gains a Context column and tags a subagent's calls and the compaction summary. The session header shows the context the agent sent at its last call, from the session's events; it opens Usage. Every figure comes from the usage and model-call reads and the session's events: no Runtime change.
