/**
 * What the Tenant's page shows, as plain rows: its status, its compute settings, its Runtime
 * limits, its tool policy, and its model usage and budgets. Pure, so the tests read it without
 * a browser.
 */
import type { ManagementClient } from "@nylorun/admin/client";
import type { SpecSection, Tone } from "@/agent-spec";
import type { TenantTab } from "@/agent-path";
import { formatCost } from "./usage-format.ts";

export type TenantStatus = Awaited<ReturnType<ManagementClient["tenant"]["status"]>>;
export type SandboxView = Awaited<ReturnType<ManagementClient["settings"]["sandbox"]["get"]>>;
export type ArtifactsView = Awaited<ReturnType<ManagementClient["settings"]["artifacts"]["get"]>>;
export type SkillsView = Awaited<ReturnType<ManagementClient["settings"]["skills"]["get"]>>;
export type RuntimeLimits = Awaited<ReturnType<ManagementClient["settings"]["limits"]["get"]>>["limits"];
export type ToolRule = Awaited<ReturnType<ManagementClient["toolPolicy"]["get"]>>["rules"][number];
export type ModelBudget = Awaited<ReturnType<ManagementClient["models"]["budgets"]["get"]>>["budgets"][number];
export type UsageTotals = Awaited<ReturnType<ManagementClient["models"]["usage"]>>;
export type SigningKey = Awaited<ReturnType<ManagementClient["signingKeys"]["list"]>>[number];
export type OperatorKey = Awaited<ReturnType<ManagementClient["keys"]["list"]>>[number];

const KiB = 1024;
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

