import { Fragment, useCallback, useMemo, useState, type FormEvent } from "react";
import { RUNTIME_LIMIT_DEFAULTS } from "@nylorun/agents";
import { cn } from "@/lib/utils";
import { createTenantManagementClient } from "@/proxy-client";
import { messageOf, useRead } from "@/resources/reads";
import { limitGroups, limitOverrides, limitText, limitUnit, parseLimit, type LimitRow } from "@/tenant-spec";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReadState } from "@/components/resource-layout";
import {
  ActionMenu,
  EmptyRow,
  Fields,
  FilterMenu,
  FormField,
  GroupRow,
  SearchBox,
  SidePanel,
  TableFrame,
  TableNote,
  TableToolbar,
  ToolbarCount,
  cellClass,
  countText,
  headClass,
  menuCellClass,
  rowClass,
} from "@/components/data-table";

const DEFAULTS: Readonly<Record<string, number>> = RUNTIME_LIMIT_DEFAULTS;

const UNIT_HINTS: Record<ReturnType<typeof limitUnit>, string> = {
  bytes: "A size, such as 512 KiB or 10 MiB, or a count of bytes.",
  duration: "A time, such as 30 s, 10 min or 2 h, or a count of milliseconds.",
  characters: "A count of characters.",
  percent: "A percentage.",
  count: "A whole number.",
};

/**
 * The Tenant's Runtime limits, by area: each one's value beside its default, a changed one in
 * bold. A row opens it to edit. Only the limits that differ from their defaults are saved
 * (`PUT /v1/tenant/limits`); the Runtime refuses one past what it can hold.
 */
