import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { CredentialInfo, VaultInfo } from "@nylorun/agents";
import { KeyRound, MoreHorizontal, Plus, Trash2 } from "lucide-react";
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
import { createTenantManagementClient } from "@/proxy-client";
import { listFrom } from "@/runtime-body.ts";

const SECRET_MASK = "••••••••••••••••";

type PanelMode = "add-vault" | "add-credential" | "view" | "update" | "delete" | "preview";

type Row = {
  vault: VaultInfo;
  credential: CredentialInfo;
};

type CredentialType = CredentialInfo["type"];

/** One row of a Headers credential's form. */
type HeaderRow = { name: string; value: string };

const TYPE_LABELS: Record<CredentialType, string> = {
  bearer: "Bearer",
  headers: "Headers",
};

/** True when the Runtime's answer contains one of the secrets just sent. */
function leaks(info: unknown, secrets: readonly string[]): boolean {
  const text = JSON.stringify(info);
  return secrets.some((value) => value.length >= 8 && text.includes(value));
}

const client = (tenantId: string) => createTenantManagementClient(tenantId);

/** What the Runtime found behind a credential's URL (R2b C12). */
type McpPreview = Awaited<ReturnType<ReturnType<typeof client>["mcp"]["preview"]>>;

/** A tool's annotations, as a few words. */
function toolHints(annotations: Record<string, unknown> | undefined): string {
  const hints = [
    annotations?.readOnlyHint === true ? "read-only" : undefined,
    annotations?.destructiveHint === true ? "destructive" : undefined,
    annotations?.idempotentHint === true ? "idempotent" : undefined,
  ].filter(Boolean);
  return hints.join(", ");
}

function formatWhen(value?: string): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

