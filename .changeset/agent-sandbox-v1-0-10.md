---
"nylorun": minor
---

`nylorun local sandbox enable` installs agent-sandbox v1.0.10 in place of v1.0.5, its release manifest verified by its new sha256. The patches since v1.0.5 fix the warm pool's accounting and readiness, stop a suspending Sandbox from reporting Finished, add Prometheus metrics for suspend and resume, and add CEL validation of volume claim templates; the API stays `agents.x-k8s.io/v1beta1`. A context that runs v1.0.5 is refused, as any other version is: upgrade its controller with `kubectl apply --server-side -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.10/sandbox.yaml`, then run `enable` again.
