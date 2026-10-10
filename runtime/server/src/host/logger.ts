import type { Logger } from "../tenant/types.js";

/** Host logger: JSON lines to stdout (CLI redirects to `runtime.log`). */
export function createHostLogger(
  write: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
): Logger {
  const emit = (
    level: "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ) => {
    write(
      JSON.stringify({
        level,
        message,
        time: new Date().toISOString(),
        ...fields,
      }),
    );
  };
  return {
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
