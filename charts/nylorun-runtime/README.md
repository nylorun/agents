# nylorun-runtime

The Nylorun Runtime on an [Agent Substrate](https://github.com/agent-substrate/substrate) cluster,
in one Helm chart ([ADR-147](https://github.com/nylorun/factory/blob/main/decisions/platform/2026-11-15-beta-runtime-on-kubernetes.md),
[ADR-148](https://github.com/nylorun/factory/blob/main/decisions/engine/2026-11-15-computer-through-the-router.md),
[ADR-149](https://github.com/nylorun/factory/blob/main/decisions/engine/2026-11-15-one-architecture-harness-outside.md)).
Every Agent with a sandbox gets a **computer**:

- the loop runs in the harness;
- the Agent's commands and files run in its own Substrate actor, any image;
- they reach it through the sandbox gateway and Substrate's router.

The chart names no cloud provider. Postgres and the object store are settings: a managed service,
or the bundled ones. It is tested on Google Cloud (GKE, Cloud SQL, GCS) by
[nylorun/ops](https://github.com/nylorun/ops/tree/main/environments/beta/lab/k8s); guides for other
providers come later in the docs.

## What it installs

| Part | Kind | Holds |
| --- | --- | --- |
| `runtime` | Deployment, Service (`:4000` API, `:4200` Harness API, `:9080` Restate worker) | Core and the loop |
| `gateway` | Deployment, Service (`:4100`) | The Model and Tool Gates and keys; the vault key |
| `harness` | Deployment | Every loop; the harness token only |
| `studio` | Deployment, Service (`:3000`), no public route | Operators |
| `sandboxes` | Deployment (one replica), Service (`:4300`) | Each computer's lifecycle through Substrate's API, and the drain watch |
| `sandbox-gateway` | Deployment (two replicas), Service (`:4400`) | Tickets checked, commands and files tunnelled to computers through `atenet-router` |
| `restate` | StatefulSet with a disk | Durable execution |
| `s2` | StatefulSet, streams in the object store (or a disk) | Durable streams |
| `postgres`, `rustfs` | StatefulSets, only when bundled | The stores, for clusters without managed ones |
| `prepull` | DaemonSet, optional | The Runtime image and computer images in atelet's cache on worker nodes |
| `substrate-setup` | Job, optional | The Tenant's atespace and the sandboxes service's editor binding |

Secrets the chart makes once and keeps (`helm.sh/resource-policy: keep`):

- the tokens between services and the admin key;
- the vault key;
- the computer ticket key (Ed25519);
- the bundled stores' passwords.

Back up the Secret `<release>-secrets`: without its vault key, the Tenant's secrets can't be read.

## Before you install

1. **Kubernetes 1.37** with Agent Substrate v1.0 installed by its own setup, as its docs describe
   for your provider. Substrate's recommended layout:
   - an `ate-system-infra` pool for its control plane;
   - a pool for this chart;
   - worker pools of one CPU platform with node auto-upgrade off.
2. **The namespace may call Substrate's API.** Substrate's NetworkPolicy admits callers of
   `ate-api-server` only from namespaces labelled `ate.dev/api-access=true`:

   ```sh
   kubectl label namespace <namespace> ate.dev/api-access=true
   ```

3. **The router's allowlist** names the sandbox gateway. Install or update Substrate with:

   ```sh
   ATE_INGRESS_ALLOWED_SPIFFE_IDS=spiffe://cluster.local/ns/<namespace>/sa/<release>-sandbox-gateway
   ```

4. **Postgres** (when not bundled) needs:
   - logical replication (`wal_level=logical`; on Cloud SQL, the flag `cloudsql.logical_decoding=on`);
   - a database with C collation;
   - a user with the `REPLICATION` attribute.
5. **The object store** (when not bundled) is any S3 API: a bucket and an access key. On GCS, an HMAC
   key for a service account with `roles/storage.objectAdmin` on the bucket, endpoint
   `https://storage.googleapis.com`.
6. **The atespace.** One of Substrate's owners makes it once: set `substrate.setup.enabled` with a
   Secret (`substrate.setup.ownerTokenSecret`, key `token`) holding an owner's Substrate token, and
   the chart runs `sandboxes substrate-setup` as a hook Job. It is safe to run again.

## Install

```sh
helm install nylorun ./charts/nylorun-runtime -n nylorun --create-namespace -f values.yaml
```

The [GCP example values](values-gcp.example.yaml) are what the test cluster runs. The Runtime API's
admin key is in the Secret (`adminKey`); Studio is a port-forward away (`NOTES.txt`).

## Values

| Value | Default | |
| --- | --- | --- |
| `images.runtime`, `.studio`, `.sandboxes` | the chart's `appVersion` tags | Pin by digest in production |
| `tenant.name` | `default` | The Tenant, created on the first start |
| `publicUrl` | the ingress's host, else the Service | What clients use: webhook URLs, the OAuth resource |
| `ingress.*` | off | An Ingress for the Runtime API |
| `postgres.url` or `.existingSecret` (key `url`) | bundled | External Postgres |
| `objectStore.endpoint`, `.bucket`, `.region`, `.existingSecret` (keys `accessKey`, `secretKey`) | bundled RustFS | External S3 API |
| `s2.objectStore` | `true` | s2-lite's streams in the bucket under `s2.path`; `false` keeps a disk |
| `substrate.atespace` | `nylorun-<namespace>` | The Tenant's atespace |
| `substrate.workerSelector` | any | The worker pool's labels |
| `substrate.setup.enabled`, `.ownerTokenSecret` | off | Make the atespace at install |
| `computer.port` | `8080` | The engine's port in a computer |
| `sandboxGateway.replicas` | `2` | |
| `placement.nodeSelector`, `.tolerations` | none | Where the chart's pods run (its pool) |
| `prepull.enabled`, `.substrateCommit`, `.images`, `.nodeSelector`, `.tolerations` | off | Warm the worker nodes' image cache |
| `studio.enabled` | `true` | |

## Not in this chart

- Agent Substrate itself, and its node pools.
- A keys provider for keys at Substrate's egress (ADR-142): its decide route is egress-gate's, which this chart doesn't run.
- More than one replica of the runtime (core and the loop) or the gateway.
