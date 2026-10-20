import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  ActionMenu,
  EmptyRow,
  TableFrame,
  TableToolbar,
  cellClass,
  headClass,
  menuCellClass,
  rowClass,
} from "@/components/data-table";
import type { ManagementModels } from "@nylorun/admin/client";
import { createTenantManagementClient } from "@/proxy-client";
import { listFrom } from "@/runtime-body.ts";

type HostModelView = Awaited<ReturnType<ManagementModels["get"]>>;
type CatalogProvider = Awaited<ReturnType<ManagementModels["catalog"]>>["providers"][number];
type ConfiguredProvider = Awaited<
  ReturnType<ManagementModels["providers"]>
>["providers"][number];
/** A custom endpoint's window, output limit, reasoning, inputs and pi-ai compat (Model Calls §7). */
type CustomModelSettings = NonNullable<ConfiguredProvider["settings"]>;
type ModelInput = CatalogProvider["models"][number]["inputs"][number];

/** What a model may read beyond text (protocol 12), in the Runtime's order, with their labels. */
const INPUT_LABELS: ReadonlyArray<readonly [Exclude<ModelInput, "text">, string]> = [
  ["image", "Images"],
  ["pdf", "PDF"],
  ["office", "Office documents"],
  ["audio", "Audio"],
  ["video", "Video"],
];
/** What a custom endpoint may read: an OpenAI-compatible endpoint carries no Office documents. */
const CUSTOM_INPUTS = INPUT_LABELS.filter(([input]) => input !== "office");

/**
 * One connected catalog model's input checkboxes: its catalog's own inputs (its `inputs` less
 * `addableInputs`) checked and fixed, what the operator may add (`addableInputs`) toggled. A
 * type neither is not shown.
 */
function ModelInputs({
  name,
  inputs,
  addableInputs,
  disabled,
  onToggle,
  inline = false,
}: Readonly<{
  name: string;
  inputs: readonly ModelInput[];
  addableInputs: readonly ModelInput[];
  disabled: boolean;
  onToggle?: (input: ModelInput, on: boolean) => void;
  /** In a table cell: one line, with no label of its own. */
  inline?: boolean;
}>) {
  const shown = INPUT_LABELS.filter(
    ([input]) => inputs.includes(input) || addableInputs.includes(input),
  );
  return (
    <div
      role="group"
      aria-label={`${name} inputs`}
      className={
        inline
          ? "flex items-center gap-x-3 overflow-hidden text-xs text-muted-foreground"
          : "mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
      }
    >
      {inline ? null : <span className="font-medium text-foreground">Inputs</span>}
      {shown.length === 0 ? <span>Text only</span> : null}
      {shown.map(([input, label]) => {
        const fixed = !onToggle || !addableInputs.includes(input);
        return (
          <label key={input} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              className="size-3.5"
              checked={inputs.includes(input)}
              disabled={fixed || disabled}
              title={fixed ? "Read by this model" : undefined}
              onChange={(event) => onToggle?.(input, event.target.checked)}
            />
            {label}
          </label>
        );
      })}
    </div>
  );
}

type PanelMode = "add" | "view" | "update";

