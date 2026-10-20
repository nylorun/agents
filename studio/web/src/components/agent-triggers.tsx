import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentView } from "@nylorun/agents";
import { createTenantClient } from "@/proxy-client";
import { messageOf, useRead } from "@/resources/reads";
import { sessionPath } from "@/session-list";
import { fullTime, shortTime } from "@/time-format";
import { triggerSession, triggerWhen } from "@/agent-spec";
import { ReadState } from "@/components/resource-layout";
import {
  ActionMenu,
  EmptyRow,
  Fields,
  FilterMenu,
  SidePanel,
  StatusDot,
  TableFrame,
  TableToolbar,
  ToolbarCount,
  countText,
  cellClass,
  headClass,
  menuCellClass,
  rowClass,
  type MenuAction,
} from "@/components/data-table";

type Client = ReturnType<typeof createTenantClient>;
type TriggerView = Awaited<ReturnType<Client["agents"]["triggers"]>>[number];
type TriggerRun = Awaited<ReturnType<Client["agents"]["runs"]>>["runs"][number];

const when = (at: string | null | undefined) =>
  at ? (
    <time dateTime={at} title={fullTime(at)}>
      {shortTime(at)}
    </time>
  ) : (
    "—"
  );

const RUN_TONES = { started: "ok", queued: "warn", skipped: "idle", failed: "error" } as const;

/** What a run came to, in words. */
function runDetail(run: TriggerRun): string {
  const late = run.late ? ", late" : "";
  if (run.status === "started")
    return `${run.sessionId ? `A turn in session ${run.sessionId}` : "Started a turn"}${late}`;
  if (run.status === "queued")
    return `Queued behind a running turn${run.sessionId ? ` in ${run.sessionId}` : ""}${late}`;
  return `${run.status === "skipped" ? "Skipped" : "Failed"}${run.reason ? `: ${run.reason.replace(/_/gu, " ")}` : ""}${late}`;
}

/**
 * What starts the Agent's turns with no client connected: the triggers its manifest version
 * declares (and self-wake), each one's status and next run, and every run they made, newest
 * first. A trigger can be paused, resumed or run now; a row opens its details, with its prompt.
 */
