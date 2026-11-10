---
"@nylorun/runtime": patch
"nylorun": patch
---

An Agent created again under a deleted Agent's id no longer takes that Agent's state. Before, it read `failing` or `input_required` from sessions whose last turn ran on the deleted Agent, before it existed. Its `state` and `attention` now count a session only once that session takes a turn on the new Agent. The sessions still keep the id and can go on with the new Agent, as before, and they still appear in its `sessions`.
