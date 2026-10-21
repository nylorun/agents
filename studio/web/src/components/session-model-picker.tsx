import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ManagementModels } from "@nylorun/admin/client";
import type { SessionModelView } from "@nylorun/agents";
import { createTenantClient, createTenantManagementClient } from "@/proxy-client";
import { listFrom } from "@/runtime-body.ts";
import { tenantPath } from "@/agent-path";

type HostModelProviderInfo = Awaited<
  ReturnType<ManagementModels["providers"]>
>["providers"][number];
type CatalogProvider = Awaited<ReturnType<ManagementModels["catalog"]>>["providers"][number];

type ModelOption = {
  key: string;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  /** What the model reads (protocol 12); absent from an older Runtime. */
  inputs?: readonly string[];
};

/** The Host feature the picker needs: a session's own model. */
const SESSION_MODEL = "session-model";

function optionKey(providerId: string, modelId: string): string {
  return `${providerId}\0${modelId}`;
}

const INPUT_NAMES: Readonly<Record<string, string>> = {
  image: "images",
  pdf: "PDFs",
  office: "Office files",
  audio: "audio",
  video: "video",
};

/** What a model reads besides text, for its menu item: attachments depend on it. */
function readsText(inputs: readonly string[] | undefined): string | undefined {
  if (!inputs) return undefined;
  const files = inputs.filter((input) => input !== "text").map((input) => INPUT_NAMES[input] ?? input);
  return files.length === 0 ? "Text only" : `Reads ${files.join(", ")}`;
}

/** Keys the menu acts on; every other key types into the search box, never Radix's typeahead. */
const MENU_KEYS = new Set(["ArrowDown", "ArrowUp", "Escape", "Tab"]);

/**
 * The model this session's turns use, under its message box (Host feature `session-model`).
 * Choosing one sets it on the session only: the Tenant's model, which every other session uses,
 * is changed on the Tenant page's Models tab. "Tenant model" clears the session's choice. A turn
 * calls one model, so the picker is locked while one runs or waits. A Runtime without the
 * feature shows no picker.
 */
