import { useCallback, useEffect, useState, type FormEvent } from "react";
import { RuntimeError } from "@nylorun/agents/client";
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
import { createTenantClient } from "@/proxy-client";

const OWNER = "local-developer";
const SECRET_MASK = "••••••••••••••••";

type VaultInfo = {
  id: string;
  name: string;
  ownerUserId: string;
  metadata?: Record<string, string>;
  createdAt: string;
};

type CredentialInfo = {
  id: string;
  vaultId: string;
  name: string;
  type: "bearer" | "oauth";
  binding: { url: string };
  expiresAt?: string;
  createdAt: string;
  rotatedAt?: string;
};

type PanelMode = "add-vault" | "add-credential" | "view" | "update" | "delete";

type Row = {
  vault: VaultInfo;
  credential: CredentialInfo;
};

const client = (tenantId: string) => createTenantClient(tenantId);

function formatWhen(value?: string): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function messageOf(cause: unknown): string {
  if (cause instanceof RuntimeError) {
    const body = cause.body as { message?: string } | undefined;
    if (body && typeof body.message === "string" && body.message)
      return body.message;
  }
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
  const [authType, setAuthType] = useState<"bearer" | "oauth">("bearer");
  const [bindingUrl, setBindingUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [confirmName, setConfirmName] = useState("");

  const refresh = useCallback(async () => {
    const sdk = client(tenantId);
    const listed = await sdk.listVaults(OWNER);
    const nextVaults = listed.vaults;
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
        const listedCredentials = await sdk.listCredentials(vault.id);
        return listedCredentials.credentials.map((credential) => ({
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
    setAuthType("bearer");
    setBindingUrl("");
    setSecret("");
    setConfirmName("");
    setActive(undefined);
  }

  function openPanel(mode: PanelMode, row?: Row) {
    setError("");
    setSaved("");
    resetForm();
    setPanelMode(mode);
    setActive(row);
    if (row) {
      setCredentialName(row.credential.name);
      setAuthType(row.credential.type);
      setBindingUrl(row.credential.binding.url);
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
    try {
      if (panelMode === "add-vault") {
        await sdk.createVault({
          name: vaultName.trim(),
          ownerUserId: OWNER,
          idempotencyKey: crypto.randomUUID(),
        });
        setSaved(`Created vault “${vaultName.trim()}”.`);
      } else if (panelMode === "add-credential") {
        if (!selectedVaultId) throw new Error("Create a vault first.");
        const created = await sdk.createCredential(selectedVaultId, {
          name: credentialName.trim(),
          idempotencyKey: crypto.randomUUID(),
          auth:
            authType === "bearer"
              ? { type: "bearer", url: bindingUrl.trim(), token: secretValue }
              : {
                  type: "oauth",
                  url: bindingUrl.trim(),
                  accessToken: secretValue,
                },
        });
        if (JSON.stringify(created).includes(secretValue))
          throw new Error("The Runtime returned the credential secret.");
        setSaved(
          `Saved “${created.name}”. Secrets stay encrypted in the Runtime vault.`,
        );
      } else if (panelMode === "update" && active) {
        const updated = await sdk.rotateCredential(
          active.vault.id,
          active.credential.id,
          {
            idempotencyKey: crypto.randomUUID(),
            auth:
              active.credential.type === "bearer"
                ? { type: "bearer", token: secretValue }
                : { type: "oauth", accessToken: secretValue },
          },
        );
        if (JSON.stringify(updated).includes(secretValue))
          throw new Error("The Runtime returned the credential secret.");
        setSaved(`Rotated “${updated.name}”.`);
      } else if (panelMode === "delete" && active) {
        if (confirmName.trim() !== active.credential.name)
          throw new Error("Type the credential name to confirm deletion.");
        await sdk.deleteCredential(active.vault.id, active.credential.id);
        setSaved(`Deleted “${active.credential.name}”.`);
      } else if (panelMode === "view") {
        setPanelOpen(false);
        return;
      }
      setSecret("");
      setPanelOpen(false);
      await refresh();
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
      await client(tenantId).deleteVault(selectedVault.id);
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
          ? "Update credential"
          : panelMode === "delete"
            ? "Delete credential"
            : "Credential details";

  const secretLabel =
    panelMode === "update"
      ? active?.credential.type === "oauth"
        ? "New access token"
        : "New token"
      : authType === "oauth"
        ? "Access token"
        : "Token";

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 overflow-auto p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Vault</h1>
          <p className="mt-2 text-muted-foreground">
            Manage URL-bound credentials for MCP and other outbound calls.
            Secrets stay in the Runtime vault; Studio never keeps a copy.
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
          Vault
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
              <TableHead>Binding URL</TableHead>
              <TableHead>Updated</TableHead>
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
                      {row.credential.type === "oauth" ? "OAuth" : "Bearer"}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-xs truncate font-mono text-xs">
                    {row.credential.binding.url}
                  </TableCell>
                  <TableCell>
                    {formatWhen(
                      row.credential.rotatedAt ?? row.credential.createdAt,
                    )}
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
                          onSelect={() => openPanel("update", row)}
                        >
                          Update
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

      <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{panelTitle}</SheetTitle>
            <SheetDescription>
              {panelMode === "view"
                ? "Metadata only. Secret values are never returned by the Runtime."
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
                {panelMode === "add-credential" ? (
                  <label className="grid gap-1 text-sm">
                    Type
                    <select
                      className="h-9 rounded-md border bg-transparent px-3"
                      value={authType}
                      onChange={(event) =>
                        setAuthType(event.target.value as "bearer" | "oauth")
                      }
                    >
                      <option value="bearer">Bearer</option>
                      <option value="oauth">OAuth access token</option>
                    </select>
                  </label>
                ) : (
                  <label className="grid gap-1 text-sm">
                    Type
                    <Input
                      value={authType === "oauth" ? "OAuth" : "Bearer"}
                      readOnly
                    />
                  </label>
                )}
                <label className="grid gap-1 text-sm">
                  Binding URL
                  <Input
                    value={bindingUrl}
                    onChange={(event) => setBindingUrl(event.target.value)}
                    placeholder="mcp.example.com/service"
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
                {panelMode === "add-credential" || panelMode === "update" ? (
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
                    {active.credential.expiresAt
                      ? ` · Expires ${formatWhen(active.credential.expiresAt)}`
                      : ""}
                  </p>
                ) : null}
              </>
            ) : null}

            {error && panelOpen ? (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            ) : null}

            <SheetFooter className="px-0">
              {panelMode === "view" ? (
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
                          ? "Update credential"
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
