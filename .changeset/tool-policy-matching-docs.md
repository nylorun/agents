---
"@nylorun/runtime": patch
"@nylorun/core": patch
---

The tool policy's documentation matches how rules match: `tool` is the tool's identity (an MCP tool's own name on its `server`, or an HTTP tool's declared name), never the model-facing `server__tool`, which is refused; `agent` is the agent manifest's name, or the id of an agent used as a tool or of a flow's agent. `PUT /v1/tenant/tool-policy` describes each selector, and `GET` documents its `409` for a stored rule it cannot apply.