function formatUpdated(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

export function ModelSettings({ tenantId }: Readonly<{ tenantId: string }>) {
  const models = useMemo(() => createTenantManagementClient(tenantId).models, [tenantId]);
  const [active, setActive] = useState<HostModelView | undefined>();
  const [catalog, setCatalog] = useState<CatalogProvider[]>([]);
  const [providers, setProviders] = useState<ConfiguredProvider[]>([]);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [pending, setPending] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>("add");
  const [provider, setProvider] = useState("custom");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [reasoning, setReasoning] = useState(false);
  const [compat, setCompat] = useState("");
  const [customInputs, setCustomInputs] = useState<readonly ModelInput[]>([]);
  // A custom endpoint's headers (#493), set through the API: the form keeps them on a save.
  const [customHeaders, setCustomHeaders] = useState<Pick<CustomModelSettings, "headers" | "callHeaders">>({});

  const refresh = useCallback(async () => {
    const [next, listed, configured] = await Promise.all([
      models.get(),
      models.catalog(),
      models.providers(),
    ]);
    const message = "The Runtime did not return model settings.";
    setActive(next);
    setCatalog([
      ...listFrom<CatalogProvider>(listed, "providers", message),
      { id: "custom", name: "Custom OpenAI-compatible", models: [] },
    ]);
    setProviders(listFrom<ConfiguredProvider>(configured, "providers", message));
  }, [models]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await refresh();
        if (!cancelled) setError("");
      } catch (cause) {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const selected = catalog.find((item) => item.id === provider);
  const custom = provider === "custom";
  const configuredIds = new Set(providers.map((item) => item.id));
  const addable = catalog.filter(
    (item) => item.id === "custom" || !configuredIds.has(item.id),
  );

  function openPanel(mode: PanelMode, next?: ConfiguredProvider) {
    setError("");
    setSaved("");
    setApiKey("");
    setPanelMode(mode);
    if (next) {
      setProvider(next.id);
      setModel(next.model);
      setBaseUrl(next.baseUrl ?? "");
      setContextWindow(next.settings?.contextWindow?.toString() ?? "");
      setMaxTokens(next.settings?.maxTokens?.toString() ?? "");
      setReasoning(next.settings?.reasoning ?? false);
      setCompat(next.settings?.compat ? JSON.stringify(next.settings.compat) : "");
      setCustomInputs(next.settings?.inputs ?? []);
      setCustomHeaders({
        ...(next.settings?.headers ? { headers: next.settings.headers } : {}),
        ...(next.settings?.callHeaders ? { callHeaders: next.settings.callHeaders } : {}),
      });
    } else {
      const first = addable[0];
      setProvider(first?.id ?? "custom");
      setModel(first?.models[0]?.id ?? "");
      setBaseUrl("");
      setContextWindow("");
      setMaxTokens("");
      setReasoning(false);
      setCompat("");
      setCustomInputs([]);
      setCustomHeaders({});
    }
    setPanelOpen(true);
  }

  async function saveCredential(event: FormEvent) {
    event.preventDefault();
    if (panelMode === "view") return;
    setError("");
    setSaved("");
    setPending(true);
    const key = apiKey;
    try {
      const settings = custom ? customSettings() : undefined;
      const body = await models.put({
        idempotencyKey: crypto.randomUUID(),
        provider,
        model,
        ...(custom && baseUrl ? { baseUrl } : {}),
        ...(settings ? { settings } : {}),
        auth: { type: "api_key", key },
      });
      if (JSON.stringify(body).includes(key))
        throw new Error("The Runtime returned the provider key.");
      await refresh();
      setApiKey("");
      setPanelOpen(false);
      setSaved(
        body.configured
          ? `Saved ${body.provider} / ${body.model}. Credentials stay in the Runtime vault.`
          : "Saved.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  /** The custom endpoint's settings from the form, or undefined when none is set. */
  function customSettings(): CustomModelSettings | undefined {
    const settings: CustomModelSettings = { ...customHeaders };
    const whole = (label: string, value: string) => {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1)
        throw new Error(`${label} must be a whole number of tokens.`);
      return number;
    };
    if (contextWindow.trim())
      settings.contextWindow = whole("Context window", contextWindow.trim());
    if (maxTokens.trim()) settings.maxTokens = whole("Max output tokens", maxTokens.trim());
    if (reasoning) settings.reasoning = true;
    const inputs = CUSTOM_INPUTS.map(([input]) => input).filter((input) =>
      customInputs.includes(input),
    );
    if (inputs.length) settings.inputs = inputs;
    if (compat.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(compat);
      } catch {
        throw new Error("Compatibility settings must be a JSON object.");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Compatibility settings must be a JSON object.");
      settings.compat = parsed as Record<string, unknown>;
    }
    return Object.keys(settings).length ? settings : undefined;
  }

  /** Adds or removes one input the operator may add to a catalog model, then reloads. */
  async function toggleInput(
    item: ConfiguredProvider,
    current: readonly ModelInput[],
    input: ModelInput,
    on: boolean,
  ) {
    setError("");
    setSaved("");
    setPending(true);
    try {
      const next = new Set(current.filter((each) => each !== input));
      if (on) next.add(input);
      await models.setInputs({
        provider: item.id,
        model: item.model,
        inputs: (["text", ...INPUT_LABELS.map(([each]) => each)] as ModelInput[]).filter(
          (each) => next.has(each),
        ),
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  async function activateSelection(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSaved("");
    setPending(true);
    try {
      const body = await models.select({
        idempotencyKey: crypto.randomUUID(),
        provider,
        model,
        ...(custom && baseUrl ? { baseUrl } : {}),
      });
      await refresh();
      setPanelOpen(false);
      setSaved(
        body.configured
          ? `Active provider is ${body.provider} / ${body.model}.`
          : "Selection saved.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  /**
   * A connected provider's "Inputs" line for its selected model: a catalog model's checkboxes, or
   * what a custom endpoint reads (set in its settings). None from a Runtime before protocol 12.
   */
  function rowInputs(item: ConfiguredProvider) {
    if (item.baseUrl) {
      const inputs = item.inputs ?? item.settings?.inputs;
      if (!inputs) return null;
      return (
        <ModelInputs name={item.name} inputs={inputs} addableInputs={[]} disabled={pending} />
      );
    }
    const listed = catalog
      .find((each) => each.id === item.id)
      ?.models.find((each) => each.id === item.model);
    if (!listed || !Array.isArray(listed.inputs) || !Array.isArray(listed.addableInputs))
      return null;
    // The catalog's `inputs` already holds the operator's additions.
    const inputs = item.inputs ?? listed.inputs;
    return (
      <ModelInputs
        name={item.name}
        inputs={inputs}
        addableInputs={listed.addableInputs}
        disabled={pending}
        onToggle={(input, on) => void toggleInput(item, inputs, input, on)}
        inline
      />
    );
  }

  const panelTitle =
    panelMode === "add"
      ? "Add provider"
      : panelMode === "update"
        ? "Update credentials"
        : "Provider details";

  return (
    <div>
      <TableToolbar>
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          {active?.configured ? (
            <>
              Runs <span className="text-foreground">{active.provider} · {active.model}</span>. Credentials stay
              in the Runtime vault.
            </>
          ) : (
            "Connect one or more model providers. Credentials stay in the Runtime vault."
          )}
        </span>
        <span className="ml-auto" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" disabled={addable.length === 0}>
              <Plus />
              Add Provider
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            {addable.map((item) => (
              <DropdownMenuItem
                key={item.id}
                onSelect={() => {
                  setProvider(item.id);
                  setModel(item.models[0]?.id ?? "");
                  setBaseUrl("");
                  setApiKey("");
                  setCustomInputs([]);
                  setPanelMode("add");
                  setPanelOpen(true);
                }}
              >
                {item.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableToolbar>

      {error && !panelOpen ? (
        <p role="alert" className="border-b px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {saved ? <p className="border-b px-4 py-2 text-sm text-muted-foreground">{saved}</p> : null}

      <TableFrame minWidth={760}>
        <thead>
          <tr>
            <th className={`${headClass} w-[20%]`}>Provider</th>
            <th className={`${headClass} w-[22%]`}>Model</th>
            <th className={headClass}>Inputs</th>
            <th className={`${headClass} w-44`}>Updated</th>
            <th className={`${headClass} w-12`}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {providers.length === 0 ? <EmptyRow columns={5}>No providers configured yet.</EmptyRow> : null}
          {providers.map((item) => (
            <tr key={item.id} className={rowClass} data-state={item.active ? "selected" : undefined}>
              <td className={cellClass} title={item.name}>
                <span className="font-medium">{item.name}</span>
                {item.active ? (
                  <Badge variant="outline" className="ml-2">
                    Active
                  </Badge>
                ) : null}
              </td>
              <td className={`${cellClass} font-mono text-[13px]`} title={item.model}>
                {item.model}
                {item.authType === "oauth" ? <span className="font-sans text-muted-foreground"> · OAuth</span> : null}
              </td>
              <td className={cellClass}>{rowInputs(item) ?? <span className="text-muted-foreground">—</span>}</td>
              <td className={`${cellClass} text-muted-foreground`}>{formatUpdated(item.lastUpdated)}</td>
              <td className={menuCellClass}>
                <ActionMenu
                  label={`${item.name} actions`}
                  actions={[
                    { label: "View", onSelect: () => openPanel("view", item) },
                    { label: "Update credentials", onSelect: () => openPanel("update", item) },
                  ]}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </TableFrame>

      <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{panelTitle}</SheetTitle>
            <SheetDescription>
              {panelMode === "view"
                ? "Review the configured provider and choose the active model. Secrets are never shown."
                : "The Runtime encrypts this credential in the host vault. Studio never keeps a copy."}
            </SheetDescription>
          </SheetHeader>
          <form
            className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4"
            onSubmit={(event) =>
              void (panelMode === "view"
                ? activateSelection(event)
                : saveCredential(event))
            }
          >
            <label className="grid gap-1 text-sm">
              Provider
              {panelMode === "add" ? (
                <select
                  className="h-9 rounded-md border bg-transparent px-3"
                  value={provider}
                  onChange={(event) => {
                    const next = event.target.value;
                    setProvider(next);
                    const match = catalog.find((item) => item.id === next);
                    setModel(match?.models[0]?.id ?? "");
                    if (next !== "custom") setBaseUrl("");
                  }}
                >
                  {addable.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  value={
                    catalog.find((item) => item.id === provider)?.name ??
                    provider
                  }
                  readOnly
                />
              )}
            </label>
            {custom ? (
              <>
                <label className="grid gap-1 text-sm">
                  Base URL
                  <Input
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="api.example.test/v1"
                    required
                    readOnly={panelMode === "view"}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  Model id
                  <Input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    required
                    readOnly={panelMode === "view" ? false : undefined}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  Context window (tokens)
                  <Input
                    value={contextWindow}
                    onChange={(event) => setContextWindow(event.target.value)}
                    placeholder="32768"
                    inputMode="numeric"
                    readOnly={panelMode === "view"}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  Max output tokens
                  <Input
                    value={maxTokens}
                    onChange={(event) => setMaxTokens(event.target.value)}
                    placeholder="8192"
                    inputMode="numeric"
                    readOnly={panelMode === "view"}
                  />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={reasoning}
                    onChange={(event) => setReasoning(event.target.checked)}
                    disabled={panelMode === "view"}
                  />
                  The model reasons (thinking)
                </label>
                <fieldset className="grid gap-1.5 text-sm">
                  <legend className="mb-1.5">Inputs beyond text</legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {CUSTOM_INPUTS.map(([input, label]) => (
                      <label key={input} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={customInputs.includes(input)}
                          onChange={(event) =>
                            setCustomInputs((current) =>
                              event.target.checked
                                ? [...current, input]
                                : current.filter((each) => each !== input),
                            )
                          }
                          disabled={panelMode === "view"}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="grid gap-1 text-sm">
                  Compatibility settings (JSON, optional)
                  <Input
                    value={compat}
                    onChange={(event) => setCompat(event.target.value)}
                    placeholder='{"thinkingFormat":"qwen-chat-template"}'
                    readOnly={panelMode === "view"}
                  />
                </label>
              </>
            ) : (
              <label className="grid gap-1 text-sm">
                Model
                <select
                  className="h-9 rounded-md border bg-transparent px-3"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  required
                >
                  {(selected?.models ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {panelMode === "view" ? (
              <p className="text-sm text-muted-foreground">
                Authentication:{" "}
                {providers.find((item) => item.id === provider)?.authType ===
                "oauth"
                  ? "OAuth"
                  : "API key"}
                . Secret values are not returned by the Runtime.
              </p>
            ) : (
              <label className="grid gap-1 text-sm">
                API key
                <Input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  required
                />
              </label>
            )}
            {error && panelOpen ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <SheetFooter className="px-0">
              <Button type="submit" disabled={pending}>
                {pending
                  ? "Saving"
                  : panelMode === "view"
                    ? "Use provider"
                    : panelMode === "update"
                      ? "Update credentials"
                      : "Save provider"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  );
}
