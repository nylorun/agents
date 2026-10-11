---
"@nylorun/runtime": patch
---

**The harness conformance suite and the example harness, on harness ids (R4.7, R4.8).**

- **A new fixture marker.** `conformance:unoffered <name> <json>` makes the fixture model call a tool the turn does not offer, so a check can see that such a call runs nothing and the turn goes on. The other markers are unchanged.
- **The conformance suite.** `conformance/` (`@nylorun/harness-conformance`, published to npm in this release) checks a harness against a live Runtime through the public Runtime and Management APIs only: checks HC01 to HC19, one JSON line each with `--json`, exit 1 on a failure. The Runtime's tests run it against our harness and the example on every change.
- **The example harness.** `examples/harness-minimal` says `minimal` in `hello`, connects with its own token from `nylorun-operate harness token put minimal`, and runs beside ours: sessions on an Environment whose `harness` is `minimal` go to it. As a pod Environment's `image` it is the pod's harness.
- **A session's workspace is its own harness's.** Off a pod, a session's sandbox routes, `save_artifact` and turn-end export go only to a connection of the session's harness that serves workspaces. Before, a custom harness's session was served from our harness's workspace, which is not that harness's files. Without such a connection the request is refused. Sweeps and removes still go to ours.
- **The Harness API reference and guide.** `guides/HARNESS_API.md` covers every section a harness implements, with a walkthrough for building one.
