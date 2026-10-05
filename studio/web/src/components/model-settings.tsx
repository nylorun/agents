import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { tenantRuntime } from "@/proxy-client";

type HostModelView =
  | { configured: false }
  | {
      configured: true;
      provider: string;
      model: string;
      authType: "api_key" | "oauth";
      baseUrl?: string;
      settings?: CustomModelSettings;
    };

/** A custom endpoint's window, output limit, reasoning and pi-ai compat (Model Calls §7). */
type CustomModelSettings = {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  compat?: Record<string, unknown>;
};

type CatalogProvider = {
  id: string;
  name: string;
  models: { id: string; name: string }[];
};

type ConfiguredProvider = {
  id: string;
  name: string;
  model: string;
  authType: "api_key" | "oauth";
  baseUrl?: string;
  settings?: CustomModelSettings;
  lastUpdated: string;
  active: boolean;
};

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
  const runtime = useMemo(() => tenantRuntime(tenantId), [tenantId]);
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

  const refresh = useCallback(async () => {
    const [modelResponse, catalogResponse, providersResponse] =
      await Promise.all([
        runtime("/v1/tenant/model"),
        runtime("/v1/tenant/models"),
        runtime("/v1/tenant/providers"),
      ]);
    if (!modelResponse.ok || !catalogResponse.ok || !providersResponse.ok)
      throw new Error("The Runtime did not return model settings.");
    const next = (await modelResponse.json()) as HostModelView;
    const listed = (await catalogResponse.json()) as {
      providers: CatalogProvider[];
    };
    const configured = (await providersResponse.json()) as {
      providers: ConfiguredProvider[];
    };
    setActive(next);
    setCatalog([
      ...listed.providers,
      { id: "custom", name: "Custom OpenAI-compatible", models: [] },
    ]);
    setProviders(configured.providers);
  }, [runtime]);

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
    } else {
      const first = addable[0];
      setProvider(first?.id ?? "custom");
      setModel(first?.models[0]?.id ?? "");
      setBaseUrl("");
      setContextWindow("");
      setMaxTokens("");
      setReasoning(false);
      setCompat("");
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
      const response = await runtime("/v1/tenant/model", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(),
          provider,
          model,
          ...(custom && baseUrl ? { baseUrl } : {}),
          ...(settings ? { settings } : {}),
          auth: { type: "api_key", key },
        }),
      });
      const body = (await response.json()) as HostModelView & {
        message?: string;
      };
      if (!response.ok)
        throw new Error(
          body.message ?? "The Runtime rejected the model provider.",
        );
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
    const settings: CustomModelSettings = {};
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

  async function activateSelection(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSaved("");
    setPending(true);
    try {
      const response = await runtime("/v1/tenant/model/selection", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(),
          provider,
          model,
          ...(custom && baseUrl ? { baseUrl } : {}),
        }),
      });
      const body = (await response.json()) as HostModelView & {
        message?: string;
      };
      if (!response.ok)
        throw new Error(
          body.message ?? "The Runtime rejected the provider selection.",
        );
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

  const panelTitle =
    panelMode === "add"
      ? "Add provider"
      : panelMode === "update"
        ? "Update credentials"
        : "Provider details";

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 overflow-auto p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Models</h1>
          <p className="mt-2 text-muted-foreground">
            {active?.configured
              ? `Active: ${active.provider} / ${active.model}. Credentials stay in the Runtime vault.`
              : "Connect one or more model providers. Credentials stay in the Runtime vault."}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button disabled={addable.length === 0}>
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
                  setPanelMode("add");
                  setPanelOpen(true);
                }}
              >
                {item.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {error && !panelOpen ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {saved ? <p className="text-sm text-muted-foreground">{saved}</p> : null}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Last Updated</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providers.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={3}
                  className="h-24 text-center text-muted-foreground"
                >
                  No providers configured yet.
                </TableCell>
              </TableRow>
            ) : (
              providers.map((item) => (
                <TableRow key={item.id} data-state={item.active ? "selected" : undefined}>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{item.name}</span>
                      {item.active ? <Badge variant="outline">Active</Badge> : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.model}
                      {item.authType === "oauth" ? " · OAuth" : ""}
                    </p>
                  </TableCell>
                  <TableCell>{formatUpdated(item.lastUpdated)}</TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${item.name} actions`}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() => openPanel("view", item)}
                        >
                          View
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => openPanel("update", item)}
                        >
                          Update credentials
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

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
            className="flex flex-1 flex-col gap-4 px-4"
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
              <p role="alert" className="text-sm text-red-600">
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
    </section>
  );
}
