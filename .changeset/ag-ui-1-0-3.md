---
"@nylorun/runtime": patch
---

The AG-UI endpoint follows AG-UI 1.0 more closely, on `@ag-ui/core` 1.0.3. `RUN_STARTED` now declares `protocolVersion: "1.0"`, which 1.0 asks every producer to set. A run from a client older than 1.0, which sends `null` for optional fields such as `forwardedProps`, `parentRunId`, `tools[].parameters`, `resume[].payload` or a media part's `metadata`, is now accepted, with those fields treated as absent; it used to be refused with `400 Invalid RunAgentInput`.
