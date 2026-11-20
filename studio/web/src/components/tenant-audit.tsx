import { useCallback, useMemo, useState } from "react";
import type { TenantEvent } from "@nylorun/admin/client";
import { Button } from "@/components/ui/button";
import { createTenantManagementClient } from "@/proxy-client";
import { messageOf, useRead } from "@/resources/reads";
import { AUDIT_VIEWS, auditSummary, auditWho, type AuditView } from "@/tenant-audit";
import { fullTime, shortTime } from "@/time-format";
import { ReadState } from "@/components/resource-layout";
import {
  ActionMenu,
  CodeBlock,
  EmptyRow,
  Fields,
  FilterMenu,
  SidePanel,
  TableFrame,
  TableNote,
  TableToolbar,
  ToolbarCount,
  cellClass,
  headClass,
  menuCellClass,
  rowClass,
  type MenuAction,
} from "@/components/data-table";

/** Events a page holds. */
const AUDIT_PAGE = 50;

/**
 * The Tenant's audit (ADR-159), newest first: keys, signing keys, tool policy and settings
 * changes, vault credentials written and used, and Studio sign-ins, each with who did it. The
 * Type filter reads again from the Runtime; "Load more" reads the next page. A row opens the
 * event.
 */
export function TenantAudit({ tenantId }: { tenantId: string }) {
  const [view, setView] = useState<AuditView>("any");
  return <AuditTable key={view} tenantId={tenantId} view={view} onView={setView} />;
}

function AuditTable({
  tenantId,
  view,
  onView,
}: {
  tenantId: string;
  view: AuditView;
  onView: (view: AuditView) => void;
}) {
  const management = useMemo(() => createTenantManagementClient(tenantId), [tenantId]);
  const types = AUDIT_VIEWS[view].types;
  const load = useCallback(
    () => management.tenant.audit({ limit: AUDIT_PAGE, ...(types ? { types } : {}) }),
    [management, types],
  );
  const first = useRead(load);
  // Pages read with "Load more", after the first; a new first read starts them again.
  const [more, setMore] = useState<{ after: string; events: TenantEvent[]; nextCursor: string | null }>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState("");
  const [open, setOpen] = useState<number>();
  const firstPage = first.data;
  const extra = firstPage && more && more.after === firstPage.nextCursor ? more : undefined;
  const events = [...(firstPage?.events ?? []), ...(extra?.events ?? [])];
  const cursor = extra ? extra.nextCursor : (firstPage?.nextCursor ?? null);
  function loadMore() {
    if (cursor === null || !firstPage) return;
    setLoadingMore(true);
    setMoreError("");
    management.tenant
      .audit({ limit: AUDIT_PAGE, cursor, ...(types ? { types } : {}) })
      .then(
        (page) =>
          setMore({
            after: firstPage.nextCursor!,
            events: [...(extra?.events ?? []), ...page.events],
            nextCursor: page.nextCursor,
          }),
        (cause: unknown) => setMoreError(messageOf(cause)),
      )
      .finally(() => setLoadingMore(false));
  }
  const actions = (e: TenantEvent): MenuAction[] => [
    { label: "Copy event JSON", onSelect: () => void navigator.clipboard.writeText(JSON.stringify(e, null, 2)) },
  ];
  const current = events.find((e) => e.seq === open);
  return (
    <div>
      <TableToolbar>
        <FilterMenu
          label="Type"
          value={view}
          options={(Object.keys(AUDIT_VIEWS) as AuditView[]).map((value) => ({ value, label: AUDIT_VIEWS[value].label }))}
          onChange={onView}
        />
        <ToolbarCount>
          {events.length === 1 ? "1 event" : `${events.length} events`}
          {cursor !== null ? ", more older" : ""}
        </ToolbarCount>
      </TableToolbar>
      <TableFrame minWidth={760}>
        <thead>
          <tr>
            <th className={`${headClass} w-[14%]`}>Time</th>
            <th className={`${headClass} w-[18%]`}>Event</th>
            <th className={`${headClass} w-[18%]`}>Who</th>
            <th className={headClass}>Detail</th>
            <th className={`${headClass} w-12`}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {firstPage && events.length === 0 ? (
            <EmptyRow columns={5}>{view === "any" ? "Nothing recorded yet." : "No events of this type."}</EmptyRow>
          ) : null}
          {events.map((e) => (
            <tr
              key={e.seq}
              className={`${rowClass} cursor-pointer`}
              data-state={open === e.seq ? "selected" : undefined}
              onClick={() => setOpen(e.seq)}
            >
              <td className={`${cellClass} text-muted-foreground`}>
                <time dateTime={e.time} title={fullTime(e.time)}>
                  {shortTime(e.time)}
                </time>
              </td>
              <td className={`${cellClass} font-mono text-[13px]`} title={`${e.seq} · ${e.type}`}>
                {e.type}
              </td>
              <td className={`${cellClass} font-mono text-[13px]`} title={`${e.principal} · ${e.source}`}>
                {auditWho(e)}
              </td>
              <td className={`${cellClass} text-muted-foreground`} title={auditSummary(e)}>
                {auditSummary(e)}
              </td>
              <td className={menuCellClass}>
                <ActionMenu label={`Actions for event ${e.seq}`} actions={actions(e)} />
              </td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <ReadState {...first} pending={first.pending && !firstPage} onRetry={first.reload} />
      {moreError ? (
        <p role="alert" className="px-4 py-3 text-sm break-words">
          {moreError}
        </p>
      ) : null}
      {cursor !== null ? (
        <div className="px-4 py-3">
          <Button variant="outline" size="sm" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
      <TableNote>
        Who changed keys, the tool policy and settings, which credentials sessions used, and who signed in to Studio.
        No event holds a secret.
      </TableNote>
      {current ? (
        <SidePanel
          title={current.type}
          description={`${current.seq} · ${fullTime(current.time)}`}
          actions={actions(current)}
          onClose={() => setOpen(undefined)}
          wide
        >
          <Fields
            entries={[
              ["Who", <span className="font-mono text-[13px]">{current.principal}</span>],
              ["Source", current.source],
              ["Detail", auditSummary(current)],
            ]}
          />
          <CodeBlock label="Payload">{JSON.stringify(current.payload, null, 2)}</CodeBlock>
        </SidePanel>
      ) : null}
    </div>
  );
}
