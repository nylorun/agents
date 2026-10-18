import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Tabs as TabsPrimitive } from "radix-ui";
import type { StudioTenantInfo } from "@/config";
import type { AgentCatalog } from "@/resources/agents";
import { createTenantManagementClient } from "@/proxy-client";
import { messageOf, useRead } from "@/resources/reads";
import { TENANT_TABS, tenantPath, tenantTabOf, type TenantTab } from "@/agent-path";
import { failingChecks, modelText, statusGroups, type TenantStatus } from "@/tenant-spec";
import { fullTime, shortTime } from "@/time-format";
import { ReadState } from "@/components/resource-layout";
import { AgentManifests } from "@/components/agent-manifests";
import { ModelSettings } from "@/components/model-settings";
import { TenantCompute } from "@/components/tenant-compute";
import { TenantPolicy } from "@/components/tenant-policy";
import { TenantLimits } from "@/components/tenant-limits";
import { TenantUsage } from "@/components/tenant-usage";
import {
  ActionMenu,
  EmptyRow,
  GroupRow,
  StatusDot,
  TableFrame,
  TableHeading,
  TableNote,
  TableToolbar,
  cellClass,
  headClass,
  type MenuAction,
} from "@/components/data-table";

const TAB_LABELS: Record<TenantTab, string> = {
  status: "Status",
  manifests: "Manifests",
  models: "Models",
  compute: "Compute",
  policy: "Tool policy",
  limits: "Limits",
  usage: "Usage",
  keys: "Keys",
};

const tabTrigger =
  "shrink-0 border-b-2 border-transparent px-0 pb-3 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground";

/** A tab's content: it fills the page below the tabs and scrolls on its own. */
const tabContent = "flex min-h-0 flex-1 flex-col overflow-auto data-[state=inactive]:hidden";

type ResetScope = "sessions" | "agents" | "all";

const RESETS: Record<ResetScope, { label: string; confirm: string; done: string }> = {
  sessions: {
    label: "Reset sessions…",
    confirm:
      "Reset sessions? Every session is deleted with its record and its artifacts, once the turns in progress end. Agents, manifests and settings stay. This cannot be undone.",
    done: "Every session was deleted.",
  },
  agents: {
    label: "Reset Agents…",
    confirm:
      "Reset Agents? Every Agent is deleted with its vault, disk, memories and triggers, once the turns in progress end. Sessions stay but can take no new turn; manifests and settings stay. This cannot be undone.",
    done: "Every Agent was deleted.",
  },
  all: {
    label: "Reset everything…",
    confirm:
      "Reset everything? Every session, Agent, agent manifest and artifact is deleted, with the model usage and budgets, once the turns in progress end. The Tenant's models, settings, tool policy, limits and keys stay. This cannot be undone.",
    done: "The Tenant was reset: its sessions, Agents, manifests, artifacts, usage and budgets were deleted.",
  },
};

/**
 * The Tenant's page (`/tenant`): what it is and what runs it, then one tab for each part of its
 * configuration, in the order an Agent's turn meets them: its status, the manifests Agents are
 * made from, the models they call, where they run, what their tool calls may do, how far they
 * may go, what it cost, and the keys that reach it. It opens on its status (`?tab=` picks
 * another). The header's ⋯ menu resets it.
 */
