# Agents

Guidance for coding agents working in this repository.

- **Start here:** [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the repository map and checks
  (`npm run setup`, `npm run check`). What each folder publishes:
  [docs/reference/packages.md](docs/reference/packages.md).
- **Vocabulary:** [runtime/server/src/CONTEXT.md](runtime/server/src/CONTEXT.md). Use its terms
  (Tenant, Agent, agent manifest, harness) as defined there.
- **Docs:** operator and contributor references are in [docs/](docs/README.md); user docs are at
  [docs.nylorun.com](https://docs.nylorun.com/llms.txt). A change to behavior a page describes
  updates that page in the same PR.
- **Releasing** (including a request for `latest`): follow
  [docs/contributing/releasing.md](docs/contributing/releasing.md). Moving `latest` is an
  administrator's step: never run **Promote to latest** yourself.
