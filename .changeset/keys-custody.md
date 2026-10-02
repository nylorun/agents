---
"@nylorun/runtime": minor
---

**The vault key leaves the runtime container (F4.2).** A new `keys` service, run in the gateway's process (`--service gates,keys`), is the only process that reads the vault key. Vault writes that touch a secret (creating and rotating a credential, setting and selecting the host model) and all token signing (subject tokens, delivery tokens, signing-key rotation) run there. A Runtime with `NYLORUN_KEYS_URL`, which defaults to `NYLORUN_GATES_URL`, never reads, creates or holds the key. The Tenant API answers as before, with the same statuses, codes and details.

- The vault key file moves to `<Host root>/keys/vault-kek`. A gateway that runs keys is not ready until the file is there, and it never creates one.
- The anonymous `GET /v1/access/jwks` reads the public keys, and asks the keys service only when the current or standby key is missing.
- While the keys service is down, vault writes and token minting answer `503 keys_unavailable`.
