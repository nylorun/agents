import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "./types.js";

/**
 * Tenant logger (D12): JSON lines to `logs/tenant.log` with `tenantId` on every record.
 * Never writes to the process stdout/stderr APIs.
 */
export function createTenantLogger(options: {
  tenantId: string;
  logPath: string;
}): Logger {
  const { tenantId, logPath } = options;
  mkdirSync(dirname(logPath), { recursive: true });

  const write = (
    level: "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ): void => {
    const record = {
      ts: new Date().toISOString(),
      level,
      tenantId,
      message,
      ...(fields ?? {}),
    };
    appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  };

  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
