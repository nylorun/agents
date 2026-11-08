---
"@nylorun/runtime": patch
---

A turn that waits for its pod to start on a new Agent version runs as soon as the new pod's engine connects. The start check's pass now wakes the Agent's sessions with a turn waiting, instead of leaving them to the advance's next retry, up to `tenant.unavailableRetryMs` (1 s) later. It saves up to 1 s on each person's first wake after their Agent moves to a new version.
