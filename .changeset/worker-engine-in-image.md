---
"@nylorun/core": minor
"@nylorun/runtime": minor
---

An image can carry the Runtime's engine (ADR-99). A pod of an image the Tenant lists in
`engine.images` (`PUT /v1/tenant/sandbox`) runs the engine under `/opt/nylorun` with nothing copied
in: the sandboxes service's new `entrypoint: "builtin"`, without the `nylo-copy` init container and
the `/nylo` volume. Such an engine reports its Runtime version at join (header
`nylorun-image-engine`), the Agent's record keeps it beside its pinned image digest, and a pod runs
it only while it is the Runtime's own version; otherwise the engine is copied in as for any image.
New column `agents.engine_image` (migration 0042).
