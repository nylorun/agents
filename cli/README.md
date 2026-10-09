# @nylorun/cli (deprecated)

`nylo`, the Runtime client, ships in [`nylorun`](../nylorun/README.md#the-runtime-client-nylo)
beside the `nylorun` command. This package is kept for one release so that
existing commands and scripts keep working: its `nylo` prints one line on
stderr, then runs nylorun's `nylo` with the same arguments and exits with its
code. stdout is `nylo`'s alone, so `eval` still works:

```sh
npx @nylorun/cli status
eval "$(npx @nylorun/cli env)"
```

Run nylorun's `nylo` instead:

```sh
npx -p nylorun nylo status
eval "$(npx -p nylorun nylo env)"
```

or add `nylorun` as a devDependency and run `nylo` there (`npx nylo` in the
project; outside it, `npx nylo` looks for an unrelated npm package named
`nylo`). The commands, their output and their exit codes are the same:
[nylorun/README.md](../nylorun/README.md#the-runtime-client-nylo) documents
them. This package depends on `nylorun` only, at the version released with it,
and a later release removes it. See [MIGRATION.md](../MIGRATION.md).
