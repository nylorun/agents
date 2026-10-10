---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/admin": minor
"@nylorun/studio": minor
---

**Check an agent's credentials against vaults, and pick vaults for Studio sessions.** An agent names its MCP servers and HTTP tools by URL and a vault binds a credential to a URL; nothing told you whether the two met until a session's first turn. Now you can ask before a session starts.

- `@nylorun/core`: `CredentialCoverageRequestSchema` and `CredentialCoverageSchema` (`CredentialCoverageEntry`, `CoverageCredential`, `COVERAGE_STATUSES`), and the optional Host feature `credential-coverage`.
- `@nylorun/runtime`: `POST /v1/tenant/credential-coverage` (the Management API) takes a saved `agentId`, the `vaultIds` and `credentialSelections` a session would attach and, optionally, its `ownerUserId`. For each remote MCP server and HTTP tool `credential` the agent declares (its own, its subagents' and a flow's stages and agents), it answers `covered` (with the credential), `missing`, `ambiguous` or `selection_mismatch`, decided the way a call decides it (same URL normalization, same selection rule). A `missing` entry lists the vaults the session could attach that hold one (`available`). The attachment is checked as a session's is (`403` for another person's vault, `404` for an unknown vault or agent). It reads no secret, writes no audit row and calls no server. Both OpenAPI documents list it.
- `@nylorun/admin`: `admin.vaults.coverage({ agentId, vaultIds?, credentialSelections?, ownerUserId? })`.
- `@nylorun/studio`: **New session** on an agent whose MCP servers or HTTP tools take a credential opens a vault picker. It lists the installation vaults, suggests the ones that hold the agent's credentials, shows what each server and tool would get, and lets you pick a credential where several match. The session starts with those `vaultIds` and `credentialSelections`. An agent that takes no credential, or a Runtime without `credential-coverage`, starts a session at once, as before. Studio's proxy forwards the check for installation vaults only.
