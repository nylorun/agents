---
"@nylorun/runtime": minor
---

A computer wakes on its first command (ADR-154): a turn on a computer Agent no longer asks it to run, so a chat turn on a sleeping computer reaches its model without waking it. The run's first sandbox call opens the computer (`computer.open`), which wakes it, as before. A failed computer is still asked to run by a turn, and a running one counts the turn as use.
