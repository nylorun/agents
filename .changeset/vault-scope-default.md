---
"@nylorun/core": patch
"@nylorun/runtime": patch
---

**A vault created without `scope` takes it from the owner.** `POST /v1/tenant/vaults` (and `admin.vaults.create`) with no `scope` makes a person's vault when the request names `ownerUserId`, as before, and an installation vault when it doesn't; that request used to be refused with "ownerUserId is required for a user vault". `scope: "user"` without an owner is still refused. `@nylorun/core/contracts` exports `vaultScopeOf`, which the schema check and the Runtime's vault service share.