export function TenantPage({
  tenant,
  catalog,
  revision = 0,
  onChanged,
}: {
  tenant: StudioTenantInfo;
  catalog: AgentCatalog;
  /** Bumped by the header's Refresh: the page and its open tab read again. */
  revision?: number;
  /** A reset deleted sessions or Agents: the lists read again. */
  onChanged?: () => void;
}) {
  const management = useMemo(() => createTenantManagementClient(tenant.id), [tenant.id]);
  const [query, setQuery] = useSearchParams();
  const tab = tenantTabOf(query.get("tab")) ?? "status";
  const loadStatus = useCallback(() => management.tenant.status(), [management]);
  const status = useRead(loadStatus);
  const loadSandbox = useCallback(() => management.settings.sandbox.get(), [management]);
  const sandbox = useRead(loadSandbox).data;
  const [acting, setActing] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [tabRevision, setTabRevision] = useState(0);
  const seenRevision = useRef(revision);
  const { reload } = status;
  useEffect(() => {
    if (seenRevision.current === revision) return;
    seenRevision.current = revision;
    reload();
    setTabRevision((n) => n + 1);
  }, [revision, reload]);
  function openTab(value: string) {
    const next = new URLSearchParams(query);
    // The manifest open beside the list belongs to the Manifests tab.
    next.delete("selected");
    next.delete("version");
    if (value === "status") next.delete("tab");
    else next.set("tab", value);
    setQuery(next);
  }
  async function reset(scope: ResetScope) {
    if (!window.confirm(RESETS[scope].confirm)) return;
    setActing(true);
    setNotice("");
    setActionError("");
    try {
      await management.tenant.reset({ scope, activeWork: "drain" });
      setNotice(RESETS[scope].done);
      reload();
      setTabRevision((n) => n + 1);
      onChanged?.();
    } catch (cause) {
      setActionError(messageOf(cause));
    } finally {
      setActing(false);
    }
  }
  const s = status.data;
  const model = s ? modelText(s.model) : undefined;
  const actions: MenuAction[] = [
    { label: "Copy Tenant ID", onSelect: () => void navigator.clipboard.writeText(tenant.id) },
    ...(["sessions", "agents", "all"] as const).map((scope, index) => ({
      label: RESETS[scope].label,
      onSelect: () => void reset(scope),
      destructive: true,
      disabled: acting,
      ...(index === 0 ? { separated: true } : {}),
    })),
  ];
  const props = { tenantId: tenant.id };
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 pt-5 pb-4">
        <div className="min-w-0 flex-[1_1_22rem] space-y-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="min-w-0 text-xl leading-tight font-semibold break-all">{s?.tenant.name ?? tenant.name}</h1>
            <span className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium">
              <StatusDot tone="ok">Open</StatusDot>
            </span>
          </div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span className="font-mono text-[13px] text-foreground">{tenant.id}</span>
            {s ? (
              <>
                <Dot />
                {model ? (
                  <span>
                    Runs <span className="text-foreground">{model}</span>
                  </span>
                ) : (
                  <span>No model set</span>
                )}
                <Dot />
                <span>
                  Sandbox {s.sandbox.backend ?? "none"}
                  {sandbox?.isolation ? `, ${sandbox.isolation}` : ""}
                </span>
                <Dot />
                <span>
                  {s.agents.length === 1 ? "1 Agent" : `${s.agents.length} Agents`} ·{" "}
                  {s.counts.sessions === 1 ? "1 session" : `${s.counts.sessions} sessions`}
                </span>
              </>
            ) : null}
          </p>
        </div>
        <ActionMenu label="Tenant actions" actions={actions} bordered />
      </div>
      {actionError ? (
        <p role="alert" className="px-4 pb-3 text-sm break-words text-red-600">
          {actionError}
        </p>
      ) : null}
      {notice || acting ? (
        <p role="status" className="px-4 pb-3 text-sm text-muted-foreground">
          {acting ? "Resetting, once the turns in progress end…" : notice}
        </p>
      ) : null}
      <TabsPrimitive.Root value={tab} onValueChange={openTab} className="flex min-h-0 flex-1 flex-col">
        <TabsPrimitive.List aria-label="Tenant tabs" className="flex shrink-0 gap-6 overflow-x-auto border-y px-4 pt-3">
          {TENANT_TABS.map((key) => (
            <TabsPrimitive.Trigger key={key} value={key} className={tabTrigger}>
              {TAB_LABELS[key]}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>
        <TabsPrimitive.Content key={`status:${tabRevision}`} value="status" className={tabContent}>
          <ReadState {...status} pending={status.pending && !s} onRetry={status.reload} />
          {s ? <StatusTab status={s} /> : null}
        </TabsPrimitive.Content>
        <TabsPrimitive.Content key={`manifests:${tabRevision}`} value="manifests" className="flex min-h-0 flex-1 data-[state=inactive]:hidden">
          <AgentManifests tenantId={tenant.id} catalog={catalog} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content key={`models:${tabRevision}`} value="models" className={tabContent}>
          <ModelSettings {...props} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content key={`compute:${tabRevision}`} value="compute" className={tabContent}>
          <TenantCompute {...props} {...(s ? { agents: s.agents.length } : {})} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content key={`policy:${tabRevision}`} value="policy" className={tabContent}>
          <TenantPolicy {...props} manifests={catalog.manifests.map((m) => m.name)} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content key={`limits:${tabRevision}`} value="limits" className={tabContent}>
          <TenantLimits {...props} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content key={`usage:${tabRevision}`} value="usage" className={tabContent}>
          <TenantUsage {...props} manifests={catalog.manifests.map((m) => m.name)} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content key={`keys:${tabRevision}`} value="keys" className={tabContent}>
          <KeysTab {...props} />
        </TabsPrimitive.Content>
      </TabsPrimitive.Root>
    </section>
  );
}

function Dot() {
  return (
    <span aria-hidden className="text-muted-foreground/60">
      ·
    </span>
  );
}

/** Whether the Tenant is healthy: its checks, what runs it, and what it holds. */
function StatusTab({ status }: { status: TenantStatus }) {
  const failing = failingChecks(status);
  const [readAt] = useState(() => new Date().toISOString());
  const groups = statusGroups(status);
  return (
    <div>
      <TableToolbar>
        <span className="text-sm">
          {failing === 0 ? (
            <StatusDot tone="ok">All {Object.keys(status.checks).length} checks pass</StatusDot>
          ) : (
            <StatusDot tone="error">{failing === 1 ? "1 check fails" : `${failing} checks fail`}</StatusDot>
          )}
        </span>
        <span className="ml-auto text-sm text-muted-foreground" title={fullTime(readAt)}>
          Read {shortTime(readAt)}
        </span>
      </TableToolbar>
      <TableFrame minWidth={640}>
        <thead>
          <tr>
            <th className={`${headClass} w-48`}>Component</th>
            <th className={`${headClass} w-40`}>State</th>
            <th className={headClass}>Detail</th>
            <th className={`${headClass} w-36`}>Configured on</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <Fragment key={group.title}>
              <GroupRow columns={4}>{group.title}</GroupRow>
              {group.rows.map((row) => (
                <tr key={row.label}>
                  <td className={cellClass}>{row.label}</td>
                  <td className={cellClass}>
                    <StatusDot tone={row.tone}>{row.state}</StatusDot>
                  </td>
                  <td className={`${cellClass} text-muted-foreground`} title={row.detail}>
                    {row.detail || "—"}
                  </td>
                  <td className={`${cellClass} text-xs`}>
                    {row.tab ? (
                      <Link to={tenantPath(row.tab)} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                        {TAB_LABELS[row.tab]}
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </TableFrame>
    </div>
  );
}

const SIGNING_STATES: Record<string, { label: string; tone: "ok" | "busy" | "idle" | "error" }> = {
  current: { label: "Current", tone: "ok" },
  standby: { label: "Standby", tone: "busy" },
  previous: { label: "Previous", tone: "idle" },
  revoked: { label: "Revoked", tone: "error" },
};

const time = (value: string | null) =>
  value ? (
    <time dateTime={value} title={fullTime(value)}>
      {shortTime(value)}
    </time>
  ) : (
    "—"
  );

/**
 * The keys that reach the Tenant, read only: Studio cannot lock out an application or end its
 * tokens. They are made, rotated and revoked with the CLI.
 */
function KeysTab({ tenantId }: { tenantId: string }) {
  const management = useMemo(() => createTenantManagementClient(tenantId), [tenantId]);
  const loadKeys = useCallback(() => management.keys.list(), [management]);
  const keys = useRead(loadKeys);
  const loadSigning = useCallback(() => management.signingKeys.list(), [management]);
  const signing = useRead(loadSigning);
  return (
    <div>
      <TableHeading title="Application keys" hint="What an application calls the Runtime with" />
      <ReadState {...keys} pending={keys.pending && !keys.data} onRetry={keys.reload} />
      {keys.data ? (
        <TableFrame minWidth={560}>
          <thead>
            <tr>
              <th className={headClass}>Key</th>
              <th className={`${headClass} w-48`}>Role</th>
              <th className={`${headClass} w-48`}>Created</th>
            </tr>
          </thead>
          <tbody>
            {keys.data.length === 0 ? <EmptyRow columns={3}>No application keys yet.</EmptyRow> : null}
            {keys.data.map((key) => (
              <tr key={key.id}>
                <td className={`${cellClass} font-mono text-[13px]`} title={key.id}>
                  {key.id}
                </td>
                <td className={`${cellClass} text-muted-foreground`}>{key.role}</td>
                <td className={`${cellClass} text-muted-foreground`}>{time(key.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      ) : null}
      <TableHeading title="Signing keys" hint="Sign the access tokens the Runtime issues; public at /v1/access/jwks" />
      <ReadState {...signing} pending={signing.pending && !signing.data} onRetry={signing.reload} />
      {signing.data ? (
        <TableFrame minWidth={720}>
          <thead>
            <tr>
              <th className={headClass}>Key</th>
              <th className={`${headClass} w-32`}>State</th>
              <th className={`${headClass} w-28`}>Algorithm</th>
              <th className={`${headClass} w-44`}>Active since</th>
              <th className={`${headClass} w-44`}>Retired</th>
            </tr>
          </thead>
          <tbody>
            {signing.data.length === 0 ? <EmptyRow columns={5}>No signing keys yet.</EmptyRow> : null}
            {signing.data.map((key) => {
              const state = SIGNING_STATES[key.state] ?? { label: key.state, tone: "idle" as const };
              return (
                <tr key={key.id}>
                  <td className={`${cellClass} font-mono text-[13px]`} title={key.id}>
                    {key.id}
                  </td>
                  <td className={cellClass}>
                    <StatusDot tone={state.tone}>{state.label}</StatusDot>
                  </td>
                  <td className={`${cellClass} text-muted-foreground`}>{key.alg}</td>
                  <td className={`${cellClass} text-muted-foreground`}>{time(key.activatedAt)}</td>
                  <td className={`${cellClass} text-muted-foreground`}>{time(key.retiredAt ?? key.revokedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </TableFrame>
      ) : null}
      <TableNote>
        Keys are made, rotated and revoked with the CLI (<span className="font-mono">nylorun tenant keys</span>,{" "}
        <span className="font-mono">nylorun tenant signing-keys</span>), so Studio cannot lock out an application or
        end its tokens. Management keys are managed there too.
      </TableNote>
    </div>
  );
}
