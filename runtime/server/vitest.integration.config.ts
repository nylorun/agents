import { defineConfig } from "vitest/config";

// Tests against the whole Docker test stack (`test/stack/compose.yaml`): Postgres, Restate and
// S2. They skip unless NYLORUN_TEST_STACK=1:
//
//   npm run test:stack:up -w @nylorun/runtime
//   NYLORUN_TEST_STACK=1 npm run test:integration -w @nylorun/runtime
//   npm run test:stack:down -w @nylorun/runtime
//
// Like the unit tests, each file gets its own database (`test/global-setup.ts`).
export default defineConfig({
  test: {
    include: ["test/**/*.integration.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // One history (P0.3): every turn checks the folded transcript against the engine's.
    setupFiles: ["test/setup-database.ts", "test/setup/transcript-shadow.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Suites share one stack; run files one at a time.
    fileParallelism: false,
    passWithNoTests: true,
  },
});
