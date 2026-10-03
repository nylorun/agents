/**
 * The `BlobStore` conformance suite against an S3 server: RustFS in the test stack
 * (`test/stack/compose.yaml`) and in CI's integration job. Runs only when
 * `NYLORUN_TEST_S3_ENDPOINT` is set:
 *
 *   NYLORUN_TEST_S3_ENDPOINT=http://127.0.0.1:59000 npm run test:integration -w @nylorun/runtime -- test/blob
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BlobStoreError, createS3BlobStore } from "../../src/blob/index.js";
import { stackEndpoints } from "../stack/endpoints.js";
import { blobStoreConformance } from "./conformance.js";

const s3 = stackEndpoints().s3;
const PART_SIZE = 5 * 1024 * 1024;

const store = (bucket: string, overrides: { secretAccessKey?: string } = {}) =>
  createS3BlobStore({
    endpoint: s3.endpoint!,
    bucket,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: overrides.secretAccessKey ?? s3.secretAccessKey,
    partSize: PART_SIZE,
  });

describe.skipIf(!s3.endpoint)("s3 BlobStore", () => {
  blobStoreConformance("s3", async () => {
    const target = store("nylorun-test");
    await target.ensureBucket();
    return { store: target, partSize: PART_SIZE };
  });

  it("creates a bucket once, and finds it the next time", async () => {
    const target = store(`nylorun-test-${randomBytes(4).toString("hex")}`);
    await target.ensureBucket();
    await target.ensureBucket();
    await target.put("k", new Uint8Array([1, 2, 3]));
    expect(await target.head("k")).toMatchObject({ size: 3 });
    await target.delete("k");
  });

  it("reports a refused credential with the server's code", async () => {
    const target = store("nylorun-test", { secretAccessKey: "not-the-secret" });
    await expect(target.put("k", new Uint8Array([1]))).rejects.toMatchObject({
      name: "BlobStoreError",
      status: 403,
    });
    await expect(target.head("k")).rejects.toBeInstanceOf(BlobStoreError);
  });
});
