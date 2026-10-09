---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/studio": patch
---

**Credentials for skills (R2c).** A skill's CLI in a pod sandbox authenticates with a vault credential whose value never enters the sandbox.

- `@nylorun/core`: vault credentials gain `environment_secret` (`secretName`, `secretValue`, `allowedHosts`, optional `inject: { header, format }`) and `environment_variable` (`variableName`, `variableValue`), in create, rotate and `CredentialInfo` (whose `binding.url` is now optional). `ENVIRONMENT_SECRET_SENTINEL` (`nylorun-managed`), `ENVIRONMENT_SECRET_DEFAULT_INJECT`, `isInjectFormat`, `renderInjectFormat`, `EnvironmentNameSchema` and `RESERVED_ENVIRONMENT_NAMES` are exported; `ERROR_CODES` gains `credential_conflict`; the Harness API's `RunRouting.sandbox` gains `environment`.
- `@nylorun/runtime`: every sandbox command gets each secret's name set to `nylorun-managed` and each variable's value. egress-gate terminates TLS for port 443 of a host an `environment_secret` of the sandbox's sessions is bound to, with a fresh leaf signed by the installation's egress CA (held by keys; its certificate reaches the pod in the join answer, and the engine points `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO` and `AWS_CA_BUNDLE` at a bundle with it), and sets the credential's header on every request from the vault, uncached. Every other host stays an opaque tunnel. Session open answers `409 credential_conflict` for two credentials with one variable name or one host, or two owners' secrets on one sandbox. No protocol change.
- `@nylorun/studio`: the Credentials page lists shell credentials (their variable and hosts) and deletes them; create and rotate them with the Management API.
