import { useCallback, useMemo, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { createTenantManagementClient } from "@/proxy-client";
import { messageOf, useRead } from "@/resources/reads";
import { formatCost } from "@/usage-format";
import { fullTime, shortTime } from "@/time-format";
import {
  budgetKey,
  budgetLimit,
  budgetPeriod,
  budgetQuery,
  budgetScope,
  budgetUsed,
  tokensText,
  type ModelBudget,
  type UsageTotals,
} from "@/tenant-spec";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReadState } from "@/components/resource-layout";
import {
  ActionMenu,
  EmptyRow,
  FormField,
  SidePanel,
  TableFrame,
  TableHeading,
  TableNote,
  cellClass,
  headClass,
  menuCellClass,
  rowClass,
} from "@/components/data-table";

const PERIODS = [
  ["day", "Today"],
  ["month", "This month"],
  ["total", "All time"],
] as const;

/**
 * What the Tenant's model calls used, today, this month and in all, and the budgets that cap
 * them: a call that would pass one is refused. Budgets are saved all at once
 * (`PUT /v1/tenant/budgets`).
 */
export function TenantUsage({ tenantId, manifests }: { tenantId: string; manifests: readonly string[] }) {
  const management = useMemo(() => createTenantManagementClient(tenantId), [tenantId]);
  const loadUsage = useCallback(
    () => Promise.all(PERIODS.map(([period]) => management.models.usage({ scope: "tenant", period }))),
    [management],
  );
  const usage = useRead(loadUsage);
  const loadBudgets = useCallback(async () => {
    const { budgets } = await management.models.budgets.get();
    // What each budget's period used so far; a turn's is checked per turn.
    const used = await Promise.all(
      budgets.map(async (budget) => {
        const query = budgetQuery(budget);
        return query ? await management.models.usage(query).catch(() => undefined) : undefined;
      }),
    );
    return budgets.map((budget, index) => ({ budget, used: used[index] }));
  }, [management]);
  const budgets = useRead(loadBudgets);
  const [editing, setEditing] = useState<number | "new">();
  const [error, setError] = useState("");
  const list = budgets.data?.map(({ budget }) => budget);
  async function save(next: ModelBudget[]) {
    await management.models.budgets.put({ budgets: next });
    setEditing(undefined);
    budgets.reload();
  }
  async function remove(index: number) {
    if (!list || !window.confirm(`Remove the budget for ${budgetScope(list[index]!).toLowerCase()}? Its calls are no longer capped.`))
      return;
    setError("");
    try {
      await save(list.filter((_, i) => i !== index));
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  return (
    <div>
      <TableHeading title="Model usage" hint="Every model call the Tenant's Agents made" />
      <ReadState {...usage} pending={usage.pending && !usage.data} onRetry={usage.reload} />
      {usage.data ? <UsageTable totals={usage.data} /> : null}
      <TableHeading title="Budgets" hint="A model call that would pass one is refused">
        <Button size="sm" disabled={!list} onClick={() => setEditing("new")}>
          <Plus />
          Add budget
        </Button>
      </TableHeading>
      {error ? (
        <p role="alert" className="border-b px-4 py-2 text-sm break-words text-red-600">
          {error}
        </p>
      ) : null}
      <ReadState {...budgets} pending={budgets.pending && !budgets.data} onRetry={budgets.reload} />
      {budgets.data ? (
        <TableFrame minWidth={760}>
          <thead>
            <tr>
              <th className={headClass}>Applies to</th>
              <th className={`${headClass} w-32`}>Period</th>
              <th className={`${headClass} w-44`}>Limit</th>
              <th className={`${headClass} w-64`}>Used</th>
              <th className={`${headClass} w-12`}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {budgets.data.length === 0 ? <EmptyRow columns={5}>No budgets: model calls are not capped.</EmptyRow> : null}
            {budgets.data.map(({ budget, used }, index) => {
              const share = budgetUsed(budget, used);
              const edit = () => setEditing(index);
              return (
                <tr
                  key={budgetKey(budget)}
                  className={cn(rowClass, "cursor-pointer")}
                  data-state={editing === index ? "selected" : undefined}
                  onClick={edit}
                >
                  <td className={cellClass} title={budgetScope(budget)}>
                    {budgetScope(budget)}
                  </td>
                  <td className={`${cellClass} text-muted-foreground`}>{budgetPeriod(budget)}</td>
                  <td className={`${cellClass} tabular-nums`}>{budgetLimit(budget)}</td>
                  <td className={cellClass}>
                    <span className="flex items-center gap-2">
                      {budget.scope === "turn" ? null : (
                        <span aria-hidden className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
                          <span
                            className={cn(
                              "block h-full",
                              share.share > 0.8 ? "bg-red-500" : share.share > 0.6 ? "bg-amber-500" : "bg-foreground",
                            )}
                            style={{ width: `${Math.min(100, Math.round(share.share * 100))}%` }}
                          />
                        </span>
                      )}
                      <span className="truncate text-muted-foreground tabular-nums">{share.text}</span>
                    </span>
                  </td>
                  <td className={menuCellClass}>
                    <ActionMenu
                      label={`Actions for ${budgetScope(budget)}`}
                      actions={[
                        { label: "Edit…", onSelect: edit },
                        { label: "Remove", onSelect: () => void remove(index), destructive: true, separated: true },
                      ]}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableFrame>
      ) : null}
      <TableNote>
        Costs are the catalog's prices; a custom endpoint's calls count as $0, so cap them in tokens. Export every model
        call with <span className="font-mono">nylorun tenant calls</span>.
      </TableNote>
      {editing !== undefined && list ? (
        <BudgetPanel
          budget={editing === "new" ? undefined : list[editing]}
          manifests={manifests}
          onClose={() => setEditing(undefined)}
          save={(budget) => save(editing === "new" ? [...list, budget] : list.map((each, i) => (i === editing ? budget : each)))}
        />
      ) : null}
    </div>
  );
}

function UsageTable({ totals }: { totals: readonly UsageTotals[] }) {
  return (
    <TableFrame minWidth={640}>
      <thead>
        <tr>
          <th className={`${headClass} w-48`}>Period</th>
          <th className={`${headClass} w-32 text-right`}>Calls</th>
          <th className={`${headClass} w-36 text-right`}>Tokens</th>
          <th className={`${headClass} w-32 text-right`}>Cost</th>
          <th className={`${headClass} pl-8`}>Since</th>
        </tr>
      </thead>
      <tbody>
        {totals.map((total, index) => (
          <tr key={total.period}>
            <td className={cellClass}>{PERIODS[index]![1]}</td>
            <td className={`${cellClass} text-right tabular-nums`}>{total.calls.toLocaleString("en-US")}</td>
            <td className={`${cellClass} text-right tabular-nums`} title={total.tokens.toLocaleString("en-US")}>
              {tokensText(total.tokens)}
            </td>
            <td className={`${cellClass} text-right tabular-nums`}>{formatCost(total.costUsd)}</td>
            <td className={`${cellClass} pl-8 text-muted-foreground`}>
              {total.since ? (
                <time dateTime={total.since} title={fullTime(total.since)}>
                  {shortTime(total.since)}
                </time>
              ) : (
                "Every recorded call"
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}

const selectClass = "h-9 rounded-md border bg-transparent px-3 text-sm";

/** One budget, as a form: what it applies to, over what period, and its caps. */
function BudgetPanel({
  budget,
  manifests,
  onClose,
  save,
}: {
  budget?: ModelBudget;
  manifests: readonly string[];
  onClose: () => void;
  save: (budget: ModelBudget) => Promise<void>;
}) {
  const [scope, setScope] = useState<ModelBudget["scope"]>(budget?.scope ?? "tenant");
  const [id, setId] = useState(budget?.id ?? "");
  const [period, setPeriod] = useState<"day" | "month">(budget?.period ?? "month");
  const [usd, setUsd] = useState(budget?.limitUsd === undefined ? "" : String(budget.limitUsd));
  const [tokens, setTokens] = useState(budget?.limitTokens === undefined ? "" : String(budget.limitTokens));
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const limitUsd = usd.trim() === "" ? undefined : Number(usd.replace(/^\$/u, ""));
    const limitTokens = tokens.trim() === "" ? undefined : Number(tokens.replaceAll(",", ""));
    if (limitUsd !== undefined && !(limitUsd > 0)) return setError("The limit in dollars must be more than 0.");
    if (limitTokens !== undefined && !(Number.isSafeInteger(limitTokens) && limitTokens > 0))
      return setError("The limit in tokens must be a whole number more than 0.");
    if (limitUsd === undefined && limitTokens === undefined) return setError("Set a limit in dollars, in tokens, or both.");
    if (scope === "manifest" && !id.trim()) return setError("Name the manifest the budget applies to.");
    setPending(true);
    try {
      await save({
        scope,
        ...(scope === "manifest" ? { id: id.trim() } : {}),
        ...(scope === "turn" ? {} : { period }),
        ...(limitUsd === undefined ? {} : { limitUsd }),
        ...(limitTokens === undefined ? {} : { limitTokens }),
      });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <SidePanel
      title={budget ? budgetScope(budget) : "New budget"}
      description={budget ? `${budgetPeriod(budget)} · ${budgetLimit(budget)}` : "Caps what model calls may cost"}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="model-budget" disabled={pending}>
            {pending ? "Saving…" : "Save budget"}
          </Button>
        </>
      }
    >
      <form id="model-budget" className="space-y-4" onSubmit={(event) => void submit(event)}>
        <FormField label="Applies to">
          {(props) => (
            <select {...props} className={selectClass} value={scope} onChange={(event) => setScope(event.target.value as ModelBudget["scope"])}>
              <option value="tenant">The Tenant: every model call</option>
              <option value="manifest">One manifest: every Agent made from it</option>
              <option value="turn">Each turn</option>
            </select>
          )}
        </FormField>
        {scope === "manifest" ? (
          <>
            <FormField label="Manifest">
              {(props) => (
                <Input {...props} className="font-mono" list="budget-manifests" value={id} onChange={(event) => setId(event.target.value)} />
              )}
            </FormField>
            <datalist id="budget-manifests">
              {manifests.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </>
        ) : null}
        {scope === "turn" ? null : (
          <FormField label="Period">
            {(props) => (
              <select {...props} className={selectClass} value={period} onChange={(event) => setPeriod(event.target.value as "day" | "month")}>
                <option value="day">Daily, from 00:00 UTC</option>
                <option value="month">Monthly, from the 1st, UTC</option>
              </select>
            )}
          </FormField>
        )}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Limit in dollars">
            {(props) => <Input {...props} inputMode="decimal" placeholder="250" value={usd} onChange={(event) => setUsd(event.target.value)} />}
          </FormField>
          <FormField label="Limit in tokens">
            {(props) => (
              <Input {...props} inputMode="numeric" placeholder="2000000" value={tokens} onChange={(event) => setTokens(event.target.value)} />
            )}
          </FormField>
        </div>
        {error ? (
          <p role="alert" className="text-sm break-words text-red-600">
            {error}
          </p>
        ) : null}
      </form>
    </SidePanel>
  );
}
