/**
 * The Environments page's recipe form (protocol 11, D55): what `PUT /v1/environments/{id}`
 * takes, from the form's text fields, and the form an existing Environment fills. A `PUT` on an
 * existing Environment keeps what it does not send; `kind` and `storage` are fixed, so an edit
 * sends neither. A pod's setup commands and input files (R2d step 2) and a new Environment's
 * starting disk version (`from`, step 3) are part of the same form. The Runtime checks every
 * field again (and against the Tenant's limits); these helpers say which field is wrong before
 * the request. No React here, so `node --test` covers it.
 */
import type {
  EnvironmentRecipeInput,
  EnvironmentView,
} from "@nylorun/agents";

type EnvironmentSetupCommand = NonNullable<EnvironmentRecipeInput["setup"]>[number];
type EnvironmentFile = NonNullable<EnvironmentRecipeInput["files"]>[number];

export const ENVIRONMENT_FORM_KINDS = ["virtual", "pod", "none"] as const;
export type EnvironmentFormKind = (typeof ENVIRONMENT_FORM_KINDS)[number];

/** As `ENVIRONMENT_SETUP_MAX`: the most setup commands, and the most input files, a recipe holds. */
export const SETUP_MAX = 16;

/** One setup command, as typed. */
export interface SetupRow {
  readonly command: string;
  /** Default `/workspace`. */
  readonly cwd: string;
  /** Such as `10m`. Empty: 10m. */
  readonly timeout: string;
}

/** One input file: a version of a Tenant-wide artifact, copied to `path`. */
export interface FileRow {
  readonly artifactId: string;
  readonly version: string;
  readonly path: string;
}

export const EMPTY_SETUP_ROW: SetupRow = { command: "", cwd: "", timeout: "" };
export const EMPTY_FILE_ROW: FileRow = { artifactId: "", version: "", path: "" };

/** A new Environment's disk starts from this version of another Environment's disk. */
export interface EnvironmentFrom {
  readonly environment: string;
  readonly version: number;
}

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
  /** The harness that runs its sessions. Empty: `nylorun`, ours. */
  readonly harness: string;
  /** Pods: commands run on a new disk, in order. */
  readonly setup: readonly SetupRow[];
  /** Pods: artifact versions copied in on a new disk, before `setup`. */
  readonly files: readonly FileRow[];
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
  harness: "",
  setup: [],
  files: [],
};

/** As the Runtime checks it: `/`-separated segments of letters, digits, `.`, `_` and `-`. */
const ENVIRONMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const SIZE = /^[1-9]\d*(?:B|KiB|MiB|GiB|TiB)$/;
const DURATION = /^[1-9]\d*(?:ms|s|m|h|d)$/;
/** As `HarnessIdSchema` checks it. */
const HARNESS_ID = /^[a-z][a-z0-9-]{1,62}$/;
/** As `isArtifactId` checks it: `af_` and a lowercase ULID. */
const ARTIFACT_ID = /^af_[0-9a-hjkmnp-tv-z]{26}$/;

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

/** `/workspace` or a path under it, without `.` or `..` segments, as the Runtime checks it. */
function workspacePath(name: string, value: string): string {
  const path = value.trim();
  if (
    !(path === "/workspace" || path.startsWith("/workspace/")) ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  )
    throw new Error(`${name} must be /workspace or a path under it, such as /workspace/data.`);
  return path;
}

/** The form's setup commands: rows left empty are dropped. */
export function setupRequest(rows: readonly SetupRow[]): EnvironmentSetupCommand[] {
  const commands: EnvironmentSetupCommand[] = [];
  for (const [index, row] of rows.entries()) {
    const command = row.command.trim();
    if (!command && !row.cwd.trim() && !row.timeout.trim()) continue;
    const n = index + 1;
    if (!command) throw new Error(`Setup command ${n} has no command.`);
    const cwd = row.cwd.trim() ? workspacePath(`Setup command ${n}'s directory`, row.cwd) : undefined;
    const timeout = duration(`Setup command ${n}'s timeout`, row.timeout);
    commands.push({ command, ...(cwd ? { cwd } : {}), ...(timeout ? { timeout } : {}) });
  }
  if (commands.length > SETUP_MAX) throw new Error(`A recipe holds at most ${SETUP_MAX} setup commands.`);
  return commands;
}

