---
"@nylorun/core": patch
---

**Named agents work as flow children.** An Agent with a `name` (for example `Agent({ id: "a", name: "Named A" })`) used in `.step()`, `.switch()`, `.parallel()`, `.map()`, `.loop()` or in `Chain`/`Switch`/`Parallel`/`Map`/`Loop` was mistaken for a tool, because a builder has a string `name` and an `.input()` method, and the build threw `tool.invalid: Tool 'Named A' must provide run() or execute()`. Agents, agent builders and flows are no longer classified as tools.
