---
"@nylorun/runtime": patch
---

**The runtime image keeps the repository's new layout.** The Runtime's code moved to `runtime/server/` and the harness to `runtime/harness/` in the repository, and the image follows it: the entry point is `/app/runtime/server/dist/host/main.js` (was `/app/runtime/dist/host/main.js`). The image's `ENTRYPOINT`, `nylorun-operate` and the sandboxes service (`ghcr.io/nylorun/sandboxes`, released with the Runtime) use the new path; anything that runs a file under `/app/runtime/dist/` directly needs the new one.
