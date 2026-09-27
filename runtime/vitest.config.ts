import { configDefaults, defineConfig } from "vitest/config";

// Unit tests. Tests against the Docker test stack live in
// `*.integration.test.ts` and run through `vitest.integration.config.ts`.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
});