/** `10 GiB`, `512 KiB`, `1.5 MiB`, `300 B`: an exact unit when one divides it. */
export function bytesText(bytes: number): string {
  for (const [size, unit] of [[GiB, "GiB"], [MiB, "MiB"], [KiB, "KiB"]] as const)
    if (bytes >= size && bytes % size === 0) return `${(bytes / size).toLocaleString("en-US")} ${unit}`;
  for (const [size, unit] of [[GiB, "GiB"], [MiB, "MiB"], [KiB, "KiB"]] as const)
    if (bytes >= size) return `${(bytes / size).toFixed(1)} ${unit}`;
  return `${bytes} B`;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `30 days`, `1 h`, `10 min`, `90 s`, `250 ms`: the largest unit that divides it. */
export function durationText(ms: number): string {
  if (ms >= DAY && ms % DAY === 0) return ms === DAY ? "1 day" : `${(ms / DAY).toLocaleString("en-US")} days`;
  if (ms >= HOUR && ms % HOUR === 0) return `${ms / HOUR} h`;
  if (ms >= MINUTE && ms % MINUTE === 0) return `${ms / MINUTE} min`;
  if (ms >= SECOND && ms % SECOND === 0) return `${(ms / SECOND).toLocaleString("en-US")} s`;
  return `${ms.toLocaleString("en-US")} ms`;
}

/** `1.9 M`, `200 K`, `950`: a token count, short. */
export function tokensText(tokens: number): string {
  const short = (value: number, unit: string) => `${Number(value.toFixed(1)).toLocaleString("en-US")} ${unit}`;
  if (tokens >= 1_000_000) return short(tokens / 1_000_000, "M");
  if (tokens >= 1_000) return short(tokens / 1_000, "K");
  return String(tokens);
}

// --- Runtime limits -----------------------------------------------------------------------

export type LimitUnit = "bytes" | "duration" | "characters" | "percent" | "count";

/** What a limit counts, from its name. */
export function limitUnit(name: string): LimitUnit {
  if (name.endsWith("Bytes")) return "bytes";
  if (name.endsWith("Ms")) return "duration";
  if (name.endsWith("Chars")) return "characters";
  if (name.endsWith("Percent")) return "percent";
  return "count";
}

/** A limit's value as it reads: `32 MiB`, `10 min`, `4,096 characters`, `10%`, `1,000`. */
export function limitText(name: string, value: number): string {
  switch (limitUnit(name)) {
    case "bytes":
      return bytesText(value);
    case "duration":
      return durationText(value);
    case "characters":
      return `${value.toLocaleString("en-US")} characters`;
    case "percent":
      return `${value}%`;
    default:
      return value.toLocaleString("en-US");
  }
}

const BYTE_UNITS: Record<string, number> = { b: 1, kb: KiB, kib: KiB, mb: MiB, mib: MiB, gb: GiB, gib: GiB };
const TIME_UNITS: Record<string, number> = {
  ms: 1,
  s: SECOND,
  sec: SECOND,
  m: MINUTE,
  min: MINUTE,
  h: HOUR,
  d: DAY,
  day: DAY,
  days: DAY,
};

/**
 * The value a person typed for a limit, in its unit: `10 MiB` or a count of bytes, `15 min`
 * or a count of milliseconds, a count (commas allowed). Undefined when it is no whole number
 * the limit could hold.
 */
export function parseLimit(name: string, text: string): number | undefined {
  const match = text.trim().replaceAll(",", "").match(/^(\d+(?:\.\d+)?)\s*([a-z%]*)$/iu);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const suffix = match[2]!.toLowerCase();
  const unit = limitUnit(name);
  const scale =
    suffix === ""
      ? 1
      : unit === "bytes"
        ? BYTE_UNITS[suffix]
        : unit === "duration"
          ? TIME_UNITS[suffix]
          : unit === "percent" && suffix === "%"
            ? 1
            : unit === "characters" && /^(?:chars?|characters?)$/u.test(suffix)
              ? 1
              : undefined;
  if (scale === undefined) return undefined;
  const value = amount * scale;
  return Number.isSafeInteger(value) ? value : undefined;
}

/** The Runtime limits by area, as the Runtime documents them (`RuntimeLimitsSchema`). */
export const LIMIT_GROUPS: readonly { title: string; limits: Readonly<Record<string, string>> }[] = [
  {
    title: "Harness",
    limits: {
      recordEntryBytes: "The most JSON one entry of the record may hold",
      modelCallBytes: "The largest model call body the Model Gate reads",
      modelFileBytes: "The largest file the Model Gate sends a model",
      toolAnswerBytes: "The largest tool answer kept, and tool call body read",
      harnessStateBytes: "The most state a custom harness keeps per session",
      chunkBytes: "The most bytes one chunked Harness API answer carries",
      folderEntries: "The most files one folder artifact a harness writes may hold",
    },
  },
  {
    title: "Requests",
    limits: {
      requestBodyBytes: "The largest JSON body an API route reads",
      messageParts: "The most parts one user message carries",
      pageItems: "The most items one page of a listing holds",
      exportPageItems: "The most calls one page of the model call export holds",
      environmentEventItems: "The most events one read of an Agent's events returns",
      inlineFileBytes: "The largest file a message carries inline",
      a2aWaitMs: "How long a blocking A2A message waits for its task",
      errorExcerptChars: "How much of a failed tool's answer an error quotes",
      traceContentBytes: "The most bytes of one content attribute of an exported span",
    },
  },
  {
    title: "Labels",
    limits: {
      environmentLabels: "The most labels one Agent carries",
      artifactLabels: "The most labels one artifact carries",
      labelKeyChars: "The longest label key",
      labelValueChars: "The longest label value",
    },
  },
  {
    title: "Environments",
    limits: {
      environmentSetupCommands: "The most setup commands one manifest holds",
      environmentFiles: "The most input file entries one manifest holds",
      environmentFilesPerEntry: "The most files one input file entry names",
      environmentSecretSlots: "The most secret slots one manifest declares",
      setupCommandChars: "The longest setup command",
      setupCommandMs: "The longest timeout one setup command may ask for",
      setupOutputChars: "How much of a failed setup command's output is kept",
      setupReasonChars: "How much of that output a failed pod's reason quotes",
      setupCommandExcerptChars: "How much of the command a failed pod's reason quotes",
      manifestDescriptionChars: "The longest description of a manifest",
      secretDescriptionChars: "The longest description of a secret slot",
    },
  },
  {
    title: "Secrets",
    limits: {
      secretValueChars: "The longest secret or variable value",
      secretHosts: "The most hosts one secret may be sent to",
    },
  },
  {
    title: "Disk",
    limits: {
      diskVersionEntries: "The most entries one version of an Agent's disk holds",
      diskVersionBytes: "The most bytes of files one disk version holds",
      diskLeaseMs: "How long a disk copy's lease lasts unrenewed",
      diskPodWaitMs: "How long a disk copy waits for a pod's engine",
    },
  },
  {
    title: "Model calls",
    limits: {
      modelRequestMs: "The longest one provider request may take",
      modelIdleMs: "How long a provider's stream may go quiet",
      modelAttempts: "The attempts one model call makes, the first included",
      modelRetryDelayMs: "The delay before the second attempt; it doubles each time",
      modelProviderRetries: "The retries the provider's SDK makes within one attempt",
      modelRetryDelayMaxMs: "The longest delay the provider's SDK waits before a retry",
    },
  },
  {
    title: "Tools",
    limits: {
      toolAttempts: "How many times a tool call is sent before it fails",
      httpToolTimeoutMs: "The longest timeout an HTTP tool may ask for",
      mcpSnapshotBytes: "The most JSON a session pins of its MCP servers",
      mcpPreviewMs: "How long an MCP preview may take",
      mcpMetadataBytes: "The largest protected-resource metadata a preview reads",
      toolRules: "The most rules the tool policy holds",
      toolRuleFieldChars: "The longest selector or when path of a rule",
      toolRuleTextChars: "The longest reason or matches expression of a rule",
      modelBudgets: "The most model budgets the Tenant sets",
    },
  },
  {
    title: "Triggers",
    limits: {
      triggersPerAgent: "The most triggers one manifest declares",
      triggerMinIntervalMs: "The shortest gap between two runs of one schedule",
      triggerRunsPerHour: "The most runs one Agent's triggers start in an hour",
      triggerJitterPercent: "How far a schedule's offset may move, as part of its interval",
      triggerJitterMaxMs: "How far a schedule's offset may move at most",
      triggerPromptChars: "The longest prompt one trigger holds",
      triggerRunRetentionMs: "How long runs are kept",
      webhookBodyBytes: "The largest delivery a webhook endpoint reads",
      wakeMaxAheadMs: "How far ahead an Agent may book its next turn",
      wakeNoteChars: "The longest note a booked wake carries",
    },
  },
  {
    title: "Memory",
    limits: {
      memoryBytes: "The largest memory",
      memoriesPerAgent: "The most memories one Agent holds",
      memoryIndexLines: "The most lines of the index a session pins",
      memoryIndexBytes: "The most bytes of the index a session pins",
    },
  },
  {
    title: "Sessions and flows",
    limits: {
      sessionQueuedMessages: "The most messages queued behind a running turn",
      flowConcurrency: "The most effects one flow turn runs at once",
      flowMapItems: "The most items one map stage fans out to",
      flowLoopIterations: "The most iterations one loop stage runs",
    },
  },
];

export type LimitRow = {
  name: string;
  group: string;
  description: string;
  value: number;
  /** Undefined for a limit this Studio has no default for (a newer Runtime's). */
  default: number | undefined;
  changed: boolean;
};

/**
 * The limits in force, by group, each beside its default; a limit no group names (a newer
 * Runtime's) goes under Other.
 */
export function limitGroups(
  limits: Readonly<Record<string, number>>,
  defaults: Readonly<Record<string, number>>,
): { title: string; rows: LimitRow[] }[] {
  const row = (name: string, group: string, description: string): LimitRow => {
    const value = limits[name]!;
    const fallback = defaults[name];
    return { name, group, description, value, default: fallback, changed: fallback !== undefined && value !== fallback };
  };
  const named = new Set<string>();
  const groups = LIMIT_GROUPS.map(({ title, limits: described }) => ({
    title,
    rows: Object.entries(described)
      .filter(([name]) => {
        named.add(name);
        return limits[name] !== undefined;
      })
      .map(([name, description]) => row(name, title, description)),
  }));
  const other = Object.keys(limits)
    .filter((name) => !named.has(name))
    .sort()
    .map((name) => row(name, "Other", ""));
  return [...groups, { title: "Other", rows: other }].filter((group) => group.rows.length > 0);
}

/**
 * What `PUT /v1/tenant/limits` takes for `limits` with `name` set to `value` (or back to its
 * default when undefined): every limit that is not its default. The Runtime keeps only these,
 * so a limit left at its default follows a later default.
 */
export function limitOverrides(
  limits: Readonly<Record<string, number>>,
  defaults: Readonly<Record<string, number>>,
  name: string,
  value: number | undefined,
): Record<string, number> {
  const next: Record<string, number> = { ...limits };
  if (value === undefined) delete next[name];
  else next[name] = value;
  return Object.fromEntries(Object.entries(next).filter(([key, v]) => defaults[key] !== v));
}

// --- Status -------------------------------------------------------------------------------

export type StatusRow = { label: string; state: string; tone: Tone; detail: string; tab?: TenantTab };

const authText = (type: string | undefined) => (type === "oauth" ? "OAuth" : type === "api_key" ? "API key" : "");

/** The model the Tenant calls, as one line: `openai · gpt-5.1`; undefined when none is set. */
export function modelText(model: TenantStatus["model"]): string | undefined {
  const view = model as { configured?: boolean; provider?: string | null; model?: string | null };
  if (!view.configured || !view.provider) return undefined;
  return view.model ? `${view.provider} · ${view.model}` : view.provider;
}

/** The status, as its checks, what runs it and what it holds. */
export function statusGroups(status: TenantStatus): { title: string; rows: StatusRow[] }[] {
  const check = (ok: boolean): Pick<StatusRow, "state" | "tone"> =>
    ok ? { state: "OK", tone: "ok" } : { state: "Failing", tone: "error" };
  const stuck = status.execution?.stuckInvocations.length ?? 0;
  const model = modelText(status.model);
  const auth = authText((status.model as { authType?: string }).authType);
  const harness = status.harness;
  const streams = status.streams;
  const relay = streams?.relay;
  return [
    {
      title: "Checks",
      rows: [
        { label: "Store", ...check(status.checks.store), detail: status.path },
        {
          label: "Scheduler",
          ...check(status.checks.scheduler),
          detail: status.execution?.error
            ? status.execution.error
            : stuck === 0
              ? "No stuck invocations"
              : stuck === 1
                ? "1 invocation needs an operator"
                : `${stuck} invocations need an operator`,
        },
        {
          label: "Model",
          ...check(status.checks.model),
          detail: model ? [model, auth].filter(Boolean).join(", ") : "No model set",
          tab: "models",
        },
        { label: "Schema", ...check(status.checks.schema), detail: `Version ${status.tenant.schemaVersion}` },
      ],
    },
    {
      title: "Runtime",
      rows: [
        ...(harness
          ? [
              {
                label: "Harness",
                state: harness.mode === "in-process" ? "In-process" : "Remote",
                tone: (harness.connected > 0 ? "ok" : "warn") as Tone,
                detail: `${harness.connected} connected · workspace ${harness.workspace ? "on" : "off"}`,
              },
            ]
          : []),
        {
          label: "Sandbox",
          state: status.sandbox.backend ?? "None",
          tone: status.sandbox.backend ? "ok" : "idle",
          detail:
            status.sandbox.retained === 1 ? "1 sandbox retained" : `${status.sandbox.retained} sandboxes retained`,
          tab: "compute",
        },
        ...(streams
          ? [
              {
                label: "Event streams",
                state: streams.reachable ? "Reachable" : "Unreachable",
                tone: (streams.reachable && streams.basin.ready ? "ok" : "error") as Tone,
                detail: [
                  relay ? `Relay ${relay.active ? "active" : "standby"} · ${relay.pendingRows} pending` : "Host relay",
                  ...(relay?.lagBytes !== undefined ? [`lag ${bytesText(relay.lagBytes)}`] : []),
                  `generation ${streams.generation}`,
                  ...(streams.basin.lastError ? [streams.basin.lastError] : []),
                ].join(" · "),
              },
            ]
          : []),
      ],
    },
    {
      title: "Holds",
      rows: [
        { label: "Agents", state: String(status.agents.length), tone: "idle", detail: "", tab: "manifests" },
        {
          label: "Sessions",
          state: String(status.counts.sessions),
          tone: "idle",
          detail: `${status.counts.runningSessions} running`,
        },
        {
          label: "Uncertain effects",
          state: String(status.counts.uncertainEffects),
          tone: status.counts.uncertainEffects > 0 ? "warn" : "idle",
          detail: status.counts.uncertainEffects > 0 ? "Tool calls left in doubt" : "No tool call left in doubt",
        },
      ],
    },
  ];
}

/** How many of the status's checks fail. */
export function failingChecks(status: TenantStatus): number {
  return Object.values(status.checks).filter((ok) => !ok).length;
}

// --- Compute ------------------------------------------------------------------------------

export type ComputeRow = {
  label: string;
  value: string;
  note?: string;
  tone?: Tone;
  /** A name (a backend's, a harness's): its label in a monospace face. */
  monoLabel?: boolean;
  /** An image or host names: its value in a monospace face. */
  mono?: boolean;
};
export type ComputeSection = { id: string; title: string; hint: string; rows: ComputeRow[] };

const isolationText = (isolation: string | null) =>
  isolation === "container" ? "Container" : isolation === "process" ? "Process" : "None";
const cpuText = (cpus: number) => (cpus === 1 ? "1 CPU" : `${cpus} CPUs`);
const resourcesText = (r: { cpus: number; memoryMiB: number }) => `${cpuText(r.cpus)} · ${bytesText(r.memoryMiB * MiB)} memory`;
const PLACEMENT: Record<string, string> = { "harness-container": "the harness container", sandbox: "the sandbox" };
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Where the Tenant's Agents run, the most one may ask for, and what artifacts and skills hold. */
export function computeSections(
  sandbox: SandboxView,
  artifacts?: ArtifactsView,
  skills?: SkillsView,
  agents?: number,
): ComputeSection[] {
  const limits = sandbox.config.limits;
  const cluster = sandbox.cluster;
  const placement = Object.entries(sandbox.config.placement ?? { "*": { hosts: ["harness-container", "sandbox"] } });
  return [
    {
      id: "sandbox",
      title: "Sandbox",
      hint: "Chosen when the Runtime starts",
      rows: [
        {
          label: "Backend",
          value: sandbox.backend ?? "None",
          note: `preference ${sandbox.preference}`,
          tone: sandbox.backend ? "ok" : "warn",
        },
        { label: "Isolation", value: isolationText(sandbox.isolation), note: sandbox.reason },
        ...(cluster
          ? [
              {
                label: "Cluster",
                value: `namespace ${cluster.namespace} · context ${cluster.context}`,
                note: [cluster.ready ? "ready" : "not ready", cluster.controllerVersion && `controller ${cluster.controllerVersion}`]
                  .filter(Boolean)
                  .join(" · "),
                tone: (cluster.ready ? "ok" : "warn") as Tone,
              },
              ...(cluster.networkPolicy
                ? [
                    {
                      label: "Network policy",
                      value: cluster.networkPolicy.enforced ? "Enforced" : "Not enforced",
                      tone: (cluster.networkPolicy.enforced ? "ok" : "warn") as Tone,
                      ...(cluster.networkPolicy.probedAt ? { note: `probed ${cluster.networkPolicy.probedAt}` } : {}),
                    },
                  ]
                : []),
            ]
          : []),
        { label: "Default image", value: sandbox.defaultImage, mono: true },
      ],
    },
    {
      id: "probes",
      title: "Backends found",
      hint: "What the Runtime probed",
      rows: sandbox.probes.map((probe) => ({
        label: probe.name,
        monoLabel: true,
        value: `${isolationText(probe.isolation)} isolation${probe.version ? ` · ${probe.version}` : ""}`,
        note: probe.available ? "available" : (probe.reason ?? "not available"),
        tone: probe.available ? "ok" : "idle",
      })),
    },
    {
      id: "environments",
      title: "Environments",
      hint: "The most an Agent's runtime section may ask for",
      rows: [
        {
          label: "Allowed hosts",
          value: limits.network.length === 0 ? "None" : limits.network.join(", "),
          note: "an Agent allows a subset",
          mono: limits.network.length > 0,
        },
        { label: "Most resources", value: resourcesText(limits.resources) },
        { label: "Default resources", value: resourcesText(limits.defaultResources), note: "when it asks for none" },
        { label: "Idle", value: `Stops after ${limits.idle} without a turn` },
        ...(sandbox.config.lifecycle ? [{ label: "Stop grace", value: sandbox.config.lifecycle.stopGrace }] : []),
        ...(limits.environments !== undefined
          ? [
              {
                label: "Most Agents",
                value: limits.environments.toLocaleString("en-US"),
                ...(agents !== undefined ? { note: `${agents} in use` } : {}),
              },
            ]
          : []),
      ],
    },
    {
      id: "placement",
      title: "Placement",
      hint: "Where each harness may run its tools",
      rows: placement.map(([harness, { hosts }]) => ({
        label: harness === "*" ? "Every harness" : harness,
        monoLabel: harness !== "*",
        value: hosts.length === 0 ? "Nowhere: refused" : capitalized(hosts.map((host) => PLACEMENT[host] ?? host).join(" and ")),
      })),
    },
    ...(artifacts || skills
      ? [
          {
            id: "storage",
            title: "Storage",
            hint: "What artifacts and skills may hold",
            rows: [
              ...(artifacts
                ? [
                    { label: "Artifact file", value: `${bytesText(artifacts.limits.fileBytes)} at most` },
                    {
                      label: "Artifacts in all",
                      value: `${bytesText(artifacts.limits.totalBytes)} at most`,
                      note: `${bytesText(artifacts.usedBytes)} used`,
                    },
                  ]
                : []),
              ...(skills ? [{ label: "Skill files", value: `${bytesText(skills.limits.totalBytes)} at most for one skill` }] : []),
            ],
          },
        ]
      : []),
  ];
}

// --- Tool policy --------------------------------------------------------------------------

const STRICTNESS: Record<ToolRule["effect"], number> = { deny: 0, ask: 1, allow: 2 };

export const EFFECT_LABELS: Record<ToolRule["effect"], string> = { allow: "Allow", ask: "Ask", deny: "Deny" };
export const EFFECT_TONES: Record<ToolRule["effect"], Tone> = { allow: "ok", ask: "warn", deny: "error" };

/** The rules strictest first, each with its place in the policy (which it is saved by). */
export function sortedRules(rules: readonly ToolRule[]): { rule: ToolRule; index: number }[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => STRICTNESS[a.rule.effect] - STRICTNESS[b.rule.effect] || a.index - b.index);
}

