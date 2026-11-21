---
"@nylorun/runtime": minor
"nylorun": minor
---

Image mirrors for computer images (ADR-161). The sandboxes service's `cluster.json` takes `imageMirrors`, a map from an image repository to the repository that serves the same images, set by the chart's `sandboxes.imageMirrors`. On both backends a workload image in a mapped repository is rendered from its mirror with its digest or tag kept (Substrate still pins a tag against the source first), and the status's `imageID` and Substrate's recorded image name the source repository, so the Runtime pins the digest it asked for. A cluster's nodes pull a private computer image from the cluster's own registry, such as Artifact Registry read with the node's identity, while the same agent folder pulls from the publisher on a laptop or in CI. New guide: `guides/COMPUTER_IMAGES.md`, with a recipe for a coding computer.
