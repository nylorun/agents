---
"@nylorun/runtime": patch
"nylorun": patch
---

Pods on Agent Substrate (preview): a wake no longer waits on a DNS lookup of the edge. The sandboxes service pins the edge's name to the address `enable` found in each actor's `/etc/hosts` (when the image lets the engine's user write it), so a restored actor's first lookup, which can be lost, is never made; the exit test's rerun measured 1.15–1.51 s in four of ten wakes from that lookup's retry. `nylorun local sandbox enable --backend substrate` also tries the pod's lookup of the Docker host three times before refusing the context, since a pod's first lookup can find no address on a cluster that just started.
