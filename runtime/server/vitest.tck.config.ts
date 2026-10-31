import { defineConfig } from "vitest/config";

// Serves an example agent over A2A for the A2A TCK (`.github/workflows/a2a-tck.yml`), on the test
// stack's Postgres, until the process is stopped:
//
//   npm run test:stack:up -w @nylorun/runtime
//   NYLORUN_A2A_TCK=1 npx vitest run --config vitest.tck.config.ts   # in runtime/server
//
// It writes its base URL to NYLORUN_A2A_TCK_READY once it serves (`test/a2a/tck/serve.tck.ts`).
export default defineConfig({
  test: {
    include: ["test/a2a/tck/*.tck.ts"],
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup-database.ts"],
    testTimeout: 0,
    hookTimeout: 60_000,
  },
});
