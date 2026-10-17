---
"@nylorun/core": patch
"@nylorun/runtime": patch
---

A flow's HTTP stage or HTTP verifier, and an HTTP tool of an agent the harness section embeds (a flow's `agents`, or an agent used as a tool), now has its `credential` checked when the manifest is saved, as an agent's own HTTP tool has: it must name a `bearer` or `headers` slot of `runtime.secrets` bound to its URL, or the save is `422 manifest_inconsistent` naming it (`harness.root stage "refund" http.credential "checks" is not a secret slot in runtime.secrets`). Before, such a manifest saved and each call failed at run time with `http.credential`.
