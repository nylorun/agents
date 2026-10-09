---
"@nylorun/studio": patch
---

**Studio: create and rotate shell credentials.** The Credentials page's Add credential form gains **Secret** and **Variable** (R2c), for skills' CLIs in pod sandboxes. A secret takes the variable name the sandbox sees (as `nylorun-managed`), its allowed hosts, an optional header and format (default `Authorization: Bearer {value}`, with a preview of what requests carry) and its value; a variable takes a name and a visible value. Hosts are checked in the form, naming the entry the Runtime would refuse. Rotate replaces a secret's value; **Change value** edits a variable from its current value. The table shows a secret's variable and hosts and a variable's value; **Preview tools** stays on MCP credentials only.
