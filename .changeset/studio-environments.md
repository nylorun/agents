---
"@nylorun/studio": minor
---

**Studio is built around Environments.** An Environment holds a session's sandbox, its vault's secrets and its disk versions, so Studio shows them together instead of as separate pages.

- **Sidebar:** Sessions and Environments; Settings has Models only. **Artifacts** and **Credentials** are gone from the sidebar.
- **Each Environment has its own page** at `/environments/<id>`, with tabs (`?tab=`):
  - **Overview:** its sandbox, recipe and use, as fields.
  - **Secrets:** the full Credentials editor, moved here.
  - **Disk:** keep a version of the disk, restore one, start a new Environment from one, delete one, and browse a version's files and changes.
  - **Setup & files:** a pod's setup commands and input files.
  - **Sessions** and **Events**.
- **The recipe form** gains the harness, and for pods the setup commands and input files. Stop, Reset, Restore and Delete confirmations say how many other sessions name the Environment.
- **Sessions:** a session's **Environment** tab shows the Environment it runs in, the recipe version it opened on, what the agent's MCP servers and HTTP tools get from its secrets, its disk, and the other sessions that share it, or that it names none. The tab only reads; changes are made on the Environment's page. The Artifacts tab is now **Outputs**.
- **Old links redirect:** `/environments?selected=<id>`, `/settings/credentials?environment=<id>`, `/vault` and `/sandboxes` open the Environment's page, and `/artifacts?selected=<id>` still opens an artifact.
- **The Studio proxy** also forwards `GET /v1/environments/{id}/versions`, `POST …/snapshot`, `POST …/restore` and `DELETE …/versions/{n}`.
