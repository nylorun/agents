---
"@nylorun/runtime": patch
---

**A pod's new volume is seeded through its new engine, never the old one.** A restore or a lost volume moves the pod's host epoch, and the old engine's connection closes only when that reaches every process. A seed that started in between could write the version into the old pod, and the new volume came up without the restored files. A seed now waits for an engine that joined at the Environment's epoch or later, and writes through it.
