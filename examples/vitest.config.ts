import { configDefaults, defineConfig } from "vitest/config";

// `harness-minimal/` is a package of its own, with its own tests and vitest.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "harness-minimal/**"] },
});
