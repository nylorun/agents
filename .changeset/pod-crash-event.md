---
"@nylorun/runtime": patch
"nylorun": patch
---

Pods on Agent Substrate (preview): a crashed sandbox is now recorded in the Agent's events. A running pod whose sandbox crashed is `failed` at once, rather than after the 5-minute ready deadline. A crash that an idle suspend finds is also recorded, where before the Agent showed only `agent.suspended`. In both cases `agent.failed` gives Substrate's crash message and says that what the Agent wrote since its last suspend is lost. The next turn reverts the sandbox to that suspend, as before. The sandboxes service now reports the crash's own message in place of the whole crash record.
