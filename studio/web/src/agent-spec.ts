/**
 * What an Agent's page shows of the manifest version it is an instance of, and of its vault,
 * as plain rows: the Manifest tab's sections (the harness section, then the runtime section,
 * each item one line with what it is now), the Vault's slots (what uses each, where it may go,
 * and whether the vault holds a value), and a trigger's schedule in words. No React here, so
 * `scripts/agent-spec.test.mjs` runs it without a browser.
 */
import type { AgentSecretView, AgentView } from "@nylorun/agents";
import type { AgentTab } from "@/agent-path";
import { manifestView } from "./manifest/model.ts";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export type Tone = "ok" | "warn" | "error" | "busy" | "idle";

export type SpecRow = {
  /** Unique within the page: the panel opens on it. */
  id: string;
  label: string;
  /** A name the manifest gives (a tool, a slot, a trigger): set in a monospace face. */
  mono?: boolean;
  value: string;
  /** What it is now, or what makes it fixed: quiet, at the end of the row. */
  note?: string;
  tone?: Tone;
  /** The part of the manifest it comes from, as the panel shows it. */
  json: unknown;
  /** The tab that holds it, when one does: the panel links there. */
  tab?: AgentTab;
};

export type SpecSection = {
  id: string;
  group: "harness" | "runtime";
  title: string;
  hint: string;
  rows: SpecRow[];
};

const KIND_LABELS: Record<string, string> = {
  pod: "Pod, with its own volume",
  virtual: "Virtual workspace in the harness",
  none: "None: a vault with no compute",
};

const SLOT_TYPES: Record<string, string> = {
  bearer: "Bearer token",
  headers: "Headers",
  environment_secret: "Sandbox secret",
  environment_variable: "Variable",
};

/** A slot type in words. */
export function slotTypeLabel(type: string): string {
  return SLOT_TYPES[type] ?? type;
}

/** What in the harness section uses vault slot `name`: its tools, MCP servers and skills. */
export function slotUses(harness: unknown, name: string, url?: string): string[] {
  const root = isRecord(harness) ? harness : {};
  const uses: string[] = [];
  for (const tool of Array.isArray(root.tools) ? root.tools : [])
    if (isRecord(tool) && tool.credential === name) uses.push(`Tool ${String(tool.name)}`);
  if (isRecord(root.mcpServers))
    for (const [server, value] of Object.entries(root.mcpServers)) {
      if (!isRecord(value)) continue;
      // A server that names no slot matches the vault by its URL.
      if (value.credential === name || (value.credential === undefined && url !== undefined && value.url === url))
        uses.push(`MCP server ${server}`);
    }
  if (isRecord(root.skills))
    for (const [skill, value] of Object.entries(root.skills))
      if (isRecord(value) && strings(value.secrets).includes(name)) uses.push(`Skill ${skill}`);
  return uses;
}

export type VaultRow = {
  name: string;
  type: string;
  typeLabel: string;
  /** Declared by the manifest version it runs: a value is all it takes. */
  declared: boolean;
  required: boolean;
  /** The vault holds a value for it. */
  set: boolean;
  uses: string[];
  /** Where its value may go, in words. */
  reach: string;
  description?: string;
  /** How a sandbox secret is sent: `Header: format`. */
  sentAs?: string;
  url?: string;
  /** A `headers` credential's header names (lower case). */
  headerNames: string[];
  rotatedAt?: string;
};

/**
 * The Vault's rows: each slot the manifest version declares, with its binding and whether the
 * vault holds a value; then any secret the vault holds that no slot declares (an Agent made
 * before its manifest declared slots), which can only be deleted.
 */
