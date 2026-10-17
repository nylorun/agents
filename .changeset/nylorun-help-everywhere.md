---
"nylorun": patch
---
`--help` (or `-h`) works on every command and subcommand: it prints that command's own usage on stdout and exits 0, where `nylorun migrate v8 --help`, `nylorun tenant budgets --help` and others exited 2 with "Unknown option --help", and `nylorun tenant settings --help` printed the usage of `budgets`, `tool-policy` and `coverage` too. `nylorun --help` lists every `agents` command (`pin`, `track`, `restart`, `triggers`, `runs` and `memories` were missing) and `migrate v8 --name`, and the README lists `agents pin`, `track`, `restart`, `put --dry-run`, `fork --label` and `list --outdated`.
