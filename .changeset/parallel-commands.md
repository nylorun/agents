---
"@nylorun/core": minor
"@nylorun/runtime": minor
---

**Sessions on one Environment run their sandbox commands at the same time, and each version of a skill has its own folder (D66).** The SandboxManager ran every call on a workspace one at a time, whichever session sent it, so parallel turns would still have queued at every command. Now each session's calls run in the order it sends them and different sessions' calls overlap; opening, stopping and removing a workspace run alone, after the calls running.

- **Skill folders.** A skill's files are mounted at `/skills/<name>@<hash>/` (`skillFolderOf` in `@nylorun/core/define`, the hash from its canonical file map), written once and never replaced, so agents with different versions of one skill share an Environment. An agent used as a tool gets its own version too. The instructions, `load_skill`'s `sandboxPath` and skill attribution on `tool.completed` follow the folder.
