---
"@nylorun/runtime": patch
---

The Model Gate reads only the files a session may read: its own artifacts and the Tenant-wide ones its messages named, as `read_artifact` does. Before, a model call could name any Tenant-wide artifact and the gate sent its bytes to the provider.
