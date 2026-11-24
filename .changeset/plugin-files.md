---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
"nylorun": minor
---

An Agent Plugin's own files reach the sandbox. A vendored plugin holding files beyond its `plugin.json`, servers, skills and subagent files (a plugin's `resources/`, its persona files, its docs) carries all of them, but secret-shaped ones, by hash on its `harness.plugins` entry and on the loop manifest's new `plugins`, in the folder compiler and in the SDK's `.plugin()` and `harness.manifest.json` plugins. They are definition files: uploaded with the skills' files, named at save (`definition_files_missing`), bounded together as a skill's are, and served to the run. Before a sandbox call the harness mounts each such plugin read-only at `/plugins/<name>@<hash>/`, for the root and its subagents, and `load_skill` answers a plugin skill's `pluginPath`. A plugin holding only its parts carries no files, so its manifest doesn't change. Agent manifest schema `v8.7`, harness file `v1.7`, Host feature `plugin-files`; `nylorun check` says how many of a plugin's files are mounted.
