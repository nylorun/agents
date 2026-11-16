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
| `runtime` | Deployment, Services: `<release>-runtime` (`:4000` API), `<release>-runtime-internal` (`:4200` Harness API, `:9080` Restate worker, published before the runtime is ready) | Core and the loop |
| `gateway` | Deployment, Service (`:4100` gates, `:4200` the egress decide route) | The Model and Tool Gates, keys and the decide route the keys provider asks; the vault key |
| `harness` | Deployment | Every loop; the harness token only |
| `studio` | Deployment, Service (`:3000`), no public route | Operators |
| `sandboxes` | Deployment (one replica), Service (`:4300`) | Each computer's lifecycle through Substrate's API, and the drain watch |
| `sandbox-gateway` | Deployment (two replicas), Service (`:4400`) | Tickets checked, commands and files tunnelled to computers through `atenet-router` |
| `restate` | StatefulSet with a disk; partition snapshots in the object store | Durable execution; it signs each request to the worker with its identity key |
| `s2` | StatefulSet, streams in the object store (or a disk) | Durable streams |
| `postgres`, `rustfs` | StatefulSets, only when bundled | The stores, for clusters without managed ones |
| `prepull` | DaemonSet, optional | The Runtime image and computer images in atelet's cache on worker nodes |
| `substrate-setup` | Job, optional | The Tenant's atespace and the sandboxes service's editor binding |
| `nylorun-keys-provider` | Deployment, Service, NetworkPolicy in Substrate's namespace, optional | The keys provider (ADR-142): Substrate's egress asks it for a keyed request's header; it asks the gateway's decide route |

Secrets the chart makes once and keeps (`helm.sh/resource-policy: keep`):

- the tokens between services and the admin key;
- the vault key;
- the computer ticket key (Ed25519);
- Restate's identity key (Ed25519): Restate signs with it, and the runtime derives the public key
  it verifies with;
- the keys provider's token for the decide route;
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

   With `keysProvider.enabled`, Substrate's egress must also know the keys provider: install it
   with

   ```sh
   --credential-provider='[{"name":"keys.nylorun.dev","address":"nylorun-keys-provider.ate-system.svc:50051"}]'
   ```

4. **Postgres** (when not bundled) needs:
   - logical replication (`wal_level=logical`; on Cloud SQL, the flag `cloudsql.logical_decoding=on`);
   - a database (any collation: the schema sets `COLLATE "C"` on the columns it compares as text);
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
| `service.type`, `.annotations`, `.loadBalancerSourceRanges` | `ClusterIP` | The runtime's Service; a cloud load balancer in front of it, such as GKE's internal one (`networking.gke.io/load-balancer-type: Internal`) behind your own proxy |
| `serviceAccount.annotations` | none | The runtime's, gateway's and harness's ServiceAccount (`<name>-runtime`, no API token), for a cloud identity: GKE Workload Identity's `iam.gke.io/gcp-service-account` for a model on the host's identity |
| `hostAliases` | none | Fixed addresses for names the runtime, gateway and harness call, such as a private network's address for a public name |
| `extraEnv.runtime`, `.gateway`, `.harness` | none | More env entries (a value, or `valueFrom` a Secret) for the Runtime settings the chart doesn't set, such as `NYLORUN_MODEL_HOST_IDENTITY`, `NYLORUN_CREDENTIAL_PROVIDER_URL` and `_TOKEN`, `NYLORUN_A2A_PUSH_SECRET` and `_ALLOW_HOSTS`, `NYLORUN_TUNING`. Don't repeat a name the chart sets |
| `postgres.url` or `.existingSecret` (key `url`) | bundled | External Postgres |
| `objectStore.endpoint`, `.bucket`, `.region`, `.existingSecret` (keys `accessKey`, `secretKey`) | bundled RustFS | External S3 API |
| `s2.objectStore` | `true` | s2-lite's streams in the bucket under `s2.path`; `false` keeps a disk |
| `restate.snapshots.enabled`, `.path`, `.interval` | on, `restate`, `1h` | Restate's partition snapshots in the bucket (ADR-147 decision 11); a new disk restores from the latest. The store must support conditional writes (GCS, S3 and RustFS do) |
| `keysProvider.enabled` | off | The keys provider in `substrate.systemNamespace`; one release per cluster |
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
- More than one replica of the runtime (core and the loop) or the gateway.
