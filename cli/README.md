# @nylorun/cli

The Runtime client, command `nylo`: it acts on a Runtime's Tenants, the local
stack's or any Runtime reachable by URL and key. Setting up and running the
local stack is [`nylorun`](../nylorun/README.md)'s job; the two packages are
independent and never call each other. Depends on `@nylorun/agents` and
`@nylorun/admin` only among Nylorun packages. Vocabulary:
[runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

```sh
npx nylorun up                        # the local stack (nylorun)
npx @nylorun/cli tenant create        # this project's Tenant, linked in .nylorun/
npx @nylorun/cli tenant use <id>      # or: link a Tenant created in Studio
```

## Commands

```sh
nylo tenant create [name]             # create a Tenant; in a Project, link it and seed it from .env
nylo tenant current|list [--json]|use <name-or-id>|status [--json]|reset|delete
nylo configure                        # set or replace the model provider on the linked Tenant
nylo env                              # export lines for the linked Project
nylo doctor sandbox [--json]          # sandbox backend via the Tenant API
```

Local stack commands (`up`, `down`, `start`, `stop`, `status`, `logs`,
`studio`, `reset`) exit 2 naming `npx nylorun <command>`. `nylorun dev` was
removed: link once with `nylo tenant create`, then run the project's own
`npm run dev` (`tsx watch src/main.ts`).

## `nylo tenant create`

The Admin API connection resolves from `NYLORUN_ADMIN_URL` and
`NYLORUN_ADMIN_KEY`, else from the local Host root (`NYLORUN_HOME` or
`~/.nylorun`: `host.json` and the admin key that `nylorun up` wrote). With no
Runtime answering, it exits 6 and names `npx nylorun up`.

Inside a Project (the nearest `.nylorun/` or `package.json`):

1. Creates the Tenant, named after `package.json` unless a name is given.
2. Writes the format-1 link and credentials (see below). A Project that is
   already linked is refused: use `nylo tenant use` or `nylo tenant delete`.
3. Seeds the Tenant from `.env`: `NYLORUN_SANDBOX`, and the model provider from
   `MODEL_PROVIDER`, `MODEL`, `MODEL_PROVIDER_API_KEY` (or a credential in
   `.nylorun/auth.json`) into the Tenant vault. Without them it says to set the
   provider in Studio or with `nylo configure`.

Outside a Project it creates the Tenant and prints the three `NYLORUN_*`
exports once; the Host keeps only a hash of the application key.

## `nylo tenant use <name-or-id>`

Links the Project to another Tenant on the local Host. It uses the first key
that the Tenant accepts:

1. The Project's `.nylorun/credentials.json`.
2. A key it kept when the Project last left that Tenant
   (`.nylorun/credentials.<tenantId>.json`).
3. The key of the derived principal `project`, computed from this machine's
   admin key. Every Tenant created in Studio registers that principal, so
   Studio's **Connect your code** step needs only this command.

When it replaces an application key (shown only once, when the Tenant was
created), it keeps that key as `.nylorun/credentials.<tenantId>.json`, so
`nylo tenant use <that id>` switches back.

## Project link

A **Project** stores only:

- `.nylorun/link.json`: `{ format, hostUrl, hostId, tenantId }`
- `.nylorun/credentials.json`: application key and principal id (0600), no
  executor tokens
- `.nylorun/.gitignore` containing `*`

`connectAgents` in `@nylorun/agents` reads the link (or the three variables),
so the project's `npm run dev` and `npm start` need no Nylorun tool.

```sh
eval "$(npx @nylorun/cli env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY, NYLORUN_TENANT
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Generic failure |
| 2 | Usage error, or a moved or removed command |
| 6 | No Runtime at the linked or local URL |
| 130 / 143 | SIGINT / SIGTERM |

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| No Runtime answers | `npx nylorun up`, then `npx nylorun status` |
| Quarantined Tenant | `nylo tenant status` shows the reason and `repair` |
| `426` from the Runtime | Upgrade the CLI, or pin a matching older set |

See [MIGRATION.md](../MIGRATION.md).
