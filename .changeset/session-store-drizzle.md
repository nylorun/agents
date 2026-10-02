---
"@nylorun/runtime": minor
---

**Drizzle defines the Session Store's schema, migrations and queries.** An internal storage change: the tables, columns and indexes of a Tenant database are the same as before.

- The tables are defined in `src/store/postgres/schema.ts`; drizzle-kit generates the migrations from it, and they ship in the package (`dist/store/postgres/drizzle/`). At startup the Host applies the missing ones in one transaction under an advisory lock and records them in `nylorun.__drizzle_migrations` (Drizzle's journal format). A database whose journal holds a migration this Runtime does not ship still fails readiness with `schema-too-new`. The schema version reported by `/ready` and Admin status is the number of applied migrations.
- Statements are prepared again (one Tenant per database makes every statement the same for the whole pool).
- `drizzle-orm` is a new dependency.
