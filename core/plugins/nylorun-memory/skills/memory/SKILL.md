---
name: memory
description: What to keep in memory and how to write it: what is worth keeping, one topic per file, the frontmatter, and updating rather than adding. Load it before you first change memory in a session.
---
# Keeping memory

Memory is for what will matter again in a later session. Keep it short; an index line is read every session.

## What to keep

- Corrections the user makes, and the user's stated preferences.
- Team conventions and decisions.
- Facts that are not obvious and will matter again.

## What never to keep

- Secrets, tokens, passwords or keys.
- Anything derivable from the code or this conversation.
- One-off task state, and small talk.

## How to write it

- Before adding a memory, check whether one already covers the topic: view the directory, and read the file. Update the existing file rather than adding a near-duplicate, and remove what is no longer true.
- Write one topic per file, in Markdown, under a folder for its kind, for example /memories/preferences/, /memories/conventions/, /memories/facts/.
- Start each file with frontmatter:

  ---
  type: Preference | Convention | Decision | Fact | Reference
  description: one line saying what this memory is about
  ---

- The description is what the index shows: make it say what the file is about in one line.
