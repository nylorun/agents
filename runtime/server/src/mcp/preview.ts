/**
 * A remote MCP server's tools before an agent names it (R2b C12, `POST /v1/tenant/mcp/preview`,
 * `nylorun mcp inspect`, Studio's Credentials page). It runs where plaintext credentials live:
 * the keys service (`keys/keys.ts`, `previewMcp`), in the gateway or in process.
 *
 * One connection: `initialize` and `tools/list` with the installation vault's credential for the
 * URL (its headers, and its `via`), under the Host's address policy, within 15 s; then it closes.
 * It never calls a tool, and sends no identity header: no person asked. A server that answers
 * `401` is `authRequired`, with its RFC 9728 protected-resource metadata when it publishes any,
 * read under the same policy. No credential value sent is in the answer (`scrubValues`, C8).
 */
import {
  INSTALLATION_OWNER,
  McpPreviewRequestSchema,
  type McpPreview,
  type McpPreviewRequest,
  type McpPreviewTool,
} from "@nylorun/core/contracts";
import type { McpServerManifest } from "@nylorun/core/define";
import { scrubValues } from "../redact.js";
import { HttpError } from "../tenant/http.js";
import { guardedFetch, OutboundRefused, type OutboundPolicy } from "../tenant/outbound.js";
import { VaultError } from "../vault/error.js";
import { credentialSecrets } from "../vault/headers.js";
import type { AuthorizeResult, VaultService } from "../vault/service.js";
import {
  CredentialRejected,
  listMcpTools,
  McpCallFailed,
  openMcpServer,
  type LiveConnection,
  type McpClient,
  type McpToolPage,
} from "./connect.js";

/** How long a preview may take, `initialize` and every `tools/list` page together. */
export const MCP_PREVIEW_TIMEOUT_MS = 15_000;
/** The largest protected-resource metadata document read. */
const RESOURCE_METADATA_MAX_BYTES = 64 * 1024;
/** Host labels that name a service's role rather than the service. */
const GENERIC_LABELS = new Set(["mcp", "www", "api"]);

export interface McpPreviewOptions {
  readonly vault: Pick<VaultService, "authorize" | "getVault" | "listVaults">;
  /** The Host's address policy for developer URLs (`TenantConfig.delivery`). */
  readonly policy: OutboundPolicy;
  /** Default `MCP_PREVIEW_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Tests replace how the server is opened. */
  readonly open?: typeof openMcpServer;
}

/**
 * The server name a preview makes model names with when the request gives none: the URL host's
 * name before its top-level domain, without a leading `mcp`, `www` or `api` (`linear` for
 * `mcp.linear.app`); an IP address or a one-label host whole. Characters outside
 * `[A-Za-z0-9_-]` become `_`.
 */
export function previewServerName(url: string): string {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const labels = host.split(".").filter(Boolean);
  const ip = /^[\d.]+$/.test(host) || host.includes(":");
  let name = host;
  if (!ip && labels.length > 1) {
    const named = labels.slice(0, -1);
    while (named.length > 1 && GENERIC_LABELS.has(named[0]!.toLowerCase())) named.shift();
    name = named.at(-1)!;
  }
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "server";
}

/** Lists the server's tools as an agent's session would see them; never calls one. */
export async function previewMcpServer(
  body: McpPreviewRequest,
  options: McpPreviewOptions,
): Promise<McpPreview> {
  const request = McpPreviewRequestSchema.parse(body);
  const type = request.type ?? "streamable-http";
  const name = request.name ?? previewServerName(request.url);
  const server = { name, type, url: request.url } as McpServerManifest;
  const authorized = await credentialFor(options.vault, request);
  const secrets =
    authorized.status === "authorized" ? credentialSecrets(authorized.headers) : [];
  const credentialSent = authorized.status === "authorized";
  const base = { name, url: request.url, type, credentialSent } as const;
  const signal = AbortSignal.timeout(options.timeoutMs ?? MCP_PREVIEW_TIMEOUT_MS);
  const open = options.open ?? openMcpServer;

  let connection: LiveConnection | undefined;
  try {
    connection = await open({
      server,
      // Read once: one audit row, and the same credential for every request.
      authorize: async () => authorized,
      policy: options.policy,
      signal,
    });
    const pages: McpToolPage[] = [];
    const listing: McpClient = {
      listTools: async (params, requestOptions) => {
        const page = await connection!.client.listTools(params, requestOptions);
        pages.push(page);
        return page;
      },
      callTool: () => Promise.reject(new Error("A preview never calls a tool")),
    };
    const listed = await listMcpTools(listing, {
      capabilityId: "preview",
      serverName: name,
      taken: new Set(),
      signal,
    });
    const modelNames = new Map(listed.tools.map((tool) => [tool.serverToolName, tool.name]));
    const tools: McpPreviewTool[] = pages
      .flatMap((page) => page.tools)
      .filter((tool) => typeof tool.name === "string" && tool.name.length > 0)
      .map((tool) => {
        const modelName = modelNames.get(tool.name);
        return {
          serverToolName: tool.name,
          ...(modelName === undefined ? {} : { modelName }),
          ...(typeof tool.description === "string" && tool.description.length > 0
            ? { description: tool.description }
            : {}),
          ...(isRecord(tool.annotations) && Object.keys(tool.annotations).length > 0
            ? { annotations: { ...tool.annotations } }
            : {}),
          schemaBytes: Buffer.byteLength(JSON.stringify(tool.inputSchema ?? {})),
        };
      });
    const preview: McpPreview = {
      ...base,
      ...(connection.serverInfo === undefined ? {} : { serverInfo: { ...connection.serverInfo } }),
      ...(connection.instructions === undefined ? {} : { instructions: connection.instructions }),
      tools,
      renamed: listed.renamed.map(({ serverToolName, name: renamedTo }) => ({
        serverToolName,
        name: renamedTo,
      })),
    };
    return scrubValues(preview, secrets).value;
  } catch (error) {
    if (error instanceof CredentialRejected) {
      const authRequired = await protectedResource(request.url, error.challenge, options.policy, signal);
      return scrubValues(
        { ...base, tools: [], renamed: [], authRequired } satisfies McpPreview,
        secrets,
      ).value;
    }
    throw failed(name, error, signal, secrets, options.timeoutMs ?? MCP_PREVIEW_TIMEOUT_MS);
  } finally {
    await connection?.close().catch(() => undefined);
  }
}

