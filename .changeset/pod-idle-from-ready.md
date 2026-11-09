---
"@nylorun/runtime": patch
---

A pod Agent's idle period now runs from when its pod became ready, not from when it was asked to start. A slow start, such as a cold node pulling the image, no longer uses up the idle period: on the Agent Substrate exit test, a pod that took 56 s to start was suspended as idle 3.6 s after it could first take a turn. Becoming ready moves the pod's last activity to that moment, which the idle timer, the idle decision and the Tenant's sweep all read.
