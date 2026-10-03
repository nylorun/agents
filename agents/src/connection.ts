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
  key: string;
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
      `Run "npx nylorun start" in this project to start its Tenant and link it, ` +
      `or set NYLORUN_RUNTIME_URL and NYLORUN_SERVER_KEY.`,
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
    // Formats 0 to 2 are from older releases.
    if (link.format < 3)
      throw new ConnectionError(
        `connection_missing: the Project link at ${linkPath} is from an older nylorun. ` +
          `Run "npx nylorun start" in this project to link it again.`,
      );
    const credentials = ProjectCredentialsFileSchema.parse(
      JSON.parse(await readFile(join(nylorun, "credentials.json"), "utf8")),
    );
    return {
      url: stripTrailingSlash(link.hostUrl),
      key: credentials.applicationKey,
      source: "project-link",
    };
  }
}

/**
 * Resolve Tenant API connection: options → environment → project link (D§7.1). A connection is a
 * Runtime URL and a key: the Runtime serves one Tenant, so nothing names it.
 */
export async function resolveConnection(options?: {
  url?: string;
  key?: string;
  cwd?: string;
}): Promise<ResolvedConnection> {
  const tried: string[] = [];

  const optionUrl = options?.url;
  const optionKey = options?.key;
  tried.push("options");
  if (optionUrl !== undefined || optionKey !== undefined) {
    if (optionUrl && optionKey) {
      return {
        url: stripTrailingSlash(optionUrl),
        key: optionKey,
        source: "options",
      };
    }
    missing(tried.concat(["environment", "project-link"]));
  }

  const envUrl = env("NYLORUN_RUNTIME_URL");
  const envServerKey = env("NYLORUN_SERVER_KEY");
  tried.push("environment");
  if (envUrl !== undefined || envServerKey !== undefined) {
    if (envUrl && envServerKey) {
      return {
        url: stripTrailingSlash(envUrl),
        key: envServerKey,
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
