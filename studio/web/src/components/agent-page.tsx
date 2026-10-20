import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { AgentView } from "@nylorun/agents";
import { Tabs as TabsPrimitive } from "radix-ui";
import { FileJson, Plus } from "lucide-react";
import { createTenantClient } from "@/proxy-client";
import { messageOf, useRead } from "@/resources/reads";
import type { SessionSummary } from "@/studio-types";
import { agentPath, agentTabOf, manifestPath, type AgentTab } from "@/agent-path";
import { editRequest, labelsText } from "@/agent-form";
import { manifestNameOf } from "@/agent-list";
import { agentUnavailable } from "@/credential-coverage";
import { STUDIO_OWNER } from "@/session-open";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ReadState } from "@/components/resource-layout";
import { AgentState, Field, attentionOf, otherSessionsNote, pendingLabel } from "@/components/agents";
import { ForkSheet } from "@/components/agent-fork";
import { ActionMenu, type MenuAction } from "@/components/data-table";
import { useStartSession } from "@/components/new-session";
import { AgentSessionsTab } from "@/components/agent-sessions-tab";
import { AgentTriggers } from "@/components/agent-triggers";
import { AgentArtifacts } from "@/components/agent-artifacts";
import { AgentMemory } from "@/components/agent-memory";
import { AgentDisk } from "@/components/agent-disk";
import { AgentActivity } from "@/components/agent-activity";
import { AgentVault } from "@/components/agent-vault";
import { AgentManifestTab, type ManifestMove } from "@/components/agent-manifest-tab";
import { useToolRules } from "@/resources/tool-policy";

