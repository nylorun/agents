/**
 * Agent manifests and Agents over the Runtime API (protocol 16), for tests: save a loop
 * manifest (what an SDK builder makes: agent manifest v7's shape, or a workflow manifest v3) as an
 * agent manifest v8 with a runtime section, and make an Agent from it, so a session can open on it
 * (`PUT /v1/sessions/{id}` with `agent`).
 */
import { expect } from "vitest";
import { harnessSectionOf } from "@nylorun/core/define";
import type {
  AgentManifest,
  AgentManifestV8,
  AgentView,
  PutAgentRequest,
  PutAgentSecretRequest,
  RuntimeSection,
  WorkflowManifest,
} from "@nylorun/core/contracts";

export type Loop = AgentManifest | WorkflowManifest;
/** A built agent or flow (`{ id, manifest }`), or its loop manifest itself. */
export type AgentSource = Loop | { readonly id: string; readonly manifest: Loop };

const loopOf = (source: AgentSource): Loop => ("manifest" in source ? source.manifest : source);

export interface ManifestOptions {
  /** The manifest's name; default the loop manifest's id. */
  name?: string;
  /** The runtime section; default none (kind `none`). */
  runtime?: RuntimeSection;
  /** The harness that runs the loop; default ours. */
  harness?: string;
  /** The harness section's `loop` settings. */
  loop?: Record<string, unknown>;
}

/** The agent manifest v8 a loop manifest makes, with its id as the name unless `name` is given. */
export function manifestOf(source: AgentSource, options: ManifestOptions = {}): AgentManifestV8 {
  const loop = loopOf(source);
  const harness = harnessSectionOf(loop, options.harness === undefined ? {} : { harness: options.harness });
  return {
    manifestSchemaVersion: 8,
    name: options.name ?? loop.id,
    ...(loop.description === undefined ? {} : { description: loop.description }),
    ...(loop.metadata === undefined ? {} : { metadata: loop.metadata }),
    harness: options.loop === undefined ? harness : { ...harness, loop: options.loop },
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
  } as AgentManifestV8;
}

/** `PUT /v1/agent-manifests/{name}`: the status and the answer. */
export async function writeManifest(
  url: string,
  headers: Record<string, string>,
  manifest: AgentManifestV8,
  options: { ifMatch?: number; dryRun?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(
    `${url}/v1/agent-manifests/${encodeURIComponent(manifest.name)}${options.dryRun ? "?dryRun=true" : ""}`,
    {
      method: "PUT",
      headers: { ...headers, ...(options.ifMatch === undefined ? {} : { "if-match": String(options.ifMatch) }) },
      body: JSON.stringify(manifest),
    },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** `writeManifest`, expecting a 200; the saved version. */
export async function saveManifest(
  url: string,
  headers: Record<string, string>,
  manifest: AgentManifestV8,
): Promise<number> {
  const saved = await writeManifest(url, headers, manifest);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  return (saved.body as { manifest: { version: number } }).manifest.version;
}

/** `PUT /v1/agents/{id}`: the status and the answer. */
export async function writeAgent(
  url: string,
  headers: Record<string, string>,
  id: string,
  body: PutAgentRequest,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}/v1/agents/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** `writeAgent`, expecting a 200; the Agent. */
export async function putAgent(
  url: string,
  headers: Record<string, string>,
  id: string,
  body: PutAgentRequest,
): Promise<AgentView> {
  const written = await writeAgent(url, headers, id, body);
  expect(written.status, JSON.stringify(written.body)).toBe(200);
  return written.body as unknown as AgentView;
}

export interface DeployOptions extends ManifestOptions {
  /** The Agent's id; default the manifest's name. */
  id?: string;
  owner?: string;
  labels?: Record<string, string>;
  /** Secrets to write into the Agent's vault once it exists, by name. */
  secrets?: Record<string, PutAgentSecretRequest | { value: string } | { headers: Record<string, string> }>;
}

/**
 * Saves `source` as an agent manifest and makes an Agent from it (tracking the manifest), with
 * `secrets` written into its vault: what a test needs before `PUT /v1/sessions/{id}` names the
 * Agent. Both calls are get-or-create, so a test may deploy the same agent again.
 */
export async function deploy(
  url: string,
  headers: Record<string, string>,
  source: AgentSource,
  options: DeployOptions = {},
): Promise<AgentView> {
  const manifest = manifestOf(source, options);
  await saveManifest(url, headers, manifest);
  const agent = await putAgent(url, headers, options.id ?? manifest.name, {
    manifest: manifest.name,
    ...(options.owner === undefined ? {} : { owner: options.owner }),
    ...(options.labels === undefined ? {} : { labels: options.labels }),
  });
  for (const [name, body] of Object.entries(options.secrets ?? {})) await putSecret(url, headers, agent.id, name, body as PutAgentSecretRequest);
  return agent;
}

/** `PUT /v1/agents/{id}/secrets/{name}`: the status and the answer. */
export async function writeSecret(
  url: string,
  headers: Record<string, string>,
  agentId: string,
  name: string,
  body: PutAgentSecretRequest | { value: string } | { headers: Record<string, string> },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(
    `${url}/v1/agents/${encodeURIComponent(agentId)}/secrets/${encodeURIComponent(name)}`,
    { method: "PUT", headers, body: JSON.stringify(body) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** `writeSecret`, expecting a 200. */
export async function putSecret(
  url: string,
  headers: Record<string, string>,
  agentId: string,
  name: string,
  body: PutAgentSecretRequest | { value: string } | { headers: Record<string, string> },
): Promise<Record<string, unknown>> {
  const written = await writeSecret(url, headers, agentId, name, body);
  expect(written.status, JSON.stringify(written.body)).toBe(200);
  return written.body;
}

/** `PUT /v1/sessions/{id}` on Agent `agent` for `ownerUserId`: the response. */
export function openSession(
  url: string,
  headers: Record<string, string>,
  id: string,
  body: { agent: string; ownerUserId: string; info?: Record<string, unknown>; requestId?: string },
): Promise<Response> {
  return fetch(`${url}/v1/sessions/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ requestId: `open-${id}`, ...body }),
  });
}
