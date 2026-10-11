---
"@nylorun/runtime": patch
---

**The Runtime's own tokens never reach a session's record from what a harness reports.** A harness's commands hold the egress token in their proxy variables, and a command that prints its environment, or a model that repeats it, would put that token into a tool result. Core now replaces every Nylorun-signed token before recording it:
- where it looks: tool and model outcomes, error messages, claimed sandbox events, and a turn's output, state and transcript edits;
- what a token is: a compact JWT whose `typ` starts with `nylorun-`, such as egress, run or host tokens;
- what replaces it: `[nylorun token redacted]`.

This applies to every harness, ours included. The harness conformance suite found the leak (HC14) when it ran the example harness as a sandbox pod's image. Other values are unchanged.
