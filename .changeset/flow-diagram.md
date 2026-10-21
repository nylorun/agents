---
"@nylorun/studio": minor
---

A flow agent's Manifest tab (Declared, Layout) draws its stages as a diagram, top to bottom, as its manifest declares them: a chain as a sequence, a switch as a decision with an edge per case, a parallel as a fork with an edge per branch, a map over one stage as a stack, a loop as its body and verifier with a dotted retry edge, an embedded flow agent as a box of its own stages, and HTTP stages with their method and host. It has a legend, counts the agent and tool stages, and "Copy Mermaid" copies the diagram's Mermaid text (zinc `classDef`s included). Mermaid loads only when a flow is shown, in strict mode. DESIGN.md adds that a diagram is not a chart: it is zinc and white, flat, with no Sage.
