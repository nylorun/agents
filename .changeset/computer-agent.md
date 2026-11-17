---
"@nylorun/runtime": minor
---

Computers can run the computer agent (ADR-154 decision 4): a static Go binary (`sandboxes/cmd/computer`, the image `ghcr.io/nylorun/computer`, versioned by its protocol) that serves the computer's routes with the same tickets and answers as `--service computer`, which a contract test runs against both. The sandboxes service takes `--computer-agent go|engine` and `--computer-image`; with `go`, a computer's template mounts the agent's image at `/nylo` and runs `/nylo/computer`, and an existing computer keeps the agent image it was created with. The chart's `computer.agent` (default `go`) and `computer.image` pass them, and the pre-pull warms the agent's image. Moving a Tenant's computers from the engine to the agent gives each a new volume from its latest disk version, and versions taken before this release hold nothing of the computer, so an existing computer starts empty (MIGRATION.md).
