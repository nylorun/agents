import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  ProjectCredentialsFileSchema,
  ProjectLinkFileSchema,
} from "@nylorun/core/contracts";
import type { ErrorCode } from "@nylorun/core/compatibility";
import { env } from "./http.js";

export interface ResolvedConnection {
  url: string;
  tenant: string;
  key: string;
  role: "application" | "executor";
  source: "options" | "environment" | "project-link";
}

export class ConnectionError extends Error {
  readonly code: ErrorCode = "connection_missing";
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

function missing(tried: string[]): never {
  throw new ConnectionError(
    `connection_missing: no Runtime connection found (tried ${tried.join(", ")}). ` +
      `Start the local stack with "npx nylorun up" and link this project with "npx @nylorun/cli tenant create", ` +
      `or set NYLORUN_RUNTIME_URL, NYLORUN_TENANT and NYLORUN_SERVER_KEY.`,
  );
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

async function readProjectLink(
  startDir: string,
): Promise<ResolvedConnection | undefined> {
  let dir = resolve(startDir);
  for (;;) {
    const nylorun = join(dir, ".nylorun");
    const linkPath = join(nylorun, "link.json");
    let linkRaw: string;
    try {
      linkRaw = await readFile(linkPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
        continue;
      }
      throw error;
    }
    const link = ProjectLinkFileSchema.parse(JSON.parse(linkRaw));
    const credentials = ProjectCredentialsFileSchema.parse(
      JSON.parse(await readFile(join(nylorun, "credentials.json"), "utf8")),
    );
    return {
      url: stripTrailingSlash(link.hostUrl),
      tenant: link.tenantId,
      key: credentials.applicationKey,
      role: "application",
      source: "project-link",
    };
  }
}

/** Resolve Tenant API connection: options → environment → project link (D§7.1). */
export async function resolveConnection(options?: {
  url?: string;
  tenant?: string;
  key?: string;
  cwd?: string;
}): Promise<ResolvedConnection> {
  const tried: string[] = [];

  const optionUrl = options?.url;
  const optionTenant = options?.tenant;
  const optionKey = options?.key;
  const anyOption =
    optionUrl !== undefined ||
    optionTenant !== undefined ||
    optionKey !== undefined;
  tried.push("options");
  if (anyOption) {
    if (optionUrl && optionTenant && optionKey) {
      return {
        url: stripTrailingSlash(optionUrl),
        tenant: optionTenant,
        key: optionKey,
        role: "application",
        source: "options",
      };
    }
    missing(tried.concat(["environment", "project-link"]));
  }

  const envUrl = env("NYLORUN_RUNTIME_URL");
  const envTenant = env("NYLORUN_TENANT");
  const envServerKey = env("NYLORUN_SERVER_KEY");
  const envExecutorKey = env("NYLORUN_EXECUTOR_KEY");
  const anyEnv =
    envUrl !== undefined ||
    envTenant !== undefined ||
    envServerKey !== undefined ||
    envExecutorKey !== undefined;
  tried.push("environment");
  if (anyEnv) {
    const key = envExecutorKey ?? envServerKey;
    if (envUrl && envTenant && key) {
      return {
        url: stripTrailingSlash(envUrl),
        tenant: envTenant,
        key,
        role: envExecutorKey !== undefined ? "executor" : "application",
        source: "environment",
      };
    }
    missing(tried.concat(["project-link"]));
  }

  tried.push("project-link");
  const cwd =
    options?.cwd ?? (typeof process !== "undefined" ? process.cwd() : ".");
  const fromLink = await readProjectLink(cwd);
  if (fromLink) return fromLink;

  missing(tried);
}
