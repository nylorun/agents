---
"@nylorun/core": patch
"@nylorun/runtime": patch
"@nylorun/agents": patch
"@nylorun/admin": patch
"nylorun": patch
---

**Docs: reaching a person's accounts** (R2b C5). The READMEs describe MCP credentials as protocol 10 has them (a `bearer` token or a `headers` map per URL, with `via` and an identity header for an MCP gateway), and point to "MCP servers and HTTP tools" in DEPLOYMENT.md: the operator's flow from credential to preview, tool settings, deferral, stored results and the error codes a model sees, with gateway recipes for Arcade, ToolHive, Obot and Nylorun Cloud and the proxy pattern for gateways that mint per person. `HttpToolTarget.credential`'s doc (`@nylorun/core`) no longer names the removed credential resolver.
