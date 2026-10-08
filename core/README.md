# @nylorun/core

Shared portable agent definitions and runtime protocol contracts. No engine,
HTTP client, Node host or SDK dependencies.

- `/define`: `Agent`, `tool`, capabilities, schemas and explicit local bindings.
- `/contracts`: runtime request, event, action and response schemas.
- `/compatibility`: protocol/definition versions and canonical manifest hashing.
- `/transport`: what every Runtime client does on the wire: the `/health`
  compatibility probe (`checkHealth`), protocol ranges, request headers and
  response bodies. Browser-safe; `@nylorun/agents` and `@nylorun/admin` build on it.
- `/project` (**Node only**, the one subpath that imports Node modules): the
  Nylorun home, a local Tenant's Host root, the Project root, and the Project
  link and credentials, validated with `ProjectLinkFileSchema` and
  `ProjectCredentialsFileSchema`. Every reader of the link uses it (the SDK,
  `@nylorun/admin`, `nylorun` and `nylo`): the Project is the nearest directory
  with `.nylorun/`, from the working directory upwards, never the home
  directory or above it; a broken file throws `ProjectFileError`.
- Root: shared contracts and types; no authoring or execution entry points.

Applications normally import `@nylorun/agents`. Hosts and the execution engine
consume core directly.

A built agent's non-enumerable `getBinding()` retains local functions, tool
snapshots, ordered declarations and live output schemas. Only its manifest is
serialized. This works across separate compatible installed copies of core.