/** The form's input files: rows left empty are dropped. */
export function filesRequest(rows: readonly FileRow[]): EnvironmentFile[] {
  const files: EnvironmentFile[] = [];
  for (const [index, row] of rows.entries()) {
    const artifactId = row.artifactId.trim();
    if (!artifactId && !row.version.trim() && !row.path.trim()) continue;
    const n = index + 1;
    if (!ARTIFACT_ID.test(artifactId))
      throw new Error(`Input file ${n} needs an artifact id, such as af_01k…`);
    const version = Number(row.version.trim());
    if (!Number.isSafeInteger(version) || version < 1)
      throw new Error(`Input file ${n} needs a version: a whole number from 1.`);
    files.push({ artifactId, version, path: workspacePath(`Input file ${n}'s path`, row.path) });
  }
  if (files.length > SETUP_MAX) throw new Error(`A recipe holds at most ${SETUP_MAX} input files.`);
  return files;
}

/**
 * The body of `PUT /v1/environments/{id}`. Creating sends what the form names (empty fields
 * take the Tenant's defaults); editing (`existing`) sends the recipe as the form holds it, so a
 * cleared field clears it, but never `kind` or `storage`.
 */
export function environmentRequest(
  form: EnvironmentForm,
  existing?: Pick<EnvironmentView, "kind" | "recipe">,
  from?: EnvironmentFrom,
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
  const harness = form.harness.trim();
  if (harness && !HARNESS_ID.test(harness))
    throw new Error("Harness must be a harness id: lowercase letters, digits and dashes, starting with a letter.");
  const setup = setupRequest(form.setup);
  const files = filesRequest(form.files);
  if (!pod && (setup.length || files.length))
    throw new Error("Only a pod runs setup commands and takes input files.");
  if (existing && from) throw new Error("Only a new Environment starts from a disk version.");
  if (from && kind === "none") throw new Error("An Environment of kind none has no disk.");
  const resources =
    cpus !== undefined || memory
      ? { ...(cpus !== undefined ? { cpus } : {}), ...(memory ? { memory } : {}) }
      : undefined;
  const lifecycle = { ...(idle ? { idle } : {}), ...(deleteAfter ? { deleteAfter } : {}) };
  if (existing) {
    // An empty list where the recipe has none is no change: sending `[]` would bump its version.
    const had = existing.recipe;
    return {
      labels: parseLabels(form.labels),
      ...(pod && form.image.trim() ? { image: form.image.trim() } : {}),
      ...(resources ? { resources } : {}),
      ...(compute ? { network: { allowedHosts: hosts } } : {}),
      // A cleared harness goes back to ours.
      ...(harness ? { harness } : had.harness !== "nylorun" ? { harness: "nylorun" } : {}),
      ownerUserId: owner || null,
      lifecycle,
      ...(pod && (setup.length || had.setup !== undefined) ? { setup } : {}),
      ...(pod && (files.length || had.files !== undefined) ? { files } : {}),
    };
  }
  return {
    kind,
    ...(form.labels.trim() ? { labels: parseLabels(form.labels) } : {}),
    ...(pod && form.image.trim() ? { image: form.image.trim() } : {}),
    ...(resources ? { resources } : {}),
    ...(pod && storage ? { storage } : {}),
    ...(hosts.length ? { network: { allowedHosts: hosts } } : {}),
    ...(harness ? { harness } : {}),
    ...(owner ? { ownerUserId: owner } : {}),
    ...(idle || deleteAfter ? { lifecycle } : {}),
    ...(setup.length ? { setup } : {}),
    ...(files.length ? { files } : {}),
    ...(from ? { from: { environment: from.environment, version: from.version } } : {}),
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
    harness: recipe.harness === "nylorun" ? "" : recipe.harness,
    setup: (recipe.setup ?? []).map((command) => ({
      command: command.command,
      cwd: command.cwd ?? "",
      timeout: command.timeout ?? "",
    })),
    files: (recipe.files ?? []).map((file) => ({
      artifactId: file.artifactId,
      version: String(file.version),
      path: file.path,
    })),
  };
}

/**
 * The form a new Environment that starts from `source`'s disk version fills: `source`'s kind and
 * recipe, a new id, no owner guard (its vault starts empty).
 */
export function forkForm(source: EnvironmentView, id: string): EnvironmentForm {
  return { ...environmentForm(source), id, ownerUserId: "" };
}