/** The Management client's errors carry the Runtime's message. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function VaultModule({ tenantId }: Readonly<{ tenantId: string }>) {
  const [vaults, setVaults] = useState<VaultInfo[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [selectedVaultId, setSelectedVaultId] = useState<string>("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [pending, setPending] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>("add-credential");
  const [active, setActive] = useState<Row | undefined>();
  const [vaultName, setVaultName] = useState("");
  const [credentialName, setCredentialName] = useState("");
  const [bindingUrl, setBindingUrl] = useState("");
  const [credentialType, setCredentialType] = useState<CredentialType>("bearer");
  const [secret, setSecret] = useState("");
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([{ name: "", value: "" }]);
  const [via, setVia] = useState("");
  const [identityHeader, setIdentityHeader] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [preview, setPreview] = useState<McpPreview | undefined>();

  const refresh = useCallback(async () => {
    const sdk = client(tenantId);
    const nextVaults = listFrom<VaultInfo>(
      { vaults: await sdk.vaults.list() },
      "vaults",
      "The Runtime did not return the Tenant's vaults.",
    );
    setVaults(nextVaults);
    setSelectedVaultId((current) =>
      current && nextVaults.some((vault) => vault.id === current)
        ? current
        : (nextVaults[0]?.id ?? ""),
    );
    if (nextVaults.length === 0) {
      setRows([]);
      return;
    }
    const credentials = await Promise.all(
      nextVaults.map(async (vault) => {
        const listedCredentials = listFrom<CredentialInfo>(
          { credentials: await sdk.vaults.credentials.list(vault.id) },
          "credentials",
          "The Runtime did not return the vault's credentials.",
        );
        return listedCredentials.map((credential) => ({
          vault,
          credential,
        }));
      }),
    );
    setRows(credentials.flat());
  }, [tenantId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await refresh();
        if (!cancelled) setError("");
      } catch (cause) {
        if (!cancelled) setError(messageOf(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const visible = selectedVaultId
    ? rows.filter((row) => row.vault.id === selectedVaultId)
    : rows;
  const selectedVault = vaults.find((vault) => vault.id === selectedVaultId);

  function resetForm() {
    setVaultName("");
    setCredentialName("");
    setBindingUrl("");
    setCredentialType("bearer");
    setSecret("");
    setHeaderRows([{ name: "", value: "" }]);
    setVia("");
    setIdentityHeader("");
    setConfirmName("");
    setPreview(undefined);
    setActive(undefined);
  }

  function setHeaderRow(index: number, patch: Partial<HeaderRow>) {
    setHeaderRows((current) =>
      current.map((row, at) => (at === index ? { ...row, ...patch } : row)),
    );
  }

  /** The form's header map; refuses an empty or repeated name. */
  function headerMap(): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const row of headerRows) {
      const name = row.name.trim();
      if (!name) throw new Error("Each header needs a name.");
      if (Object.keys(headers).some((seen) => seen.toLowerCase() === name.toLowerCase()))
        throw new Error(`The header ${name} is listed twice.`);
      headers[name] = row.value;
    }
    if (Object.keys(headers).length === 0) throw new Error("Add at least one header.");
    return headers;
  }

  function openPanel(mode: PanelMode, row?: Row) {
    setError("");
    setSaved("");
    resetForm();
    setPanelMode(mode);
    setActive(row);
    if (row) {
      setCredentialName(row.credential.name);
      setBindingUrl(row.credential.binding.url);
      setCredentialType(row.credential.type);
      setHeaderRows(
        (row.credential.headerNames ?? [""]).map((name) => ({ name, value: "" })),
      );
      setVia(row.credential.via ?? "");
      setIdentityHeader(row.credential.identity?.header ?? "");
    }
    setPanelOpen(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSaved("");
    setPending(true);
    const sdk = client(tenantId);
    const secretValue = secret;
    const routing = {
      ...(via.trim() ? { via: via.trim() } : {}),
      ...(identityHeader.trim() ? { identity: { header: identityHeader.trim() } } : {}),
    };
    try {
      if (panelMode === "add-vault") {
        await sdk.vaults.create({
          name: vaultName.trim(),
          scope: "installation",
          idempotencyKey: crypto.randomUUID(),
        });
        setSaved(`Created vault “${vaultName.trim()}”.`);
      } else if (panelMode === "add-credential") {
        if (!selectedVaultId) throw new Error("Create a vault first.");
        const url = bindingUrl.trim();
        const headers = credentialType === "headers" ? headerMap() : undefined;
        const created = await sdk.vaults.credentials.create(selectedVaultId, {
          name: credentialName.trim(),
          idempotencyKey: crypto.randomUUID(),
          auth: headers
            ? { type: "headers", url, headers, ...routing }
            : { type: "bearer", url, token: secretValue, ...routing },
        });
        if (leaks(created, headers ? Object.values(headers) : [secretValue]))
          throw new Error("The Runtime returned the credential secret.");
        setSaved(
          `Saved “${created.name}”. Secrets stay encrypted in the Runtime vault.`,
        );
      } else if (panelMode === "update" && active) {
        // Rotation keeps the gateway and identity header unless the form changed them; a
        // cleared field removes them.
        const change = {
          ...(via.trim() !== (active.credential.via ?? "")
            ? { via: via.trim() || null }
            : {}),
          ...(identityHeader.trim() !== (active.credential.identity?.header ?? "")
            ? { identity: identityHeader.trim() ? { header: identityHeader.trim() } : null }
            : {}),
        };
        const headers = active.credential.type === "headers" ? headerMap() : undefined;
        const updated = await sdk.vaults.credentials.rotate(
          active.vault.id,
          active.credential.id,
          {
            idempotencyKey: crypto.randomUUID(),
            auth: headers
              ? { type: "headers", headers, ...change }
              : { type: "bearer", token: secretValue, ...change },
          },
        );
        if (leaks(updated, headers ? Object.values(headers) : [secretValue]))
          throw new Error("The Runtime returned the credential secret.");
        setSaved(`Rotated “${updated.name}”.`);
      } else if (panelMode === "delete" && active) {
        if (confirmName.trim() !== active.credential.name)
          throw new Error("Type the credential name to confirm deletion.");
        await sdk.vaults.credentials.delete(active.vault.id, active.credential.id);
        setSaved(`Deleted “${active.credential.name}”.`);
      } else if (panelMode === "view" || panelMode === "preview") {
        setPanelOpen(false);
        return;
      }
      setSecret("");
      setHeaderRows([{ name: "", value: "" }]);
      setPanelOpen(false);
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  /**
   * Lists the tools of the MCP server at the credential's URL, connecting with this vault's
   * credential; the Runtime calls no tool.
   */
  async function previewTools(row: Row) {
    openPanel("preview", row);
    setPending(true);
    try {
      setPreview(
        await client(tenantId).mcp.preview({
          url: row.credential.binding.url,
          vaultId: row.vault.id,
        }),
      );
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  async function deleteVault() {
    if (!selectedVault) return;
    const label = selectedVault.name;
    if (
      !window.confirm(
        `Delete vault “${label}” and all of its credentials? This cannot be undone.`,
      )
    )
      return;
    setError("");
    setSaved("");
    setPending(true);
    try {
      await client(tenantId).vaults.delete(selectedVault.id);
      setSelectedVaultId("");
      setSaved(`Deleted vault “${label}”.`);
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  const panelTitle =
    panelMode === "add-vault"
      ? "New vault"
      : panelMode === "add-credential"
        ? "Add credential"
        : panelMode === "update"
        ? "Rotate credential"
          : panelMode === "delete"
            ? "Delete credential"
            : panelMode === "preview"
              ? "Server tools"
              : "Credential details";

  const secretLabel = panelMode === "update" ? "New token" : "Token";
  const editing = panelMode === "add-credential" || panelMode === "update";

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 overflow-auto p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Credentials</h1>
          <p className="mt-2 text-muted-foreground">
            Manage this Runtime installation's credentials for remote MCP
            servers. Secrets stay encrypted in the Runtime vault; reads return
            metadata only.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => openPanel("add-vault")}
            disabled={pending}
          >
            <Plus />
            New vault
          </Button>
          <Button
            onClick={() => openPanel("add-credential")}
            disabled={pending || vaults.length === 0}
          >
            <Plus />
            Add credential
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="grid min-w-56 flex-1 gap-1 text-sm">
          Installation vault
          <select
            className="h-9 rounded-md border bg-transparent px-3"
            value={selectedVaultId}
            onChange={(event) => setSelectedVaultId(event.target.value)}
            disabled={vaults.length === 0}
          >
            {vaults.length === 0 ? (
              <option value="">No vaults yet</option>
            ) : (
              vaults.map((vault) => (
                <option key={vault.id} value={vault.id}>
                  {vault.name}
                </option>
              ))
            )}
          </select>
        </label>
        {selectedVault ? (
          <Button
            variant="outline"
            onClick={() => void deleteVault()}
            disabled={pending}
          >
            <Trash2 />
            Delete vault
          </Button>
        ) : null}
      </div>
      {selectedVault ? (
        <p className="break-all text-sm text-muted-foreground">
          Vault ID:{" "}
          <code className="font-mono text-xs text-foreground">{selectedVault.id}</code>
        </p>
      ) : null}

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
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Destination URL</TableHead>
              <TableHead>Rotated</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {vaults.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-24 text-center text-muted-foreground"
                >
                  Create a vault to store credentials.
                </TableCell>
              </TableRow>
            ) : visible.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-24 text-center text-muted-foreground"
                >
                  No credentials in this vault yet.
                </TableCell>
              </TableRow>
            ) : (
              visible.map((row) => (
                <TableRow key={row.credential.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <KeyRound className="size-3.5 text-muted-foreground" />
                      <span className="font-medium">{row.credential.name}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {TYPE_LABELS[row.credential.type] ?? row.credential.type}
                    </Badge>
                    {row.credential.via ? (
                      <Badge variant="outline" className="ml-1">
                        Gateway
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell
                    className="max-w-xs truncate font-mono text-xs"
                    title={row.credential.binding.url}
                  >
                    {row.credential.binding.url}
                  </TableCell>
                  <TableCell>
                    {formatWhen(row.credential.rotatedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${row.credential.name} actions`}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() => openPanel("view", row)}
                        >
                          View
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => void previewTools(row)}
                        >
                          Preview tools
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => openPanel("update", row)}
                        >
                          Rotate
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => openPanel("delete", row)}
                        >
                          Delete
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

      <details className="rounded-lg bg-muted p-4 text-sm">
        <summary className="cursor-pointer font-medium">
          Using credentials in a session
        </summary>
        <div className="mt-3 space-y-3 text-muted-foreground">
          <p>
            These credentials belong to this Runtime installation. Attach a
            vault when creating a session to use its credentials. Declare the
            MCP server in your agent with the matching destination URL.
          </p>
          <pre className="whitespace-pre-wrap break-all rounded-md border bg-background p-3 text-xs text-foreground">
            {`await client.createSession({\n  agentId: "assistant",\n  ownerUserId: "developer",\n  vaultIds: [${JSON.stringify(selectedVault?.id ?? "vault-id")}],\n});`}
          </pre>
          <p>
            Studio's New session lets you pick the vaults to attach, and shows
            which of the agent's servers and tools each one covers. A person's
            own keys go in their user vault, which only their sessions attach.
            Model-provider credentials are managed in the Models tab.
          </p>
          <a
            className="text-primary underline underline-offset-4"
            href="https://docs.nylorun.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            Runtime documentation
          </a>
        </div>
      </details>

      <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{panelTitle}</SheetTitle>
            <SheetDescription>
              {panelMode === "view"
                ? "Metadata only. Secret values are never returned by the Runtime."
                : panelMode === "preview"
                  ? "The Runtime connected with this credential and listed the server's tools. It called none."
                  : panelMode === "delete"
                  ? "Type the credential name to confirm. This cannot be undone."
                  : "The Runtime encrypts secrets in the vault. Studio never keeps a copy."}
            </SheetDescription>
          </SheetHeader>
          <form
            className="flex flex-1 flex-col gap-4 px-4"
            onSubmit={(event) => void submit(event)}
          >
            {panelMode === "add-vault" ? (
              <label className="grid gap-1 text-sm">
                Vault name
                <Input
                  value={vaultName}
                  onChange={(event) => setVaultName(event.target.value)}
                  required
                  autoFocus
                />
              </label>
            ) : null}

            {panelMode === "add-credential" ||
            panelMode === "view" ||
            panelMode === "update" ||
            panelMode === "delete" ? (
              <>
                {panelMode === "add-credential" ? (
                  <label className="grid gap-1 text-sm">
                    Name
                    <Input
                      value={credentialName}
                      onChange={(event) =>
                        setCredentialName(event.target.value)
                      }
                      required
                      autoFocus
                    />
                  </label>
                ) : (
                  <label className="grid gap-1 text-sm">
                    Name
                    <Input value={credentialName} readOnly />
                  </label>
                )}
                <label className="grid gap-1 text-sm">
                  Type
                  {panelMode === "add-credential" ? (
                    <select
                      className="h-9 rounded-md border bg-transparent px-3"
                      value={credentialType}
                      onChange={(event) =>
                        setCredentialType(event.target.value as CredentialType)
                      }
                    >
                      <option value="bearer">Bearer token</option>
                      <option value="headers">Headers</option>
                    </select>
                  ) : (
                    <Input value={TYPE_LABELS[credentialType] ?? credentialType} readOnly />
                  )}
                </label>
                <label className="grid gap-1 text-sm">
                  Destination URL
                  <Input
                    value={bindingUrl}
                    onChange={(event) => setBindingUrl(event.target.value)}
                    placeholder="https://mcp.example.com/mcp"
                    required={panelMode === "add-credential"}
                    readOnly={panelMode !== "add-credential"}
                  />
                </label>
                {panelMode === "view" ? (
                  <label className="grid gap-1 text-sm">
                    Secret
                    <Input
                      type="password"
                      value={SECRET_MASK}
                      readOnly
                      autoComplete="off"
                    />
                    <span className="text-xs text-muted-foreground">
                      Masked. The Runtime never returns plaintext secrets.
                    </span>
                  </label>
                ) : null}
                {editing && credentialType === "bearer" ? (
                  <label className="grid gap-1 text-sm">
                    {secretLabel}
                    <Input
                      type="password"
                      autoComplete="off"
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                      required
                    />
                  </label>
                ) : null}
                {credentialType === "headers" ? (
                  <fieldset className="grid gap-2 text-sm">
                    <legend className="mb-1">
                      {panelMode === "update" ? "New headers" : "Headers"}
                    </legend>
                    {editing ? (
                      <>
                        {headerRows.map((row, index) => (
                          <div key={index} className="flex gap-2">
                            <Input
                              aria-label={`Header ${index + 1} name`}
                              placeholder="x-api-key"
                              value={row.name}
                              onChange={(event) =>
                                setHeaderRow(index, { name: event.target.value })
                              }
                              required
                            />
                            <Input
                              aria-label={`Header ${index + 1} value`}
                              type="password"
                              autoComplete="off"
                              placeholder="Value"
                              value={row.value}
                              onChange={(event) =>
                                setHeaderRow(index, { value: event.target.value })
                              }
                              required
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Remove header ${index + 1}`}
                              disabled={headerRows.length === 1}
                              onClick={() =>
                                setHeaderRows((current) =>
                                  current.filter((_, at) => at !== index),
                                )
                              }
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        ))}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="justify-self-start"
                          onClick={() =>
                            setHeaderRows((current) => [...current, { name: "", value: "" }])
                          }
                        >
                          <Plus />
                          Add header
                        </Button>
                      </>
                    ) : (
                      <Input
                        value={(active?.credential.headerNames ?? []).join(", ")}
                        readOnly
                      />
                    )}
                  </fieldset>
                ) : null}
                {editing || via ? (
                  <label className="grid gap-1 text-sm">
                    Send through a gateway (optional)
                    <Input
                      value={via}
                      onChange={(event) => setVia(event.target.value)}
                      placeholder="https://gateway.example.com/mcp/github"
                      readOnly={!editing}
                    />
                    {editing ? (
                      <span className="text-xs text-muted-foreground">
                        Requests go to this URL instead of the destination URL, which
                        still picks the credential.
                      </span>
                    ) : null}
                  </label>
                ) : null}
                {editing || identityHeader ? (
                  <label className="grid gap-1 text-sm">
                    Identity header (optional)
                    <Input
                      value={identityHeader}
                      onChange={(event) => setIdentityHeader(event.target.value)}
                      placeholder="x-user-id"
                      readOnly={!editing}
                    />
                    {editing ? (
                      <span className="text-xs text-muted-foreground">
                        Each request names the session's owner in this header.
                        Installation sessions send none.
                      </span>
                    ) : null}
                  </label>
                ) : null}
                {panelMode === "delete" ? (
                  <label className="grid gap-1 text-sm">
                    Type “{active?.credential.name}” to confirm
                    <Input
                      value={confirmName}
                      onChange={(event) => setConfirmName(event.target.value)}
                      required
                      autoFocus
                    />
                  </label>
                ) : null}
                {panelMode === "view" && active ? (
                  <p className="text-sm text-muted-foreground">
                    Created {formatWhen(active.credential.createdAt)}
                    {active.credential.rotatedAt
                      ? ` · Rotated ${formatWhen(active.credential.rotatedAt)}`
                      : ""}
                  </p>
                ) : null}
              </>
            ) : null}

            {panelMode === "preview" ? (
              <div className="grid gap-3 text-sm">
                <p className="break-all font-mono text-xs">
                  {active?.credential.binding.url}
                </p>
                {pending ? (
                  <p className="text-muted-foreground">Listing the server's tools…</p>
                ) : null}
                {preview?.authRequired ? (
                  <div className="grid gap-2 rounded-md border p-3">
                    <p className="font-medium">
                      {preview.credentialSent
                        ? "The server rejected this credential (HTTP 401)."
                        : "The server needs a credential (HTTP 401)."}
                    </p>
                    {Array.isArray(preview.authRequired.resourceMetadata?.authorization_servers) ? (
                      <p className="text-muted-foreground">
                        It signs people in with{" "}
                        {(preview.authRequired.resourceMetadata.authorization_servers as unknown[])
                          .map(String)
                          .join(", ")}
                        .
                      </p>
                    ) : null}
                    <p className="text-muted-foreground">
                      Nylorun holds no OAuth client: store the server's API key here, or send
                      its requests through a gateway that keeps each person's sign-in (a
                      credential with a gateway URL and an identity header).
                    </p>
                  </div>
                ) : null}
                {preview && !preview.authRequired ? (
                  <>
                    <p className="text-muted-foreground">
                      {typeof preview.serverInfo?.name === "string"
                        ? `${preview.serverInfo.name}${typeof preview.serverInfo.version === "string" ? ` ${preview.serverInfo.version}` : ""}: `
                        : ""}
                      {preview.tools.length} {preview.tools.length === 1 ? "tool" : "tools"}.
                      Model names use the server name “{preview.name}”; your manifest's
                      server name replaces it.
                    </p>
                    <ul className="grid max-h-96 gap-2 overflow-auto">
                      {preview.tools.map((tool) => (
                        <li key={tool.serverToolName} className="rounded-md border p-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <code className="font-mono text-xs">
                              {tool.modelName ?? tool.serverToolName}
                            </code>
                            {toolHints(tool.annotations) ? (
                              <Badge variant="outline">{toolHints(tool.annotations)}</Badge>
                            ) : null}
                            <span className="text-xs text-muted-foreground">
                              {tool.schemaBytes} B schema
                            </span>
                          </div>
                          {tool.modelName === undefined ? (
                            <p className="text-xs text-muted-foreground">
                              Left out: its input schema is not usable.
                            </p>
                          ) : null}
                          {tool.description ? (
                            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                              {tool.description}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    {preview.renamed.length > 0 ? (
                      <p className="text-xs text-muted-foreground">
                        Renamed for the model:{" "}
                        {preview.renamed
                          .map((item) => `${item.serverToolName} → ${item.name}`)
                          .join(", ")}
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}

            {error && panelOpen ? (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            ) : null}

            <SheetFooter className="px-0">
              {panelMode === "view" && active ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void previewTools(active)}
                >
                  Preview tools
                </Button>
              ) : null}
              {panelMode === "view" || panelMode === "preview" ? (
                <Button type="button" onClick={() => setPanelOpen(false)}>
                  Close
                </Button>
              ) : (
                <Button
                  type="submit"
                  disabled={pending}
                  variant={panelMode === "delete" ? "destructive" : "default"}
                >
                  {pending
                    ? "Saving"
                    : panelMode === "add-vault"
                      ? "Create vault"
                      : panelMode === "add-credential"
                        ? "Save credential"
                        : panelMode === "update"
                          ? "Rotate credential"
                          : "Delete credential"}
                </Button>
              )}
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </section>
  );
}
