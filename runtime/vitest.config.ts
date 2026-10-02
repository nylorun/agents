import { configDefaults, defineConfig } from "vitest/config";

// Unit tests. Every test file gets its own database on the Docker test stack's Postgres
// (`test/global-setup.ts`, `test/setup-database.ts`); global setup starts the stack when it is
// down. Tests that also need Restate or S2 live in `*.integration.test.ts` and run through
// `vitest.integration.config.ts`.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // One history (P0.3): every turn checks the folded transcript against the engine's.
    setupFiles: ["test/setup-database.ts", "test/setup/transcript-shadow.ts"],
  },
});
