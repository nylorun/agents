/**
 * The `BlobStore` seam (`./types.ts`) and its adapters. A Host with an Object store
 * (`StackConfig.objectStore`, from `NYLORUN_OBJECT_STORE_*`) passes an `s3` store to its Tenant
 * (`TenantOpenHooks.blobs`); without one the Tenant keeps blobs on disk (`fs`, under
 * `TenantPaths.blobs`). Tenant code reaches it as `TenantContext.blobs`.
 */
export * from "./types.js";
export { createFsBlobStore, type FsBlobStoreOptions } from "./fs.js";
export { createS3BlobStore, type S3BlobStore, type S3BlobStoreOptions } from "./s3.js";