export function vaultRows(
  agent: Pick<AgentView, "slots" | "runtime">,
  secrets: readonly AgentSecretView[],
  harness?: unknown,
): VaultRow[] {
  const declared = isRecord(agent.runtime.secrets) ? agent.runtime.secrets : {};
  const held = new Map(secrets.map((secret) => [secret.name, secret]));
  const rows: VaultRow[] = agent.slots.map((slot) => {
    const binding = isRecord(declared[slot.name]) ? (declared[slot.name] as Json) : {};
    const secret = held.get(slot.name);
    const url = typeof binding.url === "string" ? binding.url : secret?.binding.url;
    const hosts = strings(binding.allowedHosts).length ? strings(binding.allowedHosts) : (secret?.binding.allowedHosts ?? []);
    const inject = isRecord(binding.inject) ? binding.inject : secret?.binding.inject;
    return {
      name: slot.name,
      type: slot.type,
      typeLabel: slotTypeLabel(slot.type),
      declared: true,
      required: slot.required,
      set: slot.set,
      uses: slotUses(harness, slot.name, url),
      reach: reachOf(slot.type, slot.name, url, hosts),
      ...(typeof binding.description === "string" ? { description: binding.description } : {}),
      ...(inject && typeof inject.header === "string" && typeof inject.format === "string"
        ? { sentAs: `${inject.header}: ${inject.format}` }
        : {}),
      ...(url ? { url } : {}),
      headerNames: secret?.headerNames ?? [],
      ...(secret?.rotatedAt ? { rotatedAt: secret.rotatedAt } : secret ? { rotatedAt: secret.createdAt } : {}),
    };
  });
  for (const secret of secrets)
    if (!agent.slots.some((slot) => slot.name === secret.name))
      rows.push({
        name: secret.name,
        type: secret.type,
        typeLabel: slotTypeLabel(secret.type),
        declared: false,
        required: false,
        set: true,
        uses: slotUses(harness, secret.name, secret.binding.url),
        reach: reachOf(secret.type, secret.name, secret.binding.url, secret.binding.allowedHosts ?? []),
        ...(secret.binding.url ? { url: secret.binding.url } : {}),
        headerNames: secret.headerNames ?? [],
        rotatedAt: secret.rotatedAt ?? secret.createdAt,
      });
  return rows;
}

function reachOf(type: string, name: string, url: string | undefined, hosts: readonly string[]): string {
  if (type === "environment_variable") return `The sandbox, as $${name}`;
  if (type === "environment_secret")
    return hosts.length ? `Only ${hosts.join(", ")}` : "Requests from the sandbox";
  return url ?? "Its server";
}

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/** A five-field cron in words when it is a plain daily or weekly time; else the cron itself. */
export function scheduleText(cron: string, timezone?: string): string {
  const zone = timezone ?? "UTC";
  const [minute, hour, dom, month, dow] = cron.trim().split(/\s+/u);
  const time =
    minute !== undefined && hour !== undefined && /^\d{1,2}$/u.test(minute) && /^\d{1,2}$/u.test(hour)
      ? `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`
      : undefined;
  if (time && dom === "*" && month === "*") {
    if (dow === "*") return `Every day at ${time}, ${zone}`;
    if (dow === "1-5") return `Weekdays at ${time}, ${zone}`;
    if (dow !== undefined && /^[0-7]$/u.test(dow)) return `${DAYS[Number(dow) % 7]} at ${time}, ${zone}`;
  }
  return `${cron} (${zone})`;
}

/** When a trigger fires, in words. */
export function triggerWhen(trigger: { kind: string; schedule?: string; timezone?: string; at?: string }): string {
  if (trigger.kind === "schedule" && trigger.schedule) return scheduleText(trigger.schedule, trigger.timezone);
  if (trigger.kind === "at" && trigger.at) return `Once, at ${trigger.at}`;
  if (trigger.kind === "webhook") return "On a webhook delivery";
  if (trigger.kind === "wake") return "When the agent books its next turn";
  return trigger.kind;
}

/** Where a trigger's runs go. */
export function triggerSession(session: string): string {
  return session === "new" ? "A new session per run" : `Session ${session}`;
}

const sizeText = (bytes: number) =>
  bytes >= 1024 ** 3 && bytes % 1024 ** 3 === 0
    ? `${bytes / 1024 ** 3} GiB`
    : bytes >= 1024 ** 2
      ? `${Math.round(bytes / 1024 ** 2)} MiB`
      : `${Math.round(bytes / 1024)} KiB`;

/**
 * The Manifest tab: the harness section (instructions, tools, skills, MCP servers, memory),
 * then the runtime section (compute, lifecycle, network, setup, vault slots, triggers, limits),
 * a section only when it holds something. `manifest` is the version's whole document; without
 * it (not read yet, or unreadable) the runtime section comes from the Agent's view alone.
 */
