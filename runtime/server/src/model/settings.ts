import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Collect likely secret strings from an explicit env map and optional auth.json
 * under `root`. Callers must pass values; no ambient environment or cwd (A7).
 */
export function projectSecrets(
  root: string,
  env: Readonly<Record<string, string | undefined>> = {},
): readonly string[] {
  const values = Object.entries(env)
    .filter(([key]) => /key|token|secret|password|credential/i.test(key))
    .flatMap(([, value]) => (value ? [value] : []));
  for (const directory of [".nylorun", ".env"])
    try {
      const collect = (value: unknown): void => {
        if (typeof value === "string") values.push(value);
        else if (value && typeof value === "object")
          Object.values(value).forEach(collect);
      };
      collect(
        JSON.parse(readFileSync(join(root, directory, "auth.json"), "utf8")),
      );
    } catch {
      /* The vault may not exist before setup. */
    }
  return values;
}