/** The tool a rule names: `github · delete_repository`, `deepwiki · any tool`, `Any HTTP tool`. */
export function ruleTool(rule: ToolRule): string {
  const kind = rule.kind === "http" ? "HTTP " : rule.kind === "mcp" ? "MCP " : "";
  if (rule.server) return `${rule.server} · ${rule.tool ?? "any tool"}`;
  if (rule.tool) return kind ? `${rule.tool} (${kind.trim()})` : rule.tool;
  return `Any ${kind}tool`;
}

/** The manifest a rule names, or `Any`. */
export function ruleManifest(rule: ToolRule): string {
  return rule.agent ?? "Any";
}

const json = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/** A rule's `when`, as one line: `amount > 100 · method in POST, DELETE`; empty for none. */
export function whenText(when: ToolRule["when"]): string {
  if (!when) return "";
  return Object.entries(when)
    .map(([path, condition]) => {
      const tests: string[] = [];
      if (condition.equals !== undefined) tests.push(`${path} = ${json(condition.equals)}`);
      if (condition.in !== undefined) tests.push(`${path} in ${condition.in.map(json).join(", ")}`);
      if (condition.gt !== undefined) tests.push(`${path} > ${condition.gt}`);
      if (condition.gte !== undefined) tests.push(`${path} ≥ ${condition.gte}`);
      if (condition.lt !== undefined) tests.push(`${path} < ${condition.lt}`);
      if (condition.lte !== undefined) tests.push(`${path} ≤ ${condition.lte}`);
      if (condition.matches !== undefined) tests.push(`${path} matches /${condition.matches}/`);
      return tests.join(" and ");
    })
    .join(" · ");
}