/**
 * The installation vault credential for the URL: from `vaultId`, else from every installation
 * vault. None is a preview without one; two or more without `vaultId` is a refusal that names
 * them.
 */
async function credentialFor(
  vault: McpPreviewOptions["vault"],
  request: McpPreviewRequest,
): Promise<AuthorizeResult> {
  let vaultIds: string[];
  if (request.vaultId !== undefined) {
    const found = await vault.getVault(request.vaultId);
    if (found.ownerUserId !== INSTALLATION_OWNER)
      throw new VaultError(400, "A preview uses an installation vault's credential: no person asked for it");
    vaultIds = [found.id];
  } else
    vaultIds = (await vault.listVaults(undefined, { installation: true })).map((found) => found.id);
  if (vaultIds.length === 0) return { status: "unauthenticated", url: request.url, headers: {} };
  const result = await vault.authorize({ vaultIds, credentialSelections: [], url: request.url });
  if (result.status !== "refused") return result;
  throw new HttpError(
    409,
    result.reason === "ambiguous"
      ? "Several installation vaults hold a credential for this URL: name one with vaultId"
      : `The installation vault's credential for this URL cannot be used (${result.reason})`,
    { code: "request_rejected", details: { reason: result.reason, credentialIds: result.credentialIds } },
  );
}

/** A preview that listed nothing: `mcp_preview_failed`, with the code a tool call would have had. */
function failed(
  server: string,
  error: unknown,
  signal: AbortSignal,
  secrets: readonly string[],
  timeoutMs: number,
): Error {
  if (error instanceof HttpError || error instanceof VaultError) return error;
  const failure = signal.aborted
    ? { code: "mcp.unreachable", message: `The MCP server '${server}' did not answer within ${timeoutMs / 1000} s` }
    : error instanceof McpCallFailed
      ? { code: error.code, message: error.message }
      : {
          code: "mcp.unreachable",
          message:
            refusedBy(error) !== undefined
              ? `The MCP server '${server}' was not called: ${refusedBy(error)!.message}`
              : `The MCP server '${server}' could not be listed: ${error instanceof Error ? error.message : String(error)}`,
        };
  const message = scrubValues(failure.message.slice(0, 2_000), secrets).value;
  return new HttpError(502, message, { code: "mcp_preview_failed", details: { failure: failure.code } });
}

/** The Host's refusal of the address, when that is why the server was not reached. */
function refusedBy(error: unknown): OutboundRefused | undefined {
  if (error instanceof OutboundRefused) return error;
  return error instanceof Error && error.cause instanceof OutboundRefused ? error.cause : undefined;
}

/**
 * What a `401` says about signing in (RFC 9728): the metadata its `WWW-Authenticate` names in
 * `resource_metadata`, else the one at the URL's well-known path (with the URL's path, then at
 * the origin). Absent fields when the server publishes none.
 */
async function protectedResource(
  url: string,
  challenge: string | undefined,
  policy: OutboundPolicy,
  signal: AbortSignal,
): Promise<NonNullable<McpPreview["authRequired"]>> {
  const named = challenge === undefined ? undefined : resourceMetadataParam(challenge);
  const target = new URL(url);
  const wellKnown = "/.well-known/oauth-protected-resource";
  const path = target.pathname.replace(/\/$/, "");
  const candidates = named
    ? [named]
    : [...(path ? [`${target.origin}${wellKnown}${path}`] : []), `${target.origin}${wellKnown}`];
  const fetchMetadata = guardedFetch(policy, { maxResponseBytes: RESOURCE_METADATA_MAX_BYTES });
  for (const candidate of candidates) {
    let resolved: string;
    try {
      resolved = new URL(candidate, url).href;
    } catch {
      continue;
    }
    try {
      const response = await fetchMetadata(resolved, {
        headers: { accept: "application/json" },
        signal,
      });
      if (!response.ok) continue;
      const document = (await response.json()) as unknown;
      if (isRecord(document)) return { resourceMetadataUrl: resolved, resourceMetadata: document };
    } catch {
      // Unreachable, refused or not JSON: the next place, or no metadata.
    }
  }
  return {};
}

/** `resource_metadata` of a `WWW-Authenticate` challenge (RFC 9728 §5.1). */
function resourceMetadataParam(challenge: string): string | undefined {
  const match = /resource_metadata\s*=\s*(?:"([^"]*)"|([^\s,]+))/i.exec(challenge);
  const value = match?.[1] ?? match?.[2];
  return value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
