import { useCallback, useMemo, useState, type FormEvent } from "react";
import type { AgentView } from "@nylorun/agents";
import { Plus, X } from "lucide-react";
import { createTenantClient } from "@/proxy-client";
import { messageOf, useRead } from "@/resources/reads";
import { fullTime, shortTime } from "@/time-format";
import { slotTypeLabel, vaultRows, type VaultRow } from "@/agent-spec";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReadState } from "@/components/resource-layout";
import {
  ActionMenu,
  EmptyRow,
  Fields,
  FilterMenu,
  SearchBox,
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

/** True when the Runtime's answer contains one of the secrets just sent. */
function leaks(info: unknown, secrets: readonly string[]): boolean {
  const text = JSON.stringify(info);
  return secrets.some((value) => value.length >= 8 && text.includes(value));
}

/** What the one input of a slot's Set value panel asks for. */
const inputLabel = (type: string) =>
  type === "bearer" ? "Token" : type === "environment_secret" ? "Secret value" : "Value";

/** A declared slot takes only its value: `value`, or `headers` for a headers slot. */
type SlotValue = { value: string } | { headers: Record<string, string> };

type Panel = { name: string; mode: "view" | "edit" };
type HeaderRow = { name: string; value: string };

/**
 * The Agent's vault: one row for each slot its manifest version declares, and whether the vault
 * holds a value for it. Everything but the value (its type, where it may go, how it is sent)
 * is the manifest's, so setting one takes only the value. A secret no slot declares (an Agent
 * made before its manifest declared slots) can only be deleted.
 */
export function AgentVault({
  tenantId,
  agent,
  manifest,
  onChanged,
}: {
  tenantId: string;
  agent: AgentView;
  /** The manifest version it runs, for what uses each slot. */
  manifest?: unknown;
  onChanged: () => void;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const id = agent.id;
  const load = useCallback((signal: AbortSignal) => sdk.agents.secrets.list(id, { signal }), [sdk, id]);
  const read = useRead(load);
  const [search, setSearch] = useState("");
  const [value, setValue] = useState<"any" | "set" | "unset">("any");
  const [type, setType] = useState("any");
  const [panel, setPanel] = useState<Panel>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const harness = (manifest as { harness?: unknown } | undefined)?.harness;
  const rows = vaultRows(agent, read.data ?? [], harness);
  const types = [...new Set(rows.map((row) => row.type))];
  const needle = search.trim().toLowerCase();
  const shown = rows.filter(
    (row) =>
      (value === "any" || (value === "set") === row.set) &&
      (type === "any" || row.type === type) &&
      (needle === "" || row.name.toLowerCase().includes(needle) || row.uses.join(" ").toLowerCase().includes(needle)),
  );
  async function remove(row: VaultRow) {
    if (!window.confirm(`Delete ${row.name} from ${id}'s vault? Its tools can no longer use it.`)) return;
    setError("");
    setNotice("");
    try {
      await sdk.agents.secrets.delete(id, row.name);
      setPanel(undefined);
      setNotice(`Deleted ${row.name}.`);
      read.reload();
      onChanged();
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  const actions = (row: VaultRow, inPanel = false): MenuAction[] => [
    ...(row.declared ? [{ label: "Set value", onSelect: () => setPanel({ name: row.name, mode: "edit" }) }] : []),
    ...(inPanel ? [] : [{ label: "Details", onSelect: () => setPanel({ name: row.name, mode: "view" }) }]),
    ...(row.declared
      ? []
      : [{ label: "Delete…", onSelect: () => void remove(row), destructive: true, separated: true }]),
  ];
  const open = panel ? rows.find((row) => row.name === panel.name) : undefined;
  return (
    <div>
      {error ? (
        <p role="alert" className="border-b px-4 py-2 text-sm break-words text-red-600">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="border-b px-4 py-2 text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      <TableToolbar>
        <SearchBox label="Search slots" value={search} onChange={setSearch} />
        <FilterMenu
          label="Value"
          value={value}
          options={[
            { value: "any", label: "Any" },
            { value: "set", label: "Set" },
            { value: "unset", label: "Not set" },
          ]}
          onChange={setValue}
        />
        <FilterMenu
          label="Type"
          value={type}
          options={[{ value: "any", label: "Any" }, ...types.map((t) => ({ value: t, label: slotTypeLabel(t) }))]}
          onChange={setType}
        />
        <ToolbarCount>
          {countText(shown.length, rows.length, "slot", "slots")}
        </ToolbarCount>
      </TableToolbar>
      <TableFrame minWidth={680}>
        <thead>
          <tr>
            <th className={`${headClass} w-[24%]`}>Slot</th>
            <th className={`${headClass} w-[16%]`}>Type</th>
            <th className={headClass}>Used by</th>
            <th className={`${headClass} w-[18%]`}>Value</th>
            <th className={`${headClass} w-12`}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {read.data && shown.length === 0 ? (
            <EmptyRow columns={5}>
              {rows.length === 0 ? "Its manifest version declares no vault slots." : "No slots match these filters."}
            </EmptyRow>
          ) : null}
          {shown.map((row) => (
            <tr
              key={row.name}
              className={`${rowClass} cursor-pointer`}
              data-state={panel?.name === row.name ? "selected" : undefined}
              onClick={() => setPanel({ name: row.name, mode: row.declared && !row.set ? "edit" : "view" })}
            >
              <td className={`${cellClass} font-mono text-[13px]`} title={row.name}>
                {row.name}
              </td>
              <td className={`${cellClass} text-muted-foreground`}>{row.typeLabel}</td>
              <td className={`${cellClass} text-muted-foreground`} title={row.uses.join(", ")}>
                {row.uses.length ? row.uses.join(", ") : row.declared ? "—" : "Not in the manifest"}
              </td>
              <td className={cellClass}>
                <StatusDot tone={row.set ? "ok" : "idle"}>
                  {row.set ? (row.rotatedAt ? `Set ${shortTime(row.rotatedAt)}` : "Set") : "Not set"}
                </StatusDot>
              </td>
              <td className={menuCellClass}>
                <ActionMenu label={`Actions for ${row.name}`} actions={actions(row)} />
              </td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <ReadState {...read} onRetry={read.reload} />
      {open && panel ? (
        <SlotPanel
          key={`${open.name}:${panel.mode}`}
          row={open}
          editing={panel.mode === "edit"}
          actions={actions(open, true)}
          onClose={() => setPanel(undefined)}
          onSave={async (body) => {
            const written = await sdk.agents.secrets.put(id, open.name, body);
            if (leaks(written, "headers" in body ? Object.values(body.headers) : [body.value]))
              throw new Error("The Runtime returned the secret.");
            setPanel(undefined);
            setNotice(`Saved ${open.name}. It is encrypted in the vault, and never shown again.`);
            read.reload();
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function SlotPanel({
  row,
  editing,
  actions,
  onClose,
  onSave,
}: {
  row: VaultRow;
  editing: boolean;
  actions: MenuAction[];
  onClose: () => void;
  onSave: (body: SlotValue) => Promise<void>;
}) {
  const [secret, setSecret] = useState("");
  const [headers, setHeaders] = useState<HeaderRow[]>(() =>
    row.headerNames.length ? row.headerNames.map((name) => ({ name, value: "" })) : [{ name: "", value: "" }],
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const isHeaders = row.type === "headers";
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      if (isHeaders) {
        const map = Object.fromEntries(
          headers.filter((h) => h.name.trim() !== "").map((h) => [h.name.trim().toLowerCase(), h.value]),
        );
        if (Object.keys(map).length === 0) throw new Error("Enter at least one header.");
        await onSave({ headers: map });
      } else {
        if (!secret) throw new Error(`Enter the ${inputLabel(row.type).toLowerCase()}.`);
        await onSave({ value: secret });
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  const visible = row.type === "environment_variable" ? "Visible to" : "Sent only to";
  const facts: (readonly [string, string])[] = [
    ...(row.description ? ([["Description", row.description]] as const) : []),
    ["Used by", row.uses.length ? row.uses.join(", ") : "—"],
    [visible, row.reach],
    ...(row.sentAs ? ([["Sent as", row.sentAs]] as const) : []),
    ...(row.type === "bearer" ? ([["Sent as", "Authorization: Bearer {value}"]] as const) : []),
    ["Required", row.required ? "Yes" : "No"],
  ];
  return (
    <SidePanel
      title={row.name}
      description={`${row.typeLabel} · ${row.set ? "set" : "not set"}${row.declared ? "" : " · not in the manifest"}`}
      actions={actions}
      onClose={onClose}
      footer={
        editing ? (
          <>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="vault-value" disabled={pending}>
              {pending ? "Saving" : "Save"}
            </Button>
          </>
        ) : undefined
      }
    >
      {editing ? (
        <form id="vault-value" className="space-y-3" onSubmit={(event) => void submit(event)}>
          {isHeaders ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">Headers</p>
              {headers.map((header, index) => (
                <div key={index} className="flex gap-2">
                  <Input
                    aria-label={`Header ${index + 1} name`}
                    placeholder="x-api-key"
                    value={header.name}
                    onChange={(event) =>
                      setHeaders((rows) => rows.map((r, i) => (i === index ? { ...r, name: event.target.value } : r)))
                    }
                    className="font-mono"
                  />
                  <Input
                    aria-label={`Header ${index + 1} value`}
                    type="password"
                    autoComplete="off"
                    placeholder="Value"
                    value={header.value}
                    onChange={(event) =>
                      setHeaders((rows) => rows.map((r, i) => (i === index ? { ...r, value: event.target.value } : r)))
                    }
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove header ${index + 1}`}
                    disabled={headers.length === 1}
                    onClick={() => setHeaders((rows) => rows.filter((_, i) => i !== index))}
                  >
                    <X />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setHeaders((rows) => [...rows, { name: "", value: "" }])}
              >
                <Plus />
                Add header
              </Button>
            </div>
          ) : (
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">{inputLabel(row.type)}</span>
              <Input
                type="password"
                autoComplete="off"
                autoFocus
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder={row.set ? "A new value replaces the one it holds" : "Paste the value"}
              />
            </label>
          )}
          <p className="text-xs text-muted-foreground">
            It is encrypted in the Agent's vault and never shown again.
            {row.type === "environment_secret" ? " Commands in the sandbox see a placeholder; the value goes only where the manifest says." : ""}
          </p>
          {error ? (
            <p role="alert" className="text-sm break-words text-red-600">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          {row.declared ? "From the manifest" : "Not declared by the manifest version it runs"}
        </p>
        <Fields entries={facts} />
      </div>
      {row.rotatedAt ? (
        <Fields entries={[["Last set", fullTime(row.rotatedAt)]]} />
      ) : null}
    </SidePanel>
  );
}
