/**
 * Where the integration test stack (`compose.yaml`) listens. Integration tests
 * run only with `NYLORUN_TEST_STACK=1`; otherwise they skip.
 */
export const STACK_ENABLED = process.env.NYLORUN_TEST_STACK === "1";

const port = (name: string, fallback: number): number =>
  Number(process.env[name] ?? fallback);

export interface StackEndpoints {
  postgres: { host: string; port: number; url: string };
  restate: { ingressUrl: string; adminUrl: string };
  s2: { endpoint: string };
  /**
   * The S3 server for the `BlobStore` suite (RustFS in the stack): set only when
   * `NYLORUN_TEST_S3_ENDPOINT` is, so the suite runs only where an S3 server is known to listen.
   */
  s3: { endpoint?: string; accessKeyId: string; secretAccessKey: string };
}

export function stackEndpoints(): StackEndpoints {
  const pg = port("NYLORUN_TEST_POSTGRES_PORT", 55432);
  return {
    postgres: {
      host: "127.0.0.1",
      port: pg,
      url: `postgres://nylorun:nylorun@127.0.0.1:${pg}/nylorun`,
    },
    restate: {
      ingressUrl: `http://127.0.0.1:${port("NYLORUN_TEST_RESTATE_INGRESS_PORT", 58080)}`,
      adminUrl: `http://127.0.0.1:${port("NYLORUN_TEST_RESTATE_ADMIN_PORT", 59070)}`,
    },
    s2: {
      endpoint: `http://127.0.0.1:${port("NYLORUN_TEST_S2_PORT", 58090)}`,
    },
    s3: {
      ...(process.env.NYLORUN_TEST_S3_ENDPOINT
        ? { endpoint: process.env.NYLORUN_TEST_S3_ENDPOINT }
        : {}),
      // The test stack's RustFS credential (compose.yaml).
      accessKeyId: process.env.NYLORUN_TEST_S3_ACCESS_KEY ?? "nylorun",
      secretAccessKey: process.env.NYLORUN_TEST_S3_SECRET_KEY ?? "nylorun-test-secret",
    },
  };
}