/** `*` matches any run of characters; nothing else is special. */
export function globMatches(pattern: string, value: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "u").test(value);
}

/**
 * The rules that may decide a call of one tool of an Agent made from `manifest`: an MCP tool
 * (`server` and its own `tool` name), or an HTTP tool (`tool` alone). Strictest first. A rule
 * with `when` may match only some of its calls.
 */
export function rulesFor(
  rules: readonly ToolRule[],
  manifest: string,
  call: { tool?: string; server?: string; kind: "mcp" | "http" },
): ToolRule[] {
  return sortedRules(rules)
    .map(({ rule }) => rule)
    .filter(
      (rule) =>
        (rule.agent === undefined || globMatches(rule.agent, manifest)) &&
        (rule.kind === undefined || rule.kind === call.kind) &&
        (rule.server === undefined || (call.server !== undefined && globMatches(rule.server, call.server))) &&
        (rule.tool === undefined || (call.tool !== undefined && globMatches(rule.tool, call.tool))),
    );
}

/** One rule, as the note beside a tool the rule touches: `Deny: Repositories are deleted by people`. */
export function ruleNote(rule: ToolRule): string {
  const when = whenText(rule.when);
  return [`${EFFECT_LABELS[rule.effect]}${when ? ` when ${when}` : ""}`, rule.reason].filter(Boolean).join(": ");
}

