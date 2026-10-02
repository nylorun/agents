/**
 * drizzle-kit's configuration (development only; not in the published package). The Session
 * Store's tables are defined in `src/store/postgres/schema.ts`; drizzle-kit generates the
 * migrations from it into `src/store/postgres/drizzle/`, which the build copies into `dist/`
 * and the Runtime applies at startup (`src/store/postgres/migrate.ts`). See CONTRIBUTING.md,
 * "Adding a migration".
 *
 *   npm run db:generate -w @nylorun/runtime                  # schema.ts changed
 *   npm run db:generate -w @nylorun/runtime -- --custom --name=<name>   # SQL drizzle-kit does not model
 *   NYLORUN_DATABASE_URL=postgres://… npm run db:studio -w @nylorun/runtime
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/store/postgres/schema.ts",
  out: "./src/store/postgres/drizzle",
  casing: "snake_case",
  schemaFilter: ["nylorun", "nylorun_streams"],
  // Where the Runtime records applied migrations (`migrate.ts`): `nylorun.__drizzle_migrations`.
  migrations: { schema: "nylorun", table: "__drizzle_migrations" },
  dbCredentials: { url: process.env.NYLORUN_DATABASE_URL ?? "" },
});