export function TenantLimits({ tenantId }: { tenantId: string }) {
  const management = useMemo(() => createTenantManagementClient(tenantId), [tenantId]);
  const load = useCallback(() => management.settings.limits.get(), [management]);
  const read = useRead(load);
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("any");
  const [changed, setChanged] = useState<"any" | "changed">("any");
  const [open, setOpen] = useState<string>();
  const [error, setError] = useState("");
  const limits = read.data?.limits as Readonly<Record<string, number>> | undefined;
  const groups = limits ? limitGroups(limits, DEFAULTS) : [];
  const total = groups.reduce((sum, g) => sum + g.rows.length, 0);
  const needle = search.trim().toLowerCase();
  const shown = groups
    .filter((g) => group === "any" || g.title === group)
    .map((g) => ({
      ...g,
      rows: g.rows.filter(
        (row) =>
          (changed === "any" || row.changed) &&
          (needle === "" || `${row.name} ${row.description}`.toLowerCase().includes(needle)),
      ),
    }))
    .filter((g) => g.rows.length > 0);
  const count = shown.reduce((sum, g) => sum + g.rows.length, 0);
  async function save(name: string, value: number | undefined) {
    if (!limits) return;
    await management.settings.limits.put({ limits: limitOverrides(limits, DEFAULTS, name, value) });
    setOpen(undefined);
    read.reload();
  }
  async function reset(name: string) {
    setError("");
    try {
      await save(name, undefined);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  const current = groups.flatMap((g) => g.rows).find((row) => row.name === open);
  return (
    <div>
      <TableToolbar>
        <SearchBox label="Search limits" value={search} onChange={setSearch} />
        <FilterMenu
          label="Group"
          value={group}
          options={[{ value: "any", label: "Any" }, ...groups.map((g) => ({ value: g.title, label: g.title }))]}
          onChange={setGroup}
        />
        <FilterMenu
          label="Value"
          value={changed}
          options={[
            { value: "any", label: "Any" },
            { value: "changed", label: "Changed from default" },
          ]}
          onChange={setChanged}
        />
        <ToolbarCount>{countText(count, total, "limit", "limits")}</ToolbarCount>
      </TableToolbar>
      {error ? (
        <p role="alert" className="border-b px-4 py-2 text-sm break-words text-destructive">
          {error}
        </p>
      ) : null}
      <ReadState {...read} pending={read.pending && !limits} onRetry={read.reload} />
      {limits ? (
        <>
          <TableFrame minWidth={760}>
            <thead>
              <tr>
                <th className={`${headClass} w-[26%]`}>Limit</th>
                <th className={headClass}>What it holds</th>
                <th className={`${headClass} w-40`}>Value</th>
                <th className={`${headClass} w-40`}>Default</th>
                <th className={`${headClass} w-12`}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? <EmptyRow columns={5}>No limits match these filters.</EmptyRow> : null}
              {shown.map((g) => (
                <Fragment key={g.title}>
                  <GroupRow columns={5}>{g.title}</GroupRow>
                  {g.rows.map((row) => {
                    const edit = () => setOpen(row.name);
                    return (
                      <tr
                        key={row.name}
                        className={cn(rowClass, "cursor-pointer")}
                        data-state={open === row.name ? "selected" : undefined}
                        onClick={edit}
                      >
                        <td className={`${cellClass} font-mono text-[13px]`} title={row.name}>
                          {row.name}
                        </td>
                        <td className={`${cellClass} text-muted-foreground`} title={row.description}>
                          {row.description || "—"}
                        </td>
                        <td className={cn(cellClass, "tabular-nums", row.changed && "font-semibold")}>
                          {limitText(row.name, row.value)}
                        </td>
                        <td className={`${cellClass} text-muted-foreground tabular-nums`}>
                          {row.default === undefined ? "—" : limitText(row.name, row.default)}
                        </td>
                        <td className={menuCellClass}>
                          <ActionMenu
                            label={`Actions for ${row.name}`}
                            actions={[
                              { label: "Edit…", onSelect: edit },
                              ...(row.changed ? [{ label: "Reset to default", onSelect: () => void reset(row.name) }] : []),
                            ]}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </TableFrame>
          <TableNote>
            The sizes, counts and deadlines the Runtime holds what crosses it to. A limit left at its default follows the
            default of a later Runtime; one past what the Runtime can hold is refused.
          </TableNote>
        </>
      ) : null}
      {current ? (
        <LimitPanel
          row={current}
          onClose={() => setOpen(undefined)}
          onReset={() => void reset(current.name)}
          save={(value) => save(current.name, value)}
        />
      ) : null}
    </div>
  );
}

function LimitPanel({
  row,
  onClose,
  onReset,
  save,
}: {
  row: LimitRow;
  onClose: () => void;
  onReset: () => void;
  save: (value: number) => Promise<void>;
}) {
  const [text, setText] = useState(() => limitText(row.name, row.value).replace(/ characters$/u, ""));
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const value = parseLimit(row.name, text);
    if (value === undefined) {
      setError(UNIT_HINTS[limitUnit(row.name)]);
      return;
    }
    setPending(true);
    try {
      await save(value);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <SidePanel
      title={row.name}
      description={`${row.group} · ${row.changed ? "changed" : "default"}`}
      actions={row.changed ? [{ label: "Reset to default", onSelect: onReset }] : []}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="runtime-limit" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      {row.description ? <p className="text-sm text-muted-foreground">{row.description}.</p> : null}
      <form id="runtime-limit" className="space-y-4" onSubmit={(event) => void submit(event)}>
        <FormField label="Value" hint={UNIT_HINTS[limitUnit(row.name)]}>
          {(props) => <Input {...props} value={text} onChange={(event) => setText(event.target.value)} />}
        </FormField>
        {error ? (
          <p role="alert" className="text-sm break-words text-destructive">
            {error}
          </p>
        ) : null}
      </form>
      <Fields
        entries={[
          ["Now", limitText(row.name, row.value)],
          ["Default", row.default === undefined ? "—" : limitText(row.name, row.default)],
          ["Group", row.group],
        ]}
      />
    </SidePanel>
  );
}
