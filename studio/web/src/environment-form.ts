/**
 * The Environments page's recipe form (protocol 11, D55): what `PUT /v1/environments/{id}`
 * takes, from the form's text fields, and the form an existing Environment fills. A `PUT` on an
 * existing Environment keeps what it does not send; `kind` and `storage` are fixed, so an edit
 * sends neither. The Runtime checks every field again (and against the Tenant's limits); these
 * helpers say which field is wrong before the request. No React here, so `node --test` covers it.
 */
import type { EnvironmentRecipeInput, EnvironmentView } from "@nylorun/agents";

export const ENVIRONMENT_FORM_KINDS = ["virtual", "pod", "none"] as const;
export type EnvironmentFormKind = (typeof ENVIRONMENT_FORM_KINDS)[number];

/** The form's fields, as typed. */
export interface EnvironmentForm {
  readonly id: string;
  readonly kind: EnvironmentFormKind;
  /** Pods: the workload image. */
  readonly image: string;
  readonly cpus: string;
  /** Such as `512MiB` or `2GiB`. */
  readonly memory: string;
  /** Pods: the volume's size, such as `5GiB`. Fixed once created. */
  readonly storage: string;
  /** Hosts the sandbox may reach, separated by commas, spaces or lines. */
  readonly allowedHosts: string;
  /** One `key=value` per line. */
  readonly labels: string;
  /** The owner guard: only this owner's sessions may name it. Empty: none. */
  readonly ownerUserId: string;
  /** Such as `15m`. Empty: the Tenant's. */
  readonly idle: string;
  /** Such as `30d`. Empty: never. */
  readonly deleteAfter: string;
}

export const EMPTY_ENVIRONMENT_FORM: EnvironmentForm = {
  id: "",
  kind: "virtual",
  image: "",
  cpus: "",
  memory: "",
  storage: "",
  allowedHosts: "",
  labels: "",
  ownerUserId: "",
  idle: "",
  deleteAfter: "",
};

/** As the Runtime checks it: `/`-separated segments of letters, digits, `.`, `_` and `-`. */
const ENVIRONMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const SIZE = /^[1-9]\d*(?:B|KiB|MiB|GiB|TiB)$/;
const DURATION = /^[1-9]\d*(?:ms|s|m|h|d)$/;

/** True when `id` can name an Environment. */
export function isEnvironmentIdText(id: string): boolean {
  return id.length <= 200 && ENVIRONMENT_ID.test(id);
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

/** Hosts separated by commas, spaces or lines: lowercase, each once. */
export function parseHosts(text: string): string[] {
  const hosts: string[] = [];
  for (const entry of text.split(/[\s,]+/)) {
    const host = entry.trim().toLowerCase();
    if (!host || hosts.includes(host)) continue;
    if (host.includes("/") || host.includes(":"))
      throw new Error(`“${entry.trim()}” is not a host name: no scheme, path or port.`);
    hosts.push(host);
  }
  return hosts;
}

function duration(name: string, value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (!DURATION.test(text)) throw new Error(`${name} must be a duration such as 30s, 15m or 1h.`);
  return text;
}

function size(name: string, value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (!SIZE.test(text)) throw new Error(`${name} must be a size such as 512MiB or 2GiB.`);
  return text;
}

/**
 * The body of `PUT /v1/environments/{id}`. Creating sends what the form names (empty fields
 * take the Tenant's defaults); editing (`existing`) sends the recipe as the form holds it, so a
 * cleared field clears it, but never `kind` or `storage`.
 */
export function environmentRequest(
  form: EnvironmentForm,
  existing?: Pick<EnvironmentView, "kind">,
): EnvironmentRecipeInput {
  const kind = existing?.kind ?? form.kind;
  const compute = kind !== "none";
  const pod = kind === "pod";
  const cpusText = form.cpus.trim();
  const cpus = cpusText ? Number(cpusText) : undefined;
  if (cpus !== undefined && (!Number.isInteger(cpus) || cpus < 1 || cpus > 64))
    throw new Error("CPUs must be a whole number from 1 to 64.");
  const memory = size("Memory", form.memory);
  const storage = size("Storage", form.storage);
  const hosts = parseHosts(form.allowedHosts);
  if (!compute && (cpus !== undefined || memory || hosts.length))
    throw new Error("An Environment of kind none has no sandbox: no resources or network.");
  if (!pod && form.image.trim()) throw new Error("Only a pod runs an image.");
  if (!existing && !pod && storage) throw new Error("Only a pod has storage.");
  const idle = duration("Idle", form.idle);
  const deleteAfter = duration("Delete after", form.deleteAfter);
  const owner = form.ownerUserId.trim();
  const resources =
    cpus !== undefined || memory
      ? { ...(cpus !== undefined ? { cpus } : {}), ...(memory ? { memory } : {}) }
      : undefined;
  const lifecycle = { ...(idle ? { idle } : {}), ...(deleteAfter ? { deleteAfter } : {}) };
  if (existing)
    return {
      labels: parseLabels(form.labels),
      ...(pod && form.image.trim() ? { image: form.image.trim() } : {}),
      ...(resources ? { resources } : {}),
      ...(compute ? { network: { allowedHosts: hosts } } : {}),
      ownerUserId: owner || null,
      lifecycle,
    };
  return {
    kind,
    ...(form.labels.trim() ? { labels: parseLabels(form.labels) } : {}),
    ...(pod && form.image.trim() ? { image: form.image.trim() } : {}),
    ...(resources ? { resources } : {}),
    ...(pod && storage ? { storage } : {}),
    ...(hosts.length ? { network: { allowedHosts: hosts } } : {}),
    ...(owner ? { ownerUserId: owner } : {}),
    ...(idle || deleteAfter ? { lifecycle } : {}),
  };
}

/** The form an existing Environment fills, to change its recipe. */
export function environmentForm(view: EnvironmentView): EnvironmentForm {
  const recipe = view.recipe;
  return {
    id: view.id,
    kind: view.kind,
    image: recipe.image ?? "",
    cpus: recipe.resources ? String(recipe.resources.cpus) : "",
    memory: recipe.resources?.memory ?? "",
    storage: recipe.storage ?? "",
    allowedHosts: (recipe.network?.allowedHosts ?? []).join(", "),
    labels: labelsText(view.labels),
    ownerUserId: view.ownerUserId ?? "",
    idle: recipe.lifecycle.idle ?? "",
    deleteAfter: recipe.lifecycle.deleteAfter ?? "",
  };
}