/**
 * A manifest's spec with a note on each HTTP tool and MCP server that tool policy rules may
 * decide calls of: the strictest rule's note (or how many rules), toned by its effect. The rules
 * are edited on the Tenant's page; here they are only read.
 */
export function withPolicyNotes(
  sections: readonly SpecSection[],
  rules: readonly ToolRule[],
  manifest: string,
): SpecSection[] {
  if (rules.length === 0) return [...sections];
  const note = (matched: readonly ToolRule[], name: (rule: ToolRule) => string) => {
    const first = matched[0];
    if (!first) return undefined;
    const text = matched.length === 1 ? name(first) : `${EFFECT_LABELS[first.effect]} · ${matched.length} tool policy rules`;
    return { text, tone: EFFECT_TONES[first.effect] };
  };
  return sections.map((section) => ({
    ...section,
    rows: section.rows.map((row) => {
      let policy: { text: string; tone: Tone } | undefined;
      if (section.id === "tools" && row.value.startsWith("HTTP"))
        policy = note(rulesFor(rules, manifest, { tool: row.label, kind: "http" }), ruleNote);
      else if (section.id === "mcp")
        policy = note(
          sortedRules(rules)
            .map(({ rule }) => rule)
            .filter(
              (rule) =>
                (rule.agent === undefined || globMatches(rule.agent, manifest)) &&
                rule.kind !== "http" &&
                (rule.server === undefined || globMatches(rule.server, row.label)),
            ),
          (rule) => (rule.tool ? ruleNote(rule).replace(/^(\w+)/u, `$1 ${rule.tool}`) : ruleNote(rule)),
        );
      if (!policy) return row;
      return { ...row, note: row.note ? `${policy.text} · ${row.note}` : policy.text, tone: policy.tone };
    }),
  }));
}

