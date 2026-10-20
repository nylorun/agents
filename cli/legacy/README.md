# @nylorun/cli

`@nylorun/cli` is [`nylorun`](../nylorun/README.md) under another name. Its one
command, `nylorun`, runs nylorun's `nylorun` with the same arguments, so either
package name works:

```sh
npx @nylorun/cli status    # the same as npx nylorun status
npx @nylorun/cli --help    # nylorun's help
```

This package depends on `nylorun` only, at the version released with it, so both
names run the same code. Prefer `nylorun` in new projects and docs.

Install one of them globally, not both: each provides the `nylorun` command, and
npm refuses the second global install (`EEXIST`). In a project, having both is
harmless.

`nylo`, the former Runtime client, is nylorun's: it names the `nylorun` command
that replaced each of its own and exits 2, and a later release removes it. See
[MIGRATION.md](../../guides/MIGRATION.md).
