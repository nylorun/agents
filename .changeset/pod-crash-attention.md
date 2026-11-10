---
"@nylorun/runtime": patch
"nylorun": patch
---

Pods on Agent Substrate (preview): a crash that an idle suspend found now makes the Agent `failing`, and its `attention` names the crash (`compute crashed: Crashed: …`). Before, the crash appeared only in the Agent's events, and the Agent showed as sleeping. The entry stays until a turn starts the pod again, which reverts the sandbox to its last suspend.