export function AgentTriggers({
  tenantId,
  agent,
  manifest,
}: {
  tenantId: string;
  agent: AgentView;
  /** The manifest version it runs, for each trigger's prompt. */
  manifest?: unknown;
  onChanged?: () => void;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const navigate = useNavigate();
  const id = agent.id;
  const loadTriggers = useCallback((signal: AbortSignal) => sdk.agents.triggers(id, { signal }), [sdk, id]);
  const triggers = useRead(loadTriggers);
  const loadRuns = useCallback((signal: AbortSignal) => sdk.agents.runs(id, { limit: 50, signal }), [sdk, id]);
  const runs = useRead(loadRuns);
  const [list, setList] = useState<TriggerView[]>();
  const [trigger, setTrigger] = useState("any");
  const [result, setResult] = useState<"any" | TriggerRun["status"]>("any");
  const [selected, setSelected] = useState<{ trigger: string } | { run: string }>();
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const shown = list ?? triggers.data ?? [];
  const allRuns = runs.data?.runs ?? [];
  const filtered = allRuns.filter(
    (run) => (trigger === "any" || run.triggerId === trigger) && (result === "any" || run.status === result),
  );
  const declared = useMemo(() => {
    const doc = manifest as { runtime?: { triggers?: Record<string, { prompt?: string; webhook?: string }> } } | undefined;
    return doc?.runtime?.triggers ?? {};
  }, [manifest]);

  async function run(work: () => Promise<string>) {
    setActing(true);
    setError("");
    setNotice("");
    try {
      setNotice(await work());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setActing(false);
    }
  }
  const pause = (t: TriggerView) =>
    run(async () => {
      setList(await sdk.agents.pauseTrigger(id, t.id));
      return `Paused ${t.id}.`;
    });
  const resume = (t: TriggerView) =>
    run(async () => {
      setList(await sdk.agents.resumeTrigger(id, t.id));
      return `Resumed ${t.id}.`;
    });
  const runNow = (t: TriggerView) =>
    run(async () => {
      const made = await sdk.agents.runTrigger(id, t.id);
      runs.reload();
      triggers.reload();
      setList(undefined);
      return `Ran ${t.id}: ${runDetail(made).toLowerCase()}.`;
    });
  const copyUrl = (t: TriggerView) =>
    run(async () => {
      await navigator.clipboard.writeText(t.webhookUrl ?? "");
      return `Copied the webhook URL of ${t.id}.`;
    });
  const triggerActions = (t: TriggerView): MenuAction[] => [
    ...(t.kind !== "wake" && t.status !== "completed"
      ? [{ label: "Run now", onSelect: () => void runNow(t), disabled: acting }]
      : []),
    ...(t.webhookUrl ? [{ label: "Copy webhook URL", onSelect: () => void copyUrl(t) }] : []),
    ...(t.status === "active"
      ? [{ label: "Pause", onSelect: () => void pause(t), disabled: acting }]
      : t.status === "paused"
        ? [{ label: "Resume", onSelect: () => void resume(t), disabled: acting }]
        : []),
  ];
  const runActions = (r: TriggerRun): MenuAction[] =>
    r.sessionId
      ? [{ label: "Open session", onSelect: () => navigate(sessionPath(id, r.sessionId!)) }]
      : [];

  const openTrigger = "trigger" in (selected ?? {}) ? shown.find((t) => t.id === (selected as { trigger: string }).trigger) : undefined;
  const openRun = "run" in (selected ?? {}) ? allRuns.find((r) => r.id === (selected as { run: string }).run) : undefined;
  const triggerIds = [...new Set([...shown.map((t) => t.id), ...allRuns.map((r) => r.triggerId)])];

  return (
    <div>
      {error ? (
        <p role="alert" className="border-b px-4 py-2 text-sm break-words text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="border-b px-4 py-2 text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      <TableToolbar>
        <h2 className="text-sm font-semibold">Triggers</h2>
        <ToolbarCount>{countText(shown.length, shown.length, "trigger", "triggers")}</ToolbarCount>
      </TableToolbar>
      <TableFrame minWidth={760}>
        <thead>
          <tr>
            <th className={`${headClass} w-[18%]`}>Trigger</th>
            <th className={`${headClass} w-[11%]`}>Status</th>
            <th className={headClass}>When</th>
            <th className={`${headClass} w-[20%]`}>Runs in</th>
            <th className={`${headClass} w-[14%]`}>Next run</th>
            <th className={`${headClass} w-12`}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {triggers.data && shown.length === 0 ? (
            <EmptyRow columns={6}>Its manifest version declares no triggers.</EmptyRow>
          ) : null}
          {shown.map((t) => (
            <tr
              key={t.id}
              className={`${rowClass} cursor-pointer`}
              data-state={openTrigger?.id === t.id ? "selected" : undefined}
              onClick={() => setSelected({ trigger: t.id })}
            >
              <td className={`${cellClass} font-mono text-[13px]`} title={t.id}>
                {t.kind === "wake" ? "Self-wake" : t.id}
              </td>
              <td className={cellClass} title={t.pausedReason ?? undefined}>
                <StatusDot tone={t.status === "active" ? "ok" : t.status === "paused" ? "warn" : "idle"}>
                  {t.status === "active" ? "Active" : t.status === "paused" ? "Paused" : "Completed"}
                </StatusDot>
              </td>
              <td className={cellClass}>{triggerWhen(t)}</td>
              <td className={`${cellClass} text-muted-foreground`}>{triggerSession(t.session)}</td>
              <td className={`${cellClass} text-muted-foreground`}>{when(t.nextRunAt)}</td>
              <td className={menuCellClass}>
                <ActionMenu label={`Actions for ${t.id}`} actions={triggerActions(t)} />
              </td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <ReadState {...triggers} onRetry={triggers.reload} />
      <TableToolbar>
        <h2 className="mr-2 text-sm font-semibold">Runs</h2>
        <FilterMenu
          label="Trigger"
          value={trigger}
          options={[{ value: "any", label: "Any" }, ...triggerIds.map((value) => ({ value, label: value }))]}
          onChange={setTrigger}
        />
        <FilterMenu
          label="Result"
          value={result}
          options={[
            { value: "any", label: "Any" },
            { value: "started", label: "Started" },
            { value: "queued", label: "Queued" },
            { value: "skipped", label: "Skipped" },
            { value: "failed", label: "Failed" },
          ]}
          onChange={setResult}
        />
        <ToolbarCount>
          {countText(filtered.length, allRuns.length, "run", "runs")}
        </ToolbarCount>
      </TableToolbar>
      <TableFrame minWidth={720}>
        <thead>
          <tr>
            <th className={`${headClass} w-[16%]`}>Fired</th>
            <th className={`${headClass} w-[18%]`}>Trigger</th>
            <th className={`${headClass} w-[12%]`}>Result</th>
            <th className={headClass}>Detail</th>
            <th className={`${headClass} w-12`}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.data && filtered.length === 0 ? (
            <EmptyRow columns={5}>{allRuns.length === 0 ? "No runs yet." : "No runs match these filters."}</EmptyRow>
          ) : null}
          {filtered.map((r) => (
            <tr
              key={r.id}
              className={`${rowClass} cursor-pointer`}
              data-state={openRun?.id === r.id ? "selected" : undefined}
              onClick={() => setSelected({ run: r.id })}
            >
              <td className={`${cellClass} text-muted-foreground`}>{when(r.firedAt)}</td>
              <td className={`${cellClass} font-mono text-[13px]`}>{r.triggerId}</td>
              <td className={cellClass}>
                <StatusDot tone={RUN_TONES[r.status]}>{r.status[0]!.toUpperCase() + r.status.slice(1)}</StatusDot>
              </td>
              <td className={`${cellClass} text-muted-foreground`} title={runDetail(r)}>
                {runDetail(r)}
              </td>
              <td className={menuCellClass}>
                <ActionMenu label={`Actions for the run at ${r.firedAt}`} actions={runActions(r)} />
              </td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <ReadState {...runs} onRetry={runs.reload} />
      {openTrigger ? (
        <SidePanel
          title={openTrigger.kind === "wake" ? "Self-wake" : openTrigger.id}
          description={`${openTrigger.status[0]!.toUpperCase()}${openTrigger.status.slice(1)} · declared by v${agent.resolvedVersion}`}
          actions={triggerActions(openTrigger)}
          onClose={() => setSelected(undefined)}
        >
          <Fields
            entries={[
              ["When", triggerWhen(openTrigger)],
              ...(openTrigger.schedule ? ([["Schedule", <code className="font-mono text-xs">{openTrigger.schedule}</code>]] as const) : []),
              ...(declared[openTrigger.id]?.webhook ? ([["Verified by", declared[openTrigger.id]!.webhook]] as const) : []),
              ...(openTrigger.webhookUrl
                ? ([["Webhook URL", <span className="font-mono text-xs break-all">{openTrigger.webhookUrl}</span>]] as const)
                : []),
              ["Runs in", triggerSession(openTrigger.session)],
              ["Next run", when(openTrigger.nextRunAt)],
              ["Last run", when(openTrigger.lastRunAt)],
              ...(openTrigger.pausedReason ? ([["Paused by", openTrigger.pausedReason]] as const) : []),
            ]}
          />
          {declared[openTrigger.id]?.prompt ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Prompt</p>
              <p className="text-sm whitespace-pre-wrap">{declared[openTrigger.id]!.prompt}</p>
            </div>
          ) : null}
        </SidePanel>
      ) : openRun ? (
        <SidePanel
          title={openRun.triggerId}
          description={`Run · ${fullTime(openRun.firedAt)}`}
          actions={runActions(openRun)}
          onClose={() => setSelected(undefined)}
        >
          <Fields
            entries={[
              ["Result", openRun.status],
              ["Detail", runDetail(openRun)],
              ["Session", openRun.sessionId ?? "—"],
              ["Turn", openRun.turnId ?? "—"],
              ["Due", fullTime(openRun.dueAt)],
              ["Fired", fullTime(openRun.firedAt)],
              ["Run", <span className="font-mono text-xs">{openRun.id}</span>],
            ]}
          />
        </SidePanel>
      ) : null}
    </div>
  );
}
