import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
});

/** The built dashboard (`dist/web`) beside this module's compile output. */
export function packagedWebRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "web");
}

/** Resolves a request path inside `root`, or undefined when it escapes it. */
export function staticPath(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const candidate = resolve(root, decoded.replace(/^\/+/, "") || "index.html");
  return candidate === root || candidate.startsWith(`${root}${sep}`)
    ? candidate
    : undefined;
}

/** How the dashboard's files are served: who may frame them, and what `index.html` carries. */
export type DashboardOptions = Readonly<{
  /** The `frame-ancestors` source list, e.g. `nylorun://localhost`, or `'none'`. */
  frameAncestors: string;
  /** Rewrites `index.html` before it is sent (Studio injects the frame allowlist). */
  transformIndex?: (html: string) => string;
}>;

function staticHeaders(
  file: string,
  options: DashboardOptions,
): Record<string, string> {
  const immutable = file.includes(`${sep}assets${sep}`);
  return {
    "content-type": MIME_TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": immutable
      ? "public, max-age=31536000, immutable"
      : "no-store",
    "x-content-type-options": "nosniff",
    // Dashboard files may be framed by the allowlist only (Studio §8.9); no
    // X-Frame-Options, which cannot name origins.
    "content-security-policy": `frame-ancestors ${options.frameAncestors}`,
  };
}

async function sendFile(
  response: ServerResponse,
  method: string,
  file: string,
  options: DashboardOptions,
): Promise<boolean> {
  try {
    let content: Buffer | string = await readFile(file);
    if (options.transformIndex && file.endsWith(`${sep}index.html`))
      content = options.transformIndex(content.toString("utf8"));
    response.removeHeader("x-frame-options");
    response.writeHead(200, staticHeaders(file, options));
    response.end(method === "HEAD" ? undefined : content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Serves the dashboard from `root`, falling back to `index.html` for
 * extensionless paths (client-side routes such as `/tenants/<id>`).
 */
export async function serveDashboard(
  response: ServerResponse,
  method: string,
  pathname: string,
  root: string,
  reject: (status: number, message: string) => void,
  options: DashboardOptions = { frameAncestors: "'none'" },
): Promise<void> {
  const target = staticPath(root, pathname);
  if (target === undefined) {
    reject(400, "Invalid Studio asset path.");
    return;
  }
  if (await sendFile(response, method, target, options)) return;
  if (extname(target) !== "") {
    reject(404, "Studio asset not found.");
    return;
  }
  if (!(await sendFile(response, method, join(root, "index.html"), options)))
    reject(500, "The Studio dashboard is missing from this image. Rebuild it.");
}
