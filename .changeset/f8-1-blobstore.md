---
"@nylorun/runtime": minor
"nylorun": minor
---

**A local Tenant has an Object store: RustFS, behind the Runtime's new `BlobStore` seam.** `nylorun start` adds a `rustfs` container (RustFS 1.0.1, single node and single drive, pinned by digest) on the `nylorun-<tenant>-rustfs` volume, unpublished and without its console. Its secret key is generated once into `docker/.env` (`NYLORUN_OBJECT_STORE_SECRET_KEY`), and only the `runtime` and `gateway` containers receive the credential (`NYLORUN_OBJECT_STORE_ENDPOINT`, `_ACCESS_KEY`, `_SECRET_KEY`); the runtime creates the bucket at boot. The Runtime reaches the store through `BlobStore` (put with a streamed body and a size cap, get with a byte range, head, delete, list by prefix) with an `s3` adapter over the plain S3 API and an `fs` adapter, which a Runtime without `NYLORUN_OBJECT_STORE_ENDPOINT` (embedded, ephemeral, tests) uses under the Tenant directory's `blobs/`. Nothing stores files there yet; file artifacts build on it.
