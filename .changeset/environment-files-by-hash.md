---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
"@nylorun/studio": patch
---

**Files by hash and images by digest (Q6, Q14).** An Environment's `files` entry may name files by content hash, and a pod Environment runs its image by digest once a pod ran it.

- **Files by hash.** `{ path, files: { "<relative path>": "sha256:<hex>" } }` copies each definition file the Tenant holds (`PUT /v1/files/sha256:<hex>`, at most 10 MiB each, at most 1000 per entry) under `path`, before `setup`. A file the Tenant does not hold is refused when the manifest is saved or the Environment made. The engine reads them as a folder through `host/files/{index}`. `@nylorun/agents`: `environmentFiles(path, contents)` hashes them, and `manifests.save(manifest, { files })` and `plan()` upload those the Runtime lacks.
- **Images by digest.** The sandboxes service reports the workload container's `imageID`; the first time a pod is ready the Runtime records it (`pod.imageDigest` in the view) and every later apply runs that digest, so a stop, relaunch or reset never pulls another image under the same tag. A fork pulls afresh. Migration 0027.
- **Studio** lists files by hash on the Environment page.
