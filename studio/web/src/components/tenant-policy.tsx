import { useCallback, useMemo, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { createTenantManagementClient } from "@/proxy-client";
import { messageOf, useRead } from "@/resources/reads";
import {
  EFFECT_LABELS,
  EFFECT_TONES,
  ruleManifest,
  ruleTool,
  sortedRules,
  whenText,
  type ToolRule,
} from "@/tenant-spec";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReadState } from "@/components/resource-layout";
import {
  ActionMenu,
  EmptyRow,
  FilterMenu,
  FormField,
  SearchBox,
  SidePanel,
  StatusDot,
  TableFrame,
  TableToolbar,
  ToolbarCount,
  cellClass,
  countText,
  headClass,
  menuCellClass,
  rowClass,
  TableNote,
} from "@/components/data-table";

type Effect = ToolRule["effect"];
/** The rule a panel edits: its place in the policy, or a new one. */
type Editing = { index: number } | "new";

/**
 * The Tenant's tool policy: rules the Tool Gate applies to every MCP and HTTP tool call of every
 * Agent, strictest first. A rule names a manifest, so it covers every Agent made from it. A row
 * opens it to edit; the whole policy is saved at once (`PUT /v1/tenant/tool-policy`).
 */
export function TenantPolicy({ tenantId, manifests }: { tenantId: string; manifests: readonly string[] }) {
  const management = useMemo(() => createTenantManagementClient(tenantId), [tenantId]);
  const load = useCallback(() => management.toolPolicy.get(), [management]);
  const read = useRead(load);
  const [search, setSearch] = useState("");
  const [effect, setEffect] = useState<"any" | Effect>("any");
  const [editing, setEditing] = useState<Editing>();
  const [error, setError] = useState("");
  const rules = read.data?.rules;
  async function save(next: ToolRule[]) {
    await management.toolPolicy.put({ rules: next });
    setEditing(undefined);
    read.reload();
  }
  async function remove(index: number) {
    if (!rules || !window.confirm("Delete this rule? Calls it decided are decided by the other rules.")) return;
    setError("");
    try {
      await save(rules.filter((_, i) => i !== index));
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  const needle = search.trim().toLowerCase();
  const all = rules ? sortedRules(rules) : [];
  const shown = all.filter(
    ({ rule }) =>
      (effect === "any" || rule.effect === effect) &&
      (needle === "" ||
        [ruleTool(rule), ruleManifest(rule), whenText(rule.when), rule.reason ?? ""].join(" ").toLowerCase().includes(needle)),
  );
  return (
    <div>
      <TableToolbar>
        <SearchBox label="Search rules" value={search} onChange={setSearch} />
        <FilterMenu
          label="Effect"
          value={effect}
          options={[
            { value: "any", label: "Any" },
            { value: "deny", label: "Deny" },
            { value: "ask", label: "Ask" },
            { value: "allow", label: "Allow" },
          ]}
          onChange={setEffect}
        />
        <ToolbarCount>{countText(shown.length, all.length, "rule", "rules")}</ToolbarCount>
        <Button size="sm" disabled={!rules} onClick={() => setEditing("new")}>
          <Plus />
          Add rule
        </Button>
      </TableToolbar>
      {error ? (
        <p role="alert" className="border-b px-4 py-2 text-sm break-words text-destructive">
          {error}
        </p>
      ) : null}
      <ReadState {...read} pending={read.pending && !rules} onRetry={read.reload} />
      {rules ? (
        <>
          <TableFrame minWidth={860}>
            <thead>
              <tr>
                <th className={`${headClass} w-28`}>Effect</th>
                <th className={`${headClass} w-[24%]`}>Tool</th>
                <th className={`${headClass} w-[16%]`}>Manifest</th>
                <th className={`${headClass} w-[20%]`}>When</th>
                <th className={headClass}>Reason</th>
                <th className={`${headClass} w-12`}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <EmptyRow columns={6}>
                  {all.length === 0 ? "No rules: every tool call is allowed." : "No rules match these filters."}
                </EmptyRow>
              ) : null}
              {shown.map(({ rule, index }) => {
                const open = () => setEditing({ index });
                const when = whenText(rule.when);
                return (
                  <tr
                    key={index}
                    className={cn(rowClass, "cursor-pointer")}
                    data-state={editing !== "new" && editing?.index === index ? "selected" : undefined}
                    onClick={open}
                  >
                    <td className={cellClass}>
                      <StatusDot tone={EFFECT_TONES[rule.effect]}>{EFFECT_LABELS[rule.effect]}</StatusDot>
                    </td>
                    <td className={`${cellClass} font-mono text-[13px]`} title={ruleTool(rule)}>
                      {ruleTool(rule)}
                    </td>
                    <td className={cn(cellClass, rule.agent ? "font-mono text-[13px]" : "text-muted-foreground")}>
                      {ruleManifest(rule)}
                    </td>
                    <td className={`${cellClass} font-mono text-xs text-muted-foreground`} title={when}>
                      {when || "—"}
                    </td>
                    <td className={`${cellClass} text-muted-foreground`} title={rule.reason}>
                      {rule.reason ?? "—"}
                    </td>
                    <td className={menuCellClass}>
                      <ActionMenu
                        label={`Actions for rule ${index + 1}`}
                        actions={[
                          { label: "Edit…", onSelect: open },
                          { label: "Delete", onSelect: () => void remove(index), destructive: true, separated: true },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableFrame>
          <TableNote>
            Every MCP and HTTP tool call of every Agent is checked against these rules, and the strictest rule that
            matches decides: <em>deny</em> refuses the call, <em>ask</em> holds it until a person approves it in the
            session, <em>allow</em> runs it. A call no rule matches runs. A rule names a manifest, so it covers every
            Agent made from it.
          </TableNote>
        </>
      ) : null}
      {editing && rules ? (
        <RulePanel
          rule={editing === "new" ? undefined : rules[editing.index]}
          manifests={manifests}
          onClose={() => setEditing(undefined)}
          onDelete={editing === "new" ? undefined : () => void remove(editing.index)}
          save={(rule) =>
            save(editing === "new" ? [...rules, rule] : rules.map((each, i) => (i === editing.index ? rule : each)))
          }
        />
      ) : null}
    </div>
  );
}

/** One rule, as a form: its effect, what it selects, when, and why. */
function RulePanel({
  rule,
  manifests,
  onClose,
  onDelete,
  save,
}: {
  rule?: ToolRule;
  manifests: readonly string[];
  onClose: () => void;
  onDelete?: () => void;
  save: (rule: ToolRule) => Promise<void>;
}) {
  const [effect, setEffect] = useState<Effect>(rule?.effect ?? "ask");
  const [tool, setTool] = useState(rule?.tool ?? "");
  const [server, setServer] = useState(rule?.server ?? "");
  const [agent, setAgent] = useState(rule?.agent ?? "");
  const [when, setWhen] = useState(rule?.when ? JSON.stringify(rule.when, null, 2) : "");
  const [reason, setReason] = useState(rule?.reason ?? "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    let parsed: ToolRule["when"];
    if (when.trim()) {
      try {
        parsed = JSON.parse(when) as ToolRule["when"];
      } catch {
        setError('When must be JSON, such as {"amount": {"gt": 100}}.');
        return;
      }
    }
    const next: ToolRule = {
      effect,
      ...(tool.trim() ? { tool: tool.trim() } : {}),
      ...(server.trim() ? { server: server.trim() } : {}),
      ...(rule?.kind ? { kind: rule.kind } : {}),
      ...(agent.trim() ? { agent: agent.trim() } : {}),
      ...(parsed ? { when: parsed } : {}),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    };
    setPending(true);
    try {
      await save(next);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <SidePanel
      title={rule ? `${EFFECT_LABELS[rule.effect]} · ${ruleTool(rule)}` : "New rule"}
      description={rule ? `Manifest ${ruleManifest(rule)}` : "Checked on every MCP and HTTP tool call"}
      actions={onDelete ? [{ label: "Delete", onSelect: onDelete, destructive: true }] : []}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="tool-rule" disabled={pending}>
            {pending ? "Saving…" : "Save rule"}
          </Button>
        </>
      }
    >
      <form id="tool-rule" className="space-y-4" onSubmit={(event) => void submit(event)}>
        <fieldset className="grid gap-1.5 text-sm">
          <legend className="pb-1.5 font-medium">Effect</legend>
          <div className="flex gap-1.5" role="radiogroup" aria-label="Effect">
            {(["allow", "ask", "deny"] as const).map((value) => (
              <Button
                key={value}
                type="button"
                variant="outline"
                size="sm"
                role="radio"
                aria-checked={effect === value}
                className={cn(effect === value && "border-foreground/40 bg-muted")}
                onClick={() => setEffect(value)}
              >
                {EFFECT_LABELS[value]}
              </Button>
            ))}
          </div>
        </fieldset>
        <FormField label="Tool" hint="An MCP tool's own name on its server, or an HTTP tool's name; * matches any run of characters.">
          {(props) => (
            <Input {...props} className="font-mono" placeholder="Any tool" value={tool} onChange={(event) => setTool(event.target.value)} />
          )}
        </FormField>
        <FormField label="MCP server">
          {(props) => (
            <Input {...props} className="font-mono" placeholder="Any server" value={server} onChange={(event) => setServer(event.target.value)} />
          )}
        </FormField>
        <FormField label="Manifest" hint="Covers every Agent made from it.">
          {(props) => (
            <Input
              {...props}
              className="font-mono"
              placeholder="Any manifest"
              list="tool-rule-manifests"
              value={agent}
              onChange={(event) => setAgent(event.target.value)}
            />
          )}
        </FormField>
        <datalist id="tool-rule-manifests">
          {manifests.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <FormField label="When" hint="Fields of the call's input by dotted path, each tested with equals, in, gt, gte, lt, lte or matches.">
          {(props) => (
            <textarea
              {...props}
              className="min-h-20 rounded-md border bg-transparent px-3 py-2 font-mono text-xs"
              placeholder='{"amount": {"gt": 100}}'
              value={when}
              onChange={(event) => setWhen(event.target.value)}
            />
          )}
        </FormField>
        <FormField label="Reason">
          {(props) => (
            <Input {...props} placeholder="Shown with a held or refused call" value={reason} onChange={(event) => setReason(event.target.value)} />
          )}
        </FormField>
        {error ? (
          <p role="alert" className="text-sm break-words text-destructive">
            {error}
          </p>
        ) : null}
      </form>
    </SidePanel>
  );
}
