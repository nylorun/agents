---
"@nylorun/runtime": minor
---

A pod starts faster and its commands can install what they need (ADR-92).

- **The pod copies a bundled engine.** The Runtime image ships the pod's engine (`--service harness`) bundled into one script, with the one native addon it loads, as `/engine`: 12 files instead of `/app`'s ~30,000. The sandboxes service's `nylo-copy` copies `/engine` when the image has it, and `/app` otherwise, and the workload runs `/nylo/entry.mjs`. On beta's GKE cluster the copy went from 6–29 s to 0.2 s, and the engine's start from 7.2 s to 3.7 s.
- **A pod's disk is owned once:** `fsGroupChangePolicy: OnRootMismatch`. A mount of a disk holding 91,000 files went from 15–21 s to 3–8 s.
- **Commands run with bash** where the image has it (`/bin/bash -c`), as the `bash` tool says; `/bin/sh -c` only in an image without bash.
- **Node uses the proxy.** `NODE_USE_ENV_PROXY=1` joins the proxy variables a pod's commands get, so Node's `fetch`, and corepack's pnpm and yarn, reach the egress gate.
- **The dev preset allows toolchain downloads:** `nodejs.org`, `releases.astral.sh`, `static.rust-lang.org`, `sh.rustup.rs`, `dl.google.com`, `mise-versions.jdx.dev`, `tuf-repo-cdn.sigstore.dev`, and `release-assets.githubusercontent.com`, where GitHub's release downloads now redirect.
- **The egress gate checks the server name.** On a 443 tunnel, the gate reads the client's TLS ClientHello and closes the tunnel when its server name (SNI) isn't the CONNECT host, is missing, or the bytes aren't TLS, recording the refusal (`sni_mismatch`, `sni_missing`, `sni_invalid`, `sni_timeout`). A tunnel to an allowed host can no longer ask a shared front end for another one.
