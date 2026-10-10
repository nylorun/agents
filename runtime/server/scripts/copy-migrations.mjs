/**
 * Copies the Session Store's migrations into `dist/` (session-store.md §3): the SQL files and
 * `meta/_journal.json` drizzle-kit wrote to `src/store/postgres/drizzle/`, next to the built
 * `store/postgres/migrate.js`, which reads them from there. drizzle-kit's snapshots stay in the
 * repository: the Runtime does not read them.
 */
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runtime = fileURLToPath(new URL("../", import.meta.url));
const from = join(runtime, "src/store/postgres/drizzle");
const to = join(runtime, "dist/store/postgres/drizzle");
const journal = JSON.parse(readFileSync(join(from, "meta/_journal.json"), "utf8"));
mkdirSync(join(to, "meta"), { recursive: true });
copyFileSync(join(from, "meta/_journal.json"), join(to, "meta/_journal.json"));
for (const { tag } of journal.entries) copyFileSync(join(from, `${tag}.sql`), join(to, `${tag}.sql`));