/** A titled block of a page. */
export function Section({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

const TAB_LABELS: Record<AgentTab, string> = {
  sessions: "Sessions",
  triggers: "Triggers",
  artifacts: "Artifacts",
  memory: "Memory",
  disk: "Disk",
  activity: "Activity",
  vault: "Vault",
  manifest: "Manifest",
};

const tabTrigger =
  "shrink-0 border-b-2 border-transparent px-0 pb-3 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground";

/**
 * One Agent's page (`/agents/<id>`): an instance of one agent manifest version, with what it
 * holds. Its header says what it is an instance of; one tab for each thing it does, keeps or did
 * (sessions, triggers, artifacts, memory, disk, activity), then how it is set up (its vault, and
 * the manifest version as a readable spec). Every tab is one table; a row opens a panel on the
 * right. It opens on its sessions (`?tab=` picks another).
 */
export function AgentPage({
  tenantId,
  id,
  sessions,
  revision = 0,
  onChanged,
}: {
  tenantId: string;
  id: string;
  /** The Tenant's sessions as Studio read them, for their last activity. */
  sessions: readonly SessionSummary[];
  /** Bumped by the header's Refresh: the page and its open tab read again. */
  revision?: number;
  /** The Agent was made, forked, changed or deleted: the lists read again. */
  onChanged?: () => void;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const navigate = useNavigate();
  const startSession = useStartSession();
  const [query, setQuery] = useSearchParams();
  const load = useCallback((signal: AbortSignal) => sdk.agents.get(id, { signal }), [sdk, id]);
  const read = useRead(load);
  const s = read.data;
  const name = s ? manifestNameOf(s) : undefined;
  const version = s?.resolvedVersion;
  // The version it runs, whole: the Manifest tab reads it as a spec, the Vault its slots' uses.
  const loadManifest = useCallback(
    async (signal: AbortSignal) =>
      name === undefined || version === undefined
        ? undefined
        : await sdk.agentManifests.get(name, version, { signal }).catch(() => undefined),
    [sdk, name, version],
  );
  const manifest = useRead(loadManifest).data;
  // The latest version of its manifest: a pinned Agent moves to it (track T3).
  const loadLatest = useCallback(
    async (signal: AbortSignal) =>
      name === undefined
        ? undefined
        : (await sdk.agentManifests.get(name, undefined, { signal }).catch(() => undefined))?.version,
    [sdk, name],
  );
  const latestRead = useRead(loadLatest);
  const latest = latestRead.data;
  const rules = useToolRules(tenantId);
  const [forking, setForking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  // The header's Refresh reads the Agent again and remounts the open tab, which reads its own.
  const [tabRevision, setTabRevision] = useState(0);
  const seenRevision = useRef(revision);
  const { reload } = read;
  const reloadLatest = latestRead.reload;
  useEffect(() => {
    if (seenRevision.current === revision) return;
    seenRevision.current = revision;
    reload();
    reloadLatest();
    setTabRevision((n) => n + 1);
  }, [revision, reload, reloadLatest]);
  const unavailable = s ? agentUnavailable(s, STUDIO_OWNER) : undefined;
  const asked = agentTabOf(query.get("tab"));
  // An Agent of kind none has no disk: its Disk tab opens its sessions.
  const tab: AgentTab = asked === undefined || (asked === "disk" && s?.kind === "none") ? "sessions" : asked;
  function openTab(value: string) {
    const next = new URLSearchParams(query);
    if (value === "sessions") next.delete("tab");
    else next.set("tab", value);
    setQuery(next);
  }
  const changed = useCallback(() => {
    reload();
    onChanged?.();
  }, [reload, onChanged]);

  /** Moves it within its manifest (track T3): `name` tracks, `name@n` pins; or applies a pending version. */
  async function move(what: ManifestMove): Promise<void> {
    if (!s || name === undefined) return;
    setActing(true);
    setActionError("");
    setNotice("");
    try {
      const agent =
        what === "restart" || what === "retry"
          ? await sdk.agents.restart(id, what === "retry" ? { retry: true } : {})
          : await sdk.agents.put(id, {
              manifest: what === "track" ? name : `${name}@${what === "move" ? latest : s.resolvedVersion}`,
            });
      const pending = agent.targetVersion
        ? agent.waitingFor === "secrets"
          ? `; v${agent.targetVersion} waits for its required secrets (Vault tab)`
          : `; v${agent.targetVersion} applies at its pod's next start`
        : "";
      setNotice(`${id} runs ${name}@${agent.resolvedVersion}${agent.tracking === "tracking" ? ", tracking the manifest" : ", pinned"}${pending}.`);
      changed();
    } catch (cause) {
      setActionError(messageOf(cause));
    } finally {
      setActing(false);
    }
  }
  async function act(what: "stop" | "reset" | "delete"): Promise<void> {
    if (!s) return;
    const others = otherSessionsNote(s);
    if (
      what === "reset" &&
      !window.confirm(
        `Reset ${id}? Its pod starts again on a new, empty volume, with its setup and input files; the old volume is deleted.${others}`,
      )
    )
      return;
    if (
      what === "delete" &&
      !window.confirm(
        `Delete ${id}, its vault, its disk and its disk versions? Its sessions can take no new turn.${others} This cannot be undone.`,
      )
    )
      return;
    setActing(true);
    setActionError("");
    setNotice("");
    try {
      if (what === "delete") {
        await sdk.agents.delete(id);
        onChanged?.();
        navigate("/agents");
        return;
      }
      await (what === "stop" ? sdk.agents.stop(id) : sdk.agents.reset(id));
      setNotice(what === "stop" ? `Stopped ${id}.` : `Reset ${id}.`);
      changed();
    } catch (cause) {
      setActionError(messageOf(cause));
    } finally {
      setActing(false);
    }
  }

  const actions: MenuAction[] = s
    ? [
        { label: "Edit labels and owner…", onSelect: () => setEditing(true), disabled: acting },
        ...(s.kind === "pod"
          ? [
              { label: "Stop compute", onSelect: () => void act("stop"), disabled: acting },
              { label: "Reset disk…", onSelect: () => void act("reset"), disabled: acting },
            ]
          : []),
        { label: "Fork into a new Agent…", onSelect: () => setForking(true), disabled: acting },
        { label: "Delete Agent…", onSelect: () => void act("delete"), destructive: true, separated: true, disabled: acting },
      ]
    : [];
  const tabs = s ? (Object.keys(TAB_LABELS) as AgentTab[]).filter((key) => key !== "disk" || s.kind !== "none") : [];
  const tabProps = s ? { tenantId, agent: s, onChanged: changed } : undefined;

  return (
    <section className="min-h-0 flex-1 overflow-auto">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 pt-5 pb-4">
        <div className="min-w-0 flex-[1_1_22rem] space-y-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="min-w-0 font-mono text-xl leading-tight font-semibold break-all">{id}</h1>
            {s ? (
              <span className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium">
                <AgentState state={s.state} title={attentionOf(s)} />
              </span>
            ) : null}
          </div>
          {s && name !== undefined ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span>Instance of</span>
              <Link
                to={manifestPath(name, s.resolvedVersion)}
                className="inline-flex items-center gap-1.5 text-foreground underline underline-offset-[3px]"
              >
                <FileJson className="size-3.5" />
                <span className="font-mono text-[13px]">
                  {name} v{s.resolvedVersion}
                </span>
              </Link>
              <Dot />
              <span>
                {s.tracking === "tracking" ? "tracking latest" : "pinned"}
                {pendingLabel(s)}
              </span>
              <Dot />
              <span>{s.kind}</span>
              {s.owner ? (
                <>
                  <Dot />
                  <span>owner {s.owner}</span>
                </>
              ) : null}
              {Object.entries(s.labels).map(([key, value]) => (
                <span key={key} className="rounded-full border px-2 font-mono text-xs text-foreground">
                  {key}={value}
                </span>
              ))}
            </p>
          ) : null}
        </div>
        {s ? (
          <div className="flex items-center gap-2">
            <Button disabled={unavailable !== undefined} title={unavailable} onClick={() => startSession(s)}>
              <Plus />
              New session
            </Button>
            <ActionMenu label="More actions" actions={actions} bordered />
          </div>
        ) : null}
      </div>
      {actionError ? (
        <p role="alert" className="px-4 pb-3 text-sm break-words text-destructive">
          {actionError}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="px-4 pb-3 text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      <ReadState {...read} onRetry={read.reload} />
      {s && tabProps ? (
        <TabsPrimitive.Root value={tab} onValueChange={openTab}>
          <TabsPrimitive.List
            aria-label="Agent tabs"
            className="flex gap-6 overflow-x-auto border-y px-4 pt-3"
          >
            {tabs.map((key) => (
              <TabsPrimitive.Trigger
                key={key}
                value={key}
                className={tabTrigger + (key === "vault" ? " ml-auto" : "")}
              >
                {TAB_LABELS[key]}
              </TabsPrimitive.Trigger>
            ))}
          </TabsPrimitive.List>
          <TabsPrimitive.Content key={`sessions:${tabRevision}`} value="sessions">
            <AgentSessionsTab agent={s} known={sessions} />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content key={`triggers:${tabRevision}`} value="triggers">
            <AgentTriggers {...tabProps} manifest={manifest?.manifest} />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content key={`artifacts:${tabRevision}`} value="artifacts">
            <AgentArtifacts tenantId={tenantId} agent={s} />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content key={`memory:${tabRevision}`} value="memory">
            <AgentMemory tenantId={tenantId} agent={s} />
          </TabsPrimitive.Content>
          {s.kind === "none" ? null : (
            <TabsPrimitive.Content key={`disk:${tabRevision}`} value="disk">
              <AgentDisk {...tabProps} {...(latest === undefined ? {} : { latest })} />
            </TabsPrimitive.Content>
          )}
          <TabsPrimitive.Content key={`activity:${tabRevision}`} value="activity">
            <AgentActivity tenantId={tenantId} agent={s} />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content key={`vault:${tabRevision}`} value="vault">
            <AgentVault {...tabProps} manifest={manifest?.manifest} />
          </TabsPrimitive.Content>
          <TabsPrimitive.Content key={`manifest:${tabRevision}`} value="manifest">
            <AgentManifestTab
              agent={s}
              manifest={manifest?.manifest}
              {...(latest === undefined ? {} : { latest })}
              acting={acting}
              onMove={(what) => void move(what)}
              rules={rules}
            />
          </TabsPrimitive.Content>
        </TabsPrimitive.Root>
      ) : null}
      {forking && s ? (
        <ForkSheet
          tenantId={tenantId}
          source={s}
          {...(latest === undefined ? {} : { latest })}
          onClose={() => setForking(false)}
          onForked={(agent) => {
            setForking(false);
            onChanged?.();
            navigate(agentPath(agent.id));
          }}
        />
      ) : null}
      {editing && s ? (
        <EditAgentSheet
          tenantId={tenantId}
          agent={s}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            changed();
          }}
        />
      ) : null}
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

/** Changes an Agent's labels and owner guard (`PUT /v1/agents/{id}`); what it runs stays. */
function EditAgentSheet({
  tenantId,
  agent,
  onClose,
  onSaved,
}: {
  tenantId: string;
  agent: AgentView;
  onClose: () => void;
  onSaved: (agent: AgentView) => void;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const [labels, setLabels] = useState(() => labelsText(agent.labels));
  const [owner, setOwner] = useState(agent.owner ?? "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      onSaved(await sdk.agents.put(agent.id, editRequest(agent, { labels, owner })));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Edit {agent.id}</SheetTitle>
          <SheetDescription>
            Its labels and owner guard. To run another version of its manifest, move it from its
            Manifest tab (Pin, Track, Move); to change its kind, harness or storage, fork it.
          </SheetDescription>
        </SheetHeader>
        <form className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4" onSubmit={(event) => void submit(event)}>
          <Field label="Labels" hint="One key=value per line.">
            <textarea
              aria-label="Labels"
              className="min-h-16 rounded-md border bg-background p-2 font-mono text-sm"
              value={labels}
              onChange={(event) => setLabels(event.target.value)}
            />
          </Field>
          <Field
            label="Owner (optional)"
            hint="The owner guard: only this owner's sessions may run on it. Empty: any owner's."
          >
            <Input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder={STUDIO_OWNER} />
          </Field>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <SheetFooter className="px-0">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving" : "Save labels and owner"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
