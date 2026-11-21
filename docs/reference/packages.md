# Packages

What each folder of this repository publishes. Upgrade every Nylorun package together: see
[Compatibility](https://docs.nylorun.com/docs/compatibility).

| Package | Folder | Role | Depends on |
| --- | --- | --- | --- |
| [`nylorun`](https://www.npmjs.com/package/nylorun) | [`cli/nylorun`](../../cli/nylorun) | The CLI. Runs the local Runtime (`up`, `down`, `status`, `studio`), writes, checks and saves agent folders, and manages a Tenant (`init`, `check`, `apply`, `agents`, `sessions`, `tenant`, `local`) | `@nylorun/agents`, `@nylorun/admin`, `@nylorun/core` |
| [`@nylorun/agents`](https://www.npmjs.com/package/@nylorun/agents) | [`sdks/agents`](../../sdks/agents) | Agents SDK: define agents, save them, open sessions; AG-UI and A2A handlers | `@nylorun/core` |
| [`@nylorun/admin`](https://www.npmjs.com/package/@nylorun/admin) | [`sdks/admin`](../../sdks/admin) | Admin SDK for the Management API: models, credential coverage, MCP previews, signing keys, application keys | `@nylorun/core` |
| [`@nylorun/runtime`](https://www.npmjs.com/package/@nylorun/runtime) | [`runtime/server`](../../runtime/server) | The Runtime; also the `ghcr.io/nylorun/runtime` image | `@nylorun/core`, `@nylorun/harness` |
| [`@nylorun/harness`](https://www.npmjs.com/package/@nylorun/harness) | [`runtime/harness`](../../runtime/harness) | Execution engine and checkpoints | `@nylorun/core` |
| [`@nylorun/core`](https://www.npmjs.com/package/@nylorun/core) | [`core`](../../core) | Shared definitions, contracts and manifest identity | none |
| [`@nylorun/create-agent`](https://www.npmjs.com/package/@nylorun/create-agent) | [`cli/create-agent`](../../cli/create-agent) | `npm create @nylorun/agent`: project scaffolding and compatibility pins | none |
| [`@nylorun/cli`](https://www.npmjs.com/package/@nylorun/cli) | [`cli/legacy`](../../cli/legacy) | `nylorun` under its earlier name: `npx @nylorun/cli <command>` runs `npx nylorun <command>` | `nylorun` |

## Images and other folders

| Image or folder | Folder | Role |
| --- | --- | --- |
| `ghcr.io/nylorun/studio` | [`studio`](../../studio) | The dashboard (a private npm workspace, published only as an image) |
| `ghcr.io/nylorun/sandboxes` | [`sandboxes`](../../sandboxes) | Go service that runs pod sandboxes on Kubernetes |
| `ghcr.io/nylorun/computer` | [`images/computer`](../../images/computer) | The computer agent mounted into each sandbox |
| Helm chart `nylorun-runtime` | [`charts/nylorun-runtime`](../../charts/nylorun-runtime) | The Runtime on Kubernetes |
| Not published | [`examples`](../../examples) | Feature demos on the generated project shell |

`@nylorun/harness` and `@nylorun/runtime` never depend on each other, and Studio depends on
neither. See [CONTRIBUTING.md](../../CONTRIBUTING.md#repository-map) for the rest of the tree.
