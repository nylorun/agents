/**
 * The forms that make and change an Agent (protocol 16): what `PUT /v1/agents/{id}` and
 * `POST /v1/agents/{id}/fork` take, from the forms' text fields. An Agent is made only from a
 * saved agent manifest: `name` tracks it (its latest version when the Agent is made), `name@n`
 * pins version n. On an existing Agent only its labels and owner guard change; what it runs
 * changes by a fork. The Runtime checks every field again; these helpers say which field is
 * wrong before the request. No React here, so `node --test` covers it.
 */
import type { AgentInput, AgentView, ForkAgentRequest } from "@nylorun/agents";

/** The create form's fields, as typed. */
export interface AgentForm {
  readonly id: string;
  /** The agent manifest's name. */
  readonly manifest: string;
  /** Empty: track the manifest; else the version to pin, such as `3`. */
  readonly version: string;
  /** The owner guard: only this owner's sessions may run on it. Empty: none. */
  readonly owner: string;
  /** One `key=value` per line. */
  readonly labels: string;
}

export const EMPTY_AGENT_FORM: AgentForm = { id: "", manifest: "", version: "", owner: "", labels: "" };

/** As the Runtime checks it: `/`-separated segments of letters, digits, `.`, `_` and `-`. */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
/** As `isAgentManifestName` checks it. */
const MANIFEST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const AGENT_ID_HINT =
  "An Agent id is up to 200 characters: /-separated segments of letters, digits, '.', '_' and '-', such as users/alice/triage.";

/** True when `id` can name an Agent. */
export function isAgentIdText(id: string): boolean {
  return id.length <= 200 && AGENT_ID.test(id);
}

/** `key=value` lines as labels; refuses a line without a key. */
export function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const entry = line.trim();
    if (!entry) continue;
    const at = entry.indexOf("=");
    if (at <= 0) throw new Error(`“${entry}” is not a label: use one key=value per line.`);
    labels[entry.slice(0, at).trim()] = entry.slice(at + 1).trim();
  }
  return labels;
}

/** Labels as the form shows them. */
export function labelsText(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/** `name` (tracking) or `name@n` (pinned) from a manifest's name and a version as typed. */
export function manifestRef(name: string, version: string): string {
  const manifest = name.trim();
  if (!MANIFEST_NAME.test(manifest)) throw new Error("Pick the agent manifest it is made from.");
  const text = version.trim();
  if (!text) return manifest;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("The version is a whole number from 1.");
  return `${manifest}@${n}`;
}

/** The id and body of `PUT /v1/agents/{id}` that makes an Agent from the form. */
export function agentRequest(form: AgentForm): { id: string; input: AgentInput } {
  const id = form.id.trim();
  if (!isAgentIdText(id)) throw new Error(AGENT_ID_HINT);
  const owner = form.owner.trim();
  return {
    id,
    input: {
      manifest: manifestRef(form.manifest, form.version),
      ...(owner ? { owner } : {}),
      ...(form.labels.trim() ? { labels: parseLabels(form.labels) } : {}),
    },
  };
}

/**
 * The body of `PUT /v1/agents/{id}` that changes an existing Agent's labels and owner guard: it
 * names the manifest as the Agent was made with it, which the Runtime accepts unchanged.
 */
export function editRequest(
  agent: Pick<AgentView, "manifest">,
  form: Pick<AgentForm, "labels" | "owner">,
): AgentInput {
  const owner = form.owner.trim();
  return { manifest: agent.manifest, labels: parseLabels(form.labels), owner: owner || null };
}

/** The fork form's fields, as typed. */
export interface ForkForm {
  readonly id: string;
  /** `name` or `name@n`; empty: the source's manifest, its latest version. */
  readonly manifest: string;
  readonly disk: "latest" | "empty" | number;
  readonly secrets: "copy" | "none";
}

/** The options of `agents.fork` and `agents.planFork` from the form. */
export function forkRequest(form: ForkForm): Omit<ForkAgentRequest, "requestId" | "dryRun"> {
  const id = form.id.trim();
  if (!isAgentIdText(id)) throw new Error("Give the new Agent an id, such as users/alice/triage-v2.");
  const manifest = form.manifest.trim();
  if (manifest) {
    const at = manifest.lastIndexOf("@");
    // Checked as the create form checks a name and a version.
    if (at > 0) manifestRef(manifest.slice(0, at), manifest.slice(at + 1));
    else manifestRef(manifest, "");
  }
  return { id, ...(manifest ? { manifest } : {}), disk: form.disk, secrets: form.secrets };
}
