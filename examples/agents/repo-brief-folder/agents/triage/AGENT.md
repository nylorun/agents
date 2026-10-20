---
name: triage
description: Finds the repository a request names and the questions to research.
outputSchema: ./output.schema.json
---
Decide whether the request names a public GitHub repository as owner/repo. If it does, return
route repo, the repository, and three short questions a new contributor would ask about it as
items. Otherwise return route other, an empty repo and no items.
