---
"@nylorun/runtime": patch
---

A pod Environment pins its image by digest only when the digest is of the repository it asked for. kind names an image it loads onto a node `import-<date>`, and the Runtime pinned `docker.io/library/import-<date>@sha256:…`, which no registry serves: the next pod failed with `ErrImagePull`.
