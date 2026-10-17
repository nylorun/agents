# @nylorun/cli (deprecated)

`nylo`, the Runtime client, became part of [`nylorun`](../nylorun/README.md):
its commands are `nylorun` commands now. This package is kept until nylorun
0.18, which removes it and nylorun's `nylo`: its `nylo` prints one line on
stderr, then runs nylorun's `nylo`, which names the `nylorun` command that
replaced each of its own and exits 2.

| `nylo` | `nylorun` |
| --- | --- |
| `nylo status` | `npx nylorun status` |
| `nylo reset [--sessions\|--environments\|--all]` | `npx nylorun tenant reset [--sessions\|--agents\|--all]` |
| `nylo access signing-keys …` | `npx nylorun tenant signing-keys …` |
| `nylo configure` | `npx nylorun tenant models set` |
| `nylo doctor sandbox` | `npx nylorun doctor sandbox` |
| `nylo env` | none: the SDKs read the Project link themselves |

This package depends on `nylorun` only, at the version released with it. See
[MIGRATION.md](../../guides/MIGRATION.md).
