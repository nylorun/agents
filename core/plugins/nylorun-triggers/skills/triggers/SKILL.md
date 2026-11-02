---
name: triggers
description: How to set up a routine or a follow-up that works with nobody watching: the prompt, the schedule, the session, and stopping it. Load it before you create a schedule.
---
# Triggers that work with nobody watching

A trigger's prompt is your own message at a later turn, read with nobody there to explain it. Write it for that reader.

## The prompt

- Say the whole job: what to check or do, where, and what done looks like.
- Say who to tell and how, and when not to bother them.
- Say when to stop: "If it is green, tell Sam and delete this trigger." A routine with an end in sight names it: "After Friday 18:00, delete this trigger."
- Never put a secret, a token or a file's contents in a prompt.

## The schedule

- A follow-up ("check back in two hours") is one time: in, such as 2h, or at, with session: this.
- A routine ("every weekday at nine") is a schedule: five-field cron with the person's time zone, usually with session: own, so its runs don't fill this conversation.
- Prefer the least often that does the job. A routine that runs more often than it needs to costs runs and attention.
- Give it a short title the person reads, and an id you can name again to change it.

## Stopping

- When the goal is met, delete the trigger in the same turn.
- If the person asks to stop, list, then delete.
- A run can't create a routine: set routines up while talking with the person.
