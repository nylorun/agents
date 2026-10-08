---
"@nylorun/core": minor
"@nylorun/agents": minor
"@nylorun/admin": minor
"nylorun": patch
"@nylorun/cli": patch
"@nylorun/studio": patch
---

**One client and connection layer.** The Project link and credentials are read one way, and every Runtime client shares one `/health` probe.

- `@nylorun/core`: `@nylorun/core/project` (Node only, the one Core subpath that imports Node modules) reads the Nylorun home, a local Tenant's Host root (`tenantHostRoot`), the Project root (`findProjectRoot`) and the Project link and credentials (`findLinkedProject`, `readProjectLink`, `readCredentialsFile`), validated with `ProjectLinkFileSchema` and `ProjectCredentialsFileSchema`; a broken or newer file throws `ProjectFileError`. `@nylorun/core/transport` (browser-safe) holds the `/health` compatibility probe (`checkHealth`), `parseProtocolRange` (on `ProtocolRangeSchema`, ignoring fields a newer Host adds), `describeIncompatibility`, `requestHeaders` and `readBody`.
- `@nylorun/agents`: `resolveConnection` and `createClient()` find the Project as every reader does: the nearest directory with `.nylorun/` from `cwd` upwards, never the home directory or above it (they used to walk to the filesystem root, and past a `.nylorun/` without a link). A link without `credentials.json`, or a link or credentials file that does not validate, is now `connection_missing` naming the file and `npx nylorun start`, instead of a raw file-system or parse error. `@nylorun/agents/client` loads the link reader only when `createClient()` resolves a connection, so it imports no Node module. The root entry re-exports `checkHealth`, `describeIncompatibility` and `parseProtocolRange`.
- `@nylorun/admin`: `createAdmin` reads the Project link with the same reader. A link that does not validate is now refused like one from an older nylorun (when nothing else names the Host root), and a linked Project's `credentials.json` that does not validate is `connection_missing` instead of being skipped. `@nylorun/admin/project` re-exports `@nylorun/core/project` for tools that depend on this package. The `/health` check and request headers come from `@nylorun/core/transport`.
- `nylorun`: reads the Project link and credentials with `@nylorun/core/project`; a credentials file whose keys are not 64 hex characters is replaced by `start`, as an unreadable one was. No command changes.
- `@nylorun/cli`: `nylo` reads the Project root, link and credentials through `@nylorun/admin/project` instead of its own copies, with the same messages. No command changes.
- `@nylorun/studio`: the server's Runtime compatibility probe is `checkHealth` from `@nylorun/agents`.
