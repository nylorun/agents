import { defineConfig } from "vitest/config";

// Tests against the Docker test stack (`test/stack/compose.yaml`). They skip
// unless NYLORUN_TEST_STACK=1:
//
//   npm run test:stack:up -w @nylorun/runtime
//   NYLORUN_TEST_STACK=1 npm run test:integration -w @nylorun/runtime
//   npm run test:stack:down -w @nylorun/runtime
export default defineConfig({
  test: {
    include: ["test/**/*.integration.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Suites share one stack; run files one at a time.
    fileParallelism: false,
    passWithNoTests: true,
    // One history (P0.3): every turn checks the folded transcript against the engine's.
    setupFiles: ["test/setup/transcript-shadow.ts"],
  },
});
