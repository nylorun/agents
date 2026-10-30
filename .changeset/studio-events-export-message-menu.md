---
"@nylorun/studio": minor
---

A session's Events tab exports its events: an icon button at the right end of its toolbar downloads the rows its filters show, as JSON (each event whole) or CSV (time, type, label, summary, delivery, event id, turn id), named `events-<session>.json` or `.csv`. Each chat message from you or the assistant has a ⋯ menu beside its time, shown while the message is hovered or focused, with "Copy text" and "View event" (its row in the Events tab). The chat no longer scrolls sideways: long unbroken text such as a path or an id wraps inside its message, a message's text keeps its line breaks, and a cancelled or failed turn's details wrap.
