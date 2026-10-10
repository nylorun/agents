import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { scrub } from "../redact.js";
import { projectSecrets } from "../model/settings.js";

/** Local JSONL observer. Writes raw engine events beside session durability files. */
export function jsonlObserver(options: {
  readonly agentId: string;
  readonly sessionId: string;
  readonly root: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): { (event: { readonly type: string }): void } {
  const directory = join(
    options.root,
    safe(options.agentId),
    safe(options.sessionId),
  );
  const file = join(directory, "observe.jsonl");
  const secrets = projectSecrets(options.root, options.env ?? {});
  return (event) => {
    const line = `${JSON.stringify(scrub(event, secrets))}\n`;
    void mkdir(directory, { recursive: true })
      .then(() => appendFile(file, line))
      .catch(() => {});
  };
}

function safe(value: string): string {
  if (value === "." || value === ".." || !/^[a-zA-Z0-9._-]+$/u.test(value)) {
    throw new Error("Refusing a path-shaped ID.");
  }
  return value;
}
