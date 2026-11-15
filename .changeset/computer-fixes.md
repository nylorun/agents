---
"@nylorun/runtime": patch
---

A computer runs our engine whatever harness drives its Agent: an Agent with a custom harness runs it through the Harness API, and its image is its computer. The chart sets numeric users for `runAsNonRoot`, uses the sandboxes service's `/health` for readiness (its `/ready` waits for the atespace the post-install Job makes), and says that Substrate's API admits only namespaces labelled `ate.dev/api-access=true`. Docs: Harness API §9b (computers), Kubernetes in SELF_HOSTING.md, and a MIGRATION entry.
