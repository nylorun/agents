---
"@nylorun/cli": minor
---

`@nylorun/cli` is nylorun under another name, no longer deprecated: its one command is `nylorun`, which runs nylorun's `nylorun` with the same arguments, so `npx @nylorun/cli <command>` is `npx nylorun <command>`. It prints no deprecation line, and nylorun 0.19 does not remove it. Its `nylo` is gone (it only named the `nylorun` command that replaced each of its own); nylorun's `nylo` stays until 0.19. Install one of the two packages globally, not both: each provides `nylorun`.
