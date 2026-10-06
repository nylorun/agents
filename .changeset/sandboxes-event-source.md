---
"@nylorun/core": patch
"@nylorun/runtime": patch
---

The event source `sandboxd` is now `sandboxes`, the name the sandbox lifecycle service took on 3 Oct, matching core, loop, gates, keys, egress and harness. Nothing emits it yet, so no stored event changes; the OpenAPI document's `EventSourceKind` enum shows the new name, and `--service sandboxes` is the blueprint service this release refuses as not yet shipped.
