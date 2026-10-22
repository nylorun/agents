---
"nylorun": minor
---

`nylorun local sandbox enable --probe-ports <allowed>,<denied>` publishes the NetworkPolicy probe's listener on those two host ports instead of two free ones. A firewall in front of the Docker host that opens only named ports to the pods, such as a cloud VPC's, can then open them; without it, the probe's random ports never reach the host and `enable` refuses the cluster. The ports must differ from each other and from the sandbox ports.
