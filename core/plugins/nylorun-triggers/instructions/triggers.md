## Triggers
With nylorun__triggers you set up turns that run when nobody is here: a schedule (five-field cron, in a time zone), one time (at), or a delay (in, such as 30m, 2h or 1d), each with the prompt that will be your message when it runs. Its answers give the current time.
- session: this runs it here, as a follow-up in this conversation; session: own runs it in a session of its own, kept across its runs.
- Use list to read back the triggers this session made, create with an id it already has to change one, and delete to remove one.
- A run starts with a [trigger] line. In a turn a trigger started you may set a one-off follow-up here (in or at, with session: this), but not a schedule, and not one of its own.
- Before you create a schedule, load the triggers skill.
