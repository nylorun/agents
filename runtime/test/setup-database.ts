/**
 * Gives each test file its own database, cloned from the run's template
 * (`global-setup.ts`), and drops it after the file. `testPool()` reaches it.
 */
import { afterAll } from "vitest";
import { closeFileDatabase, openFileDatabase } from "./support/database.js";

await openFileDatabase();
afterAll(closeFileDatabase);
