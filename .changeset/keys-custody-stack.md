---
"nylorun": minor
---

**Only the gateway can read the vault key (F4.2).** `nylorun start` writes the Tenant's vault key to `<Host root>/keys/vault-kek`, and moves the key an earlier stack kept in `tenant/vault-kek`. Only the `gateway` container mounts `keys/`, read-only, and runs `--service gates,keys`. The runtime container covers `keys/` and `stack/` with empty read-only mounts, so it reads neither the vault key nor Restate's private key and `.env`. `nylorun reset` deletes the key with the Tenant's data.