export function SessionModelPicker({
  tenantId,
  sessionId,
  disabled = false,
  className,
}: Readonly<{
  tenantId: string;
  sessionId: string;
  disabled?: boolean;
  className?: string;
}>) {
  const models = useMemo(() => createTenantManagementClient(tenantId).models, [tenantId]);
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const [open, setOpen] = useState(false);
  const [supported, setSupported] = useState<boolean | undefined>();
  const [providers, setProviders] = useState<HostModelProviderInfo[]>([]);
  const [catalog, setCatalog] = useState<CatalogProvider[]>([]);
  const [current, setCurrent] = useState<SessionModelView | undefined>();
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    if (!(await sdk.hostFeatures()).includes(SESSION_MODEL)) return false;
    const [connected, listed, chosen] = await Promise.all([
      models.providers(),
      models.catalog(),
      sdk.session(sessionId).model(),
    ]);
    const message = "The Runtime did not return connected model providers.";
    setProviders(listFrom<HostModelProviderInfo>(connected, "providers", message));
    setCatalog(listFrom<CatalogProvider>(listed, "providers", message));
    setCurrent(chosen);
    return true;
  }, [models, sdk, sessionId]);

  useEffect(() => {
    let cancelled = false;
    setSupported(undefined);
    void (async () => {
      try {
        const found = await refresh();
        if (!cancelled) {
          setError("");
          setSupported(found);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setSupported(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Each connected provider's models, by provider; its own model when its catalog lists none.
  const groups = useMemo(() => {
    const catalogById = new Map(catalog.map((item) => [item.id, item]));
    return providers.map((provider) => {
      const listed = catalogById.get(provider.id);
      const listedModels: ReadonlyArray<{ id: string; name: string; inputs?: readonly string[] }> =
        listed && Array.isArray(listed.models) && listed.models.length > 0
          ? listed.models
          : [{ id: provider.model, name: provider.model }];
      return {
        id: provider.id,
        name: provider.name,
        options: listedModels.map((model): ModelOption => {
          // The provider reports its selected model's inputs, overrides included; the catalog, each model's.
          const inputs = (provider.model === model.id ? provider.inputs : undefined) ?? model.inputs;
          return {
            key: optionKey(provider.id, model.id),
            providerId: provider.id,
            providerName: provider.name,
            modelId: model.id,
            modelName: model.name,
            ...(inputs ? { inputs } : {}),
          };
        }),
      };
    });
  }, [catalog, providers]);

  const options = useMemo(() => groups.flatMap((group) => group.options), [groups]);
  const named = (provider: string, model: string) =>
    options.find((item) => item.providerId === provider && item.modelId === model);
  const inForce = current?.configured ? current : undefined;
  const selectedKey = inForce?.source === "session" ? optionKey(inForce.provider, inForce.model) : undefined;
  const tenantProvider = providers.find((provider) => provider.active);
  const tenantModel = tenantProvider
    ? (named(tenantProvider.id, tenantProvider.model)?.modelName ?? tenantProvider.model)
    : undefined;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groups;
    return groups
      .map((group) => ({
        ...group,
        options: group.options.filter(
          (item) =>
            item.modelName.toLowerCase().includes(needle) ||
            item.modelId.toLowerCase().includes(needle) ||
            item.providerName.toLowerCase().includes(needle) ||
            item.providerId.toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.options.length > 0);
  }, [groups, query]);

  async function choose(option: ModelOption | undefined) {
    if (pending) return;
    if (option ? option.key === selectedKey : inForce?.source !== "session" && !current?.choice) {
      setOpen(false);
      return;
    }
    setPending(true);
    setError("");
    try {
      const session = sdk.session(sessionId);
      setCurrent(
        option
          ? await session.setModel({ provider: option.providerId, model: option.modelId })
          : await session.clearModel(),
      );
      setOpen(false);
      setQuery("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  function keepTyping(event: KeyboardEvent<HTMLInputElement>) {
    if (!MENU_KEYS.has(event.key)) event.stopPropagation();
  }

  if (supported === false) return null;
  const loading = supported === undefined;
  const empty = !loading && !error && providers.length === 0;
  const shown = inForce && named(inForce.provider, inForce.model);
  const label = loading
    ? "Loading models"
    : empty
      ? "No providers connected"
      : inForce
        ? (shown?.modelName ?? inForce.model)
        : "Select model";
  const provider = inForce ? (shown?.providerName ?? inForce.provider) : undefined;
  // A choice whose provider was disconnected: the session uses the Tenant's model meanwhile.
  const stale =
    current?.choice && inForce?.source !== "session"
      ? `${current.choice.model} (${current.choice.provider}) is not connected: this session uses the Tenant model`
      : undefined;

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
          // Read again on each open: a provider connected on the Tenant page shows without a reload.
          else
            void refresh().catch((cause: unknown) =>
              setError(cause instanceof Error ? cause.message : String(cause)),
            );
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || loading || pending || empty}
            className="min-w-0 max-w-full gap-1.5 px-2 text-xs font-normal"
            aria-label="This session's model"
            title={
              disabled
                ? "The model changes between turns"
                : inForce?.source === "tenant"
                  ? "This session uses the Tenant model"
                  : "This session's own model"
            }
          >
            {pending || loading ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : null}
            <span className="min-w-0 truncate">{label}</span>
            {provider && !empty ? <span className="truncate text-muted-foreground">{provider}</span> : null}
            {inForce?.source === "tenant" && !empty ? (
              <span className="shrink-0 text-muted-foreground">· Tenant model</span>
            ) : null}
            <ChevronDown className="size-3.5 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-80 p-0"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <div className="border-b p-2" onPointerDown={(event) => event.preventDefault()}>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={keepTyping}
              placeholder="Search models"
              aria-label="Search models"
              autoFocus
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {!query.trim() ? (
              <>
                <DropdownMenuItem
                  disabled={pending}
                  className="flex items-center justify-between gap-3"
                  onSelect={(event) => {
                    event.preventDefault();
                    void choose(undefined);
                  }}
                >
                  <span className="min-w-0 truncate">Tenant model</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                    {tenantModel ? <span className="max-w-36 truncate text-xs">{tenantModel}</span> : null}
                    <Check
                      className={cn("size-3.5", selectedKey === undefined ? "opacity-100" : "opacity-0")}
                      aria-hidden
                    />
                  </span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-sm text-muted-foreground">No matching models</p>
            ) : (
              filtered.map((group) => (
                <div key={group.id} role="group" aria-label={group.name}>
                  <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                    {group.name}
                  </DropdownMenuLabel>
                  {group.options.map((option) => (
                    <DropdownMenuItem
                      key={option.key}
                      disabled={pending}
                      className="flex items-center justify-between gap-3"
                      onSelect={(event) => {
                        event.preventDefault();
                        void choose(option);
                      }}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{option.modelName}</span>
                        {readsText(option.inputs) ? (
                          <span className="truncate text-xs text-muted-foreground">{readsText(option.inputs)}</span>
                        ) : null}
                      </span>
                      <Check
                        className={cn("size-3.5 shrink-0", option.key === selectedKey ? "opacity-100" : "opacity-0")}
                        aria-hidden
                      />
                    </DropdownMenuItem>
                  ))}
                </div>
              ))
            )}
          </div>
          <p className="border-t px-3 py-2 text-xs text-muted-foreground">
            Applies to this session only. The Tenant model is set on the{" "}
            <Link to={tenantPath("models")} className="underline underline-offset-4 hover:text-foreground">
              Tenant page
            </Link>
            .
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
      {empty ? (
        <span className="truncate text-xs text-muted-foreground">
          Connect a provider on the{" "}
          <Link to={tenantPath("models")} className="underline underline-offset-4 hover:text-foreground">
            Tenant page's Models tab
          </Link>
          .
        </span>
      ) : null}
      {stale && !error ? (
        <span className="truncate text-xs text-muted-foreground" title={stale}>
          {stale}
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="truncate text-xs text-destructive" title={error}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
