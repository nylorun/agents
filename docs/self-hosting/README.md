# Self-hosting

Everything in this repository runs without a Nylorun account. The Runtime verifies and enforces;
it never signs people in. Your identity provider and secret store plug in.

| You want to | Read |
| --- | --- |
| Run a Tenant on one machine or VM with Docker Compose | [Deploy on a VM](https://docs.nylorun.com/docs/deploy/vm) (guided), then the [Docker Compose reference](./docker-compose.md): containers, the Host root, the reverse proxy, Postgres, the gateway, the harness, limits and tuning |
| Sign people in with your own identity provider | [Identity and access](./identity.md): front doors, application and management keys, the identity file, Studio behind a sign-in proxy, CORS, backups. [`examples/self-host`](../../examples/self-host/README.md) runs it with Keycloak and oauth2-proxy |
| Run on Kubernetes with pod sandboxes | [Kubernetes](https://docs.nylorun.com/docs/deploy/kubernetes) (guided) and the [Helm chart](../../charts/nylorun-runtime/README.md) |
| Choose or build the image an Agent's computer runs, and pull it from your own registry | [Computer images](./computer-images.md): what the Runtime adds, pre-pulling, mirrors, and a recipe for a coding computer |
| Collect metrics, traces and audit events | [Observability](./observability.md) and [`examples/observability`](../../examples/observability/README.md) |
| Upgrade between beta releases | [Compatibility](https://docs.nylorun.com/docs/compatibility), then the [migration notes](../upgrading/migration.md) |
| Run your own harness, in any language | [Harness API](../reference/harness-api.md) and [`examples/harness-minimal`](../../examples/harness-minimal/README.md) |
