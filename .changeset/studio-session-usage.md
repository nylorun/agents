---
"@nylorun/studio": minor
---

**Studio shows when each session was last active, and a session's token usage.**

- **Last activity.** The Sessions table has a **Last activity** column: the session's last committed event, else when it opened. Sessions list newest activity first, and the column's header sorts oldest first. Studio reads the list in pages of 200 (`GET /v1/sessions?limit=200`, Host feature `session-reads`); a Runtime without it is listed as before, with no times.
- **Usage tab.** A session's inspector has a **Usage** tab: its recorded tokens (total, input, output, cache read and write, reasoning), cost and model calls, what the totals count twice or leave out, and each model call with its model, tokens and cost. It is read again when a turn ends. The proxy now allows `GET /v1/sessions/{id}/usage` and `GET /v1/sessions/{id}/calls/model`.
- **Hide the inspector.** A button in a session's header hides the inspector so the chat takes the whole width, and shows it again; the browser remembers the choice.
- **Message times.** A chat message shows its time while it is hovered or focused, with the full time in its tooltip.
- **New session in the sidebar.** **New session** moved from the Sessions table to the top of the sidebar, so it is on every page; it is a menu of the registered agents, and an icon when the sidebar is collapsed.