export function manifestSections(agent: AgentView, manifest?: unknown): SpecSection[] {
  const doc = isRecord(manifest) ? manifest : {};
  const harness = isRecord(doc.harness) ? doc.harness : {};
  const runtimeDoc = isRecord(doc.runtime) ? doc.runtime : {};
  const view = manifestView(harness);
  const sections: SpecSection[] = [];
  const add = (group: SpecSection["group"], id: string, title: string, hint: string, rows: SpecRow[]) => {
    if (rows.length) sections.push({ id, group, title, hint, rows });
  };
  const tools = Array.isArray(harness.tools) ? harness.tools.filter(isRecord) : [];

  add(
    "harness",
    "instructions",
    "Instructions",
    "The agent's own, in order",
    view.instructions.map((text, index) => ({
      id: `instructions:${index}`,
      label: String(index + 1),
      value: text,
      json: text,
    })),
  );
  add(
    "harness",
    "tools",
    "Tools",
    "The Runtime makes an HTTP tool's request",
    view.tools.map((tool) => {
      const raw = tools.find((item) => item.name === tool.name) ?? {};
      return {
        id: `tool:${tool.name}`,
        label: tool.name,
        mono: true,
        value: tool.http
          ? `HTTP · ${tool.http.method} ${tool.http.url}`
          : tool.kind === "subagent"
            ? `Agent${tool.description ? ` · ${tool.description}` : ""}`
            : tool.kind === "flow-subagent"
              ? `Flow agent${tool.description ? ` · ${tool.description}` : ""}`
              : `Code${tool.description ? ` · ${tool.description}` : ""}`,
        ...(typeof raw.credential === "string" ? { note: `uses ${raw.credential}`, tab: "vault" as const } : {}),
        ...(tool.approval ? { note: "each call waits for approval" } : {}),
        json: raw,
      };
    }),
  );
  const skills = isRecord(harness.skills) ? harness.skills : {};
  add(
    "harness",
    "skills",
    "Skills",
    "Loaded on demand",
    view.skills.map((skill) => {
      const reads = strings((skills[skill.name] as Json | undefined)?.secrets);
      return {
        id: `skill:${skill.name}`,
        label: skill.name,
        mono: true,
        value: skill.description ?? skill.files.join(", "),
        ...(reads.length ? { note: `reads ${reads.join(", ")}`, tab: "vault" as const } : {}),
        json: skills[skill.name] ?? skill,
      };
    }),
  );
  const servers = isRecord(harness.mcpServers) ? harness.mcpServers : {};
  add(
    "harness",
    "mcp",
    "MCP servers",
    "Their tools are discovered on the first turn",
    view.mcpServers.map((server) => {
      const raw = (servers[server.name] as Json | undefined) ?? {};
      return {
        id: `mcp:${server.name}`,
        label: server.name,
        mono: true,
        value: server.url ?? "—",
        ...(typeof raw.credential === "string" ? { note: `uses ${raw.credential}`, tab: "vault" as const } : {}),
        json: raw,
      };
    }),
  );
  if (isRecord(harness.memory)) {
    const memory = harness.memory;
    add("harness", "memory", "Memory", "Kept across every session", [
      {
        id: "memory",
        label: "Access",
        value: memory.access === "read_only" ? "Read only" : "Read and write",
        ...(typeof memory.instructions === "string" ? { note: memory.instructions } : {}),
        tab: "memory",
        json: memory,
      },
    ]);
  }

  const runtime = agent.runtime;
  const pod = agent.kind === "pod";
  add("runtime", "compute", "Compute", "Where its turns run", [
    {
      id: "compute:kind",
      label: "Kind",
      value: KIND_LABELS[agent.kind] ?? agent.kind,
      note: agent.kind === "none" ? "fixed" : `fixed · ${agent.compute.state}`,
      tone: agent.compute.state === "running" ? "busy" : "idle",
      json: { kind: agent.kind },
    },
    ...(pod
      ? [
          {
            id: "compute:image",
            label: "Image",
            value: runtime.image ?? "The Tenant's",
            ...(agent.compute.pod?.imageDigest ? { note: agent.compute.pod.imageDigest.slice(0, 19) } : {}),
            json: { image: runtime.image },
          },
        ]
      : []),
    ...(agent.kind === "none"
      ? []
      : [
          {
            id: "compute:resources",
            label: "Resources",
            value: runtime.resources ? `${runtime.resources.cpus} CPU · ${runtime.resources.memory}` : "The Tenant's",
            json: { resources: runtime.resources },
          },
        ]),
    ...(pod
      ? [{ id: "compute:storage", label: "Storage", value: runtime.storage ?? "The Tenant's", note: "fixed", json: { storage: runtime.storage } }]
      : []),
  ]);
  add("runtime", "lifecycle", "Lifecycle", "When it stops and ends", [
    {
      id: "lifecycle:idle",
      label: "Idle",
      value: runtime.lifecycle.idle ? `Stops after ${runtime.lifecycle.idle} without a turn; its files stay` : "The Tenant's",
      json: { idle: runtime.lifecycle.idle },
    },
    {
      id: "lifecycle:delete",
      label: "Delete after",
      value: runtime.lifecycle.deleteAfter ?? "Never",
      json: { deleteAfter: runtime.lifecycle.deleteAfter ?? null },
    },
  ]);
  if (agent.kind !== "none")
    add("runtime", "network", "Network", "Hosts the sandbox may reach", [
      {
        id: "network",
        label: "Allowed hosts",
        value: runtime.network?.allowedHosts.length ? runtime.network.allowedHosts.join(", ") : "None",
        tab: "activity",
        json: { network: runtime.network ?? null },
      },
    ]);
  const files = runtime.files ?? [];
  const setup = runtime.setup ?? [];
  add("runtime", "setup", "Setup", "Runs when the disk is made or reset", [
    ...files.map((file, index) => ({
      id: `setup:file:${index}`,
      label: `${index + 1}. Copy`,
      value:
        "files" in file
          ? `${Object.keys(file.files).sort().join(", ")} → ${file.path}`
          : `${file.artifactId} v${file.version} → ${file.path}`,
      json: file,
    })),
    ...setup.map((command, index) => ({
      id: `setup:command:${index}`,
      label: `${files.length + index + 1}. Run`,
      mono: false,
      value: command.command,
      note: `in ${command.cwd ?? "/workspace"} · timeout ${command.timeout ?? "10m"}`,
      json: command,
    })),
  ]);
  const declared = isRecord(runtime.secrets) ? runtime.secrets : {};
  add(
    "runtime",
    "slots",
    "Vault slots",
    "Credentials its tools need",
    agent.slots.map((slot) => ({
      id: `slot:${slot.name}`,
      label: slot.name,
      mono: true,
      value: slotTypeLabel(slot.type) + (slot.required ? " · required" : ""),
      note: slot.set ? "Set" : "Not set",
      tone: slot.set ? ("ok" as const) : ("warn" as const),
      tab: "vault" as const,
      json: { [slot.name]: declared[slot.name] ?? { type: slot.type } },
    })),
  );
  const triggers = isRecord(runtimeDoc.triggers) ? runtimeDoc.triggers : {};
  add("runtime", "triggers", "Triggers", "What starts its turns with no client connected", [
    ...Object.entries(triggers)
      .filter((entry): entry is [string, Json] => isRecord(entry[1]))
      .map(([id, trigger]) => ({
        id: `trigger:${id}`,
        label: id,
        mono: true,
        value: `${triggerWhen({
          kind: trigger.schedule ? "schedule" : trigger.at ? "at" : "webhook",
          ...(typeof trigger.schedule === "string" ? { schedule: trigger.schedule } : {}),
          ...(typeof trigger.timezone === "string" ? { timezone: trigger.timezone } : {}),
          ...(typeof trigger.at === "string" ? { at: trigger.at } : {}),
        })} → ${triggerSession(String(trigger.session ?? "new"))}`,
        tab: "triggers" as const,
        json: trigger,
      })),
    ...(runtimeDoc.selfWake === true
      ? [{ id: "trigger:wake", label: "Self-wake", value: "The agent may book its own next turn", note: "on", tab: "triggers" as const, json: { selfWake: true } }]
      : []),
  ]);
  add("runtime", "limits", "Limits", "The most it may hold", [
    {
      id: "limits:artifacts",
      label: "Artifacts",
      value: `${sizeText(agent.limits.artifacts.fileBytes)} a file · ${sizeText(agent.limits.artifacts.totalBytes)} in all`,
      tab: "artifacts",
      json: agent.limits.artifacts,
    },
    {
      id: "limits:skills",
      label: "Skills",
      value: `${sizeText(agent.limits.skills.totalBytes)} in all`,
      json: agent.limits.skills,
    },
    ...(agent.kind === "none"
      ? []
      : [
          {
            id: "limits:disk",
            label: "Disk version",
            value: `${sizeText(agent.limits.disk.versionBytes)} · ${agent.limits.disk.versionEntries.toLocaleString("en-US")} entries`,
            tab: "disk" as const,
            json: agent.limits.disk,
          },
        ]),
  ]);
  return sections;
}
