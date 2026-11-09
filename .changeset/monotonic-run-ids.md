---
"@nylorun/runtime": patch
---

Trigger runs fired in the same millisecond now list in the order they fired: run ids a Runtime makes strictly increase, instead of breaking a same-millisecond tie on their random part.
