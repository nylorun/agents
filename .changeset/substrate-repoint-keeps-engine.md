---
"@nylorun/runtime": patch
---

Pods on Agent Substrate (preview):

- **A Runtime upgrade no longer strands existing pods.** Agent Substrate repoints an actor only to a template with the same volumes, and the engine is an image volume pinned by the Runtime image's digest. So after an upgrade, every existing pod's start failed and was sent again every 2 seconds without end, and only a reset got out, at the cost of the pod's disk. An actor now keeps the engine it was created with. An upgrade keeps the pod, its `/workspace` and `/harness`, and it starts as before. The pod runs its first engine until a new incarnation (a reset). The Runtime's Harness API check at `hello` still guards it.
- **A change Substrate can't make to an existing pod fails its start with the reason.** This is any other volume change, such as switching between the image's engine and the Runtime's, or a template Substrate refuses. The sandbox reports `RepointRefused` with why, the Runtime's ready deadline fails the start, and the request is not sent again.
- **A crashed actor is reverted before its template changes**, as Substrate requires. Before, a new spec for a crashed pod failed without end.