// --- Usage and budgets --------------------------------------------------------------------

/** What a budget applies to: `The Tenant`, `Manifest triage`, `Each turn`. */
export function budgetScope(budget: ModelBudget): string {
  return budget.scope === "tenant" ? "The Tenant" : budget.scope === "manifest" ? `Manifest ${budget.id}` : "Each turn";
}

export function budgetPeriod(budget: ModelBudget): string {
  return budget.period === "day" ? "Daily" : budget.period === "month" ? "Monthly" : "—";
}

/** A budget's cap: `$250`, `200 K tokens`, or both. */
export function budgetLimit(budget: ModelBudget): string {
  return [
    budget.limitUsd !== undefined ? formatCost(budget.limitUsd) : undefined,
    budget.limitTokens !== undefined ? `${tokensText(budget.limitTokens)} tokens` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The usage query that totals what a budget counts; undefined for a turn's, checked per turn. */
export function budgetQuery(budget: ModelBudget): { scope: "tenant" | "manifest"; id?: string; period: "day" | "month" } | undefined {
  if (budget.scope === "turn" || !budget.period) return undefined;
  return { scope: budget.scope, ...(budget.id ? { id: budget.id } : {}), period: budget.period };
}

/** How much of a budget its period has used: the larger part of its caps, and as text. */
export function budgetUsed(budget: ModelBudget, totals: UsageTotals | undefined): { share: number; text: string } {
  if (budget.scope === "turn") return { share: 0, text: "Checked per turn" };
  if (!totals) return { share: 0, text: "—" };
  const shares = [
    budget.limitUsd !== undefined ? totals.costUsd / budget.limitUsd : undefined,
    budget.limitTokens !== undefined ? totals.tokens / budget.limitTokens : undefined,
  ].filter((share): share is number => share !== undefined);
  const share = Math.max(0, ...shares);
  const spent =
    budget.limitUsd !== undefined ? formatCost(totals.costUsd) : `${tokensText(totals.tokens)} tokens`;
  return { share, text: `${spent} · ${Math.round(share * 100)}%` };
}

/** Where a budget's key is: one per scope, and per manifest. */
export const budgetKey = (budget: Pick<ModelBudget, "scope" | "id">) => `${budget.scope}:${budget.id ?? "*"}`;
