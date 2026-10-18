---
"@nylorun/studio": minor
---

Each sidebar item opens the page it names. **Agents** opens the Agents list, where Studio now opens, and each Agent under it opens its page, which opens on its sessions. The session list is gone, since every session runs on one Agent: `/` and `/sessions` open the Agents list, and `/sessions?agent=<id>` opens that Agent's page. The sidebar's **New session** menu is replaced by a **+** that appears when you hover an Agent and starts a session on it; an Agent's page and each row's ⋯ in the Agents list start one too. The Agents list uses the Agent page's table style (single-line rows, a search, its filters, a count and a ⋯ per row), shows each Agent's kind, and shows how many of its sessions wait on a person.
