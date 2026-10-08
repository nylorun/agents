import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ManagementModels } from "@nylorun/admin/client";
import { createTenantManagementClient } from "@/proxy-client";
import { listFrom } from "@/runtime-body.ts";

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
  baseUrl?: string;
  active: boolean;
};

function optionKey(providerId: string, modelId: string): string {
  return `${providerId}\0${modelId}`;
}

export function SessionModelPicker({
  tenantId,
  disabled = false,
  className,
}: Readonly<{
  tenantId: string;
  disabled?: boolean;
  className?: string;
}>) {
  const api = useMemo(() => createTenantManagementClient(tenantId).models, [tenantId]);
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<HostModelProviderInfo[]>([]);
  const [catalog, setCatalog] = useState<CatalogProvider[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [connected, listed] = await Promise.all([api.providers(), api.catalog()]);
    const message = "The Runtime did not return connected model providers.";
    setProviders(listFrom<HostModelProviderInfo>(connected, "providers", message));
    setCatalog(listFrom<CatalogProvider>(listed, "providers", message));
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await refresh();
        if (!cancelled) {
          setError("");
          setLoading(false);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const options = useMemo(() => {
    const catalogById = new Map(catalog.map((item) => [item.id, item]));
    const next: ModelOption[] = [];
    for (const provider of providers) {
      const listed = catalogById.get(provider.id);
      const models =
        listed && Array.isArray(listed.models) && listed.models.length > 0
          ? listed.models
          : [{ id: provider.model, name: provider.model }];
      for (const model of models) {
        next.push({
          key: optionKey(provider.id, model.id),
          providerId: provider.id,
          providerName: provider.name,
          modelId: model.id,
          modelName: model.name,
          ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
          active: provider.active && provider.model === model.id,
        });
      }
    }
    return next;
  }, [catalog, providers]);

  const active = options.find((item) => item.active) ?? options[0];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(
      (item) =>
        item.modelName.toLowerCase().includes(needle) ||
        item.modelId.toLowerCase().includes(needle) ||
        item.providerName.toLowerCase().includes(needle) ||
        item.providerId.toLowerCase().includes(needle),
    );
  }, [options, query]);

  async function selectOption(option: ModelOption) {
    if (option.active || pending) return;
    setPending(true);
    setError("");
    try {
      await api.select({
        idempotencyKey: crypto.randomUUID(),
        provider: option.providerId,
        model: option.modelId,
        ...(option.baseUrl ? { baseUrl: option.baseUrl } : {}),
      });
      await refresh();
      setOpen(false);
      setQuery("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  const empty = !loading && options.length === 0;
  const label = loading
    ? "Loading models"
    : empty
      ? "No providers connected"
      : (active?.modelName ?? "Select model");

  return (
    <div className={cn("min-w-0", className)}>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || loading || pending || empty}
            className="h-8 max-w-full gap-2 px-2.5 font-normal"
            aria-label="Select model and provider"
          >
            {pending || loading ? (
              <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
            ) : null}
            <span className="min-w-0 truncate">{label}</span>
            {active && !empty ? (
              <span className="truncate text-muted-foreground">
                {active.providerName}
              </span>
            ) : null}
            <ChevronDown className="size-3.5 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-80 p-0"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <div
            className="border-b p-2"
            onPointerDown={(event) => event.preventDefault()}
          >
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models"
              aria-label="Search models"
              autoFocus
              className="h-8"
            />
          </div>
          <div className="max-h-64 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-sm text-muted-foreground">
                No matching models
              </p>
            ) : (
              filtered.map((option) => (
                <DropdownMenuItem
                  key={option.key}
                  disabled={pending}
                  className="flex items-center justify-between gap-3"
                  onSelect={(event) => {
                    event.preventDefault();
                    void selectOption(option);
                  }}
                >
                  <span className="min-w-0 truncate">{option.modelName}</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                    <span className="max-w-28 truncate text-xs">
                      {option.providerName}
                    </span>
                    {option.active ? (
                      <Check className="size-3.5" aria-hidden />
                    ) : (
                      <span className="size-3.5" aria-hidden />
                    )}
                  </span>
                </DropdownMenuItem>
              ))
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {empty && !error ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Connect a provider in Model Settings.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1.5 text-[11px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
