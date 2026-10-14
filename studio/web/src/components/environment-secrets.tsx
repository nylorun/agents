import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { EnvironmentSecretView, EnvironmentView } from "@nylorun/agents";
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
import {
  createTenantClient,
  createTenantManagementClient,
} from "@/proxy-client";
import { listFrom } from "@/runtime-body.ts";
import {
  DEFAULT_INJECT,
  SHELL_SECRET_SENTINEL,
  headerPreview,
  isShellType,
  shellSecretRequest,
} from "@/shell-credentials.ts";

const SECRET_MASK = "••••••••••••••••";

type PanelMode = "add" | "view" | "update" | "delete" | "preview";

type CredentialType = EnvironmentSecretView["type"];

/** One row of a Headers credential's form. */
type HeaderRow = { name: string; value: string };

const TYPE_LABELS: Record<CredentialType, string> = {
  bearer: "Bearer",
  headers: "Headers",
  environment_secret: "Secret",
  environment_variable: "Variable",
};

/** The name of a `bearer` or `headers` credential: a label (the Runtime checks it again). */
const TOOL_NAME_PATTERN = "[A-Za-z0-9._\\-]{1,64}";

/** What a credential is for: its URL, or the variable a shell credential sets and where. */
function bindingOf(credential: EnvironmentSecretView): string {
  const { binding } = credential;
  if (binding.url) return binding.url;
  if (binding.allowedHosts) return `$${credential.name} → ${binding.allowedHosts.join(", ")}`;
  return `$${credential.name}`;
}

/** True when the Runtime's answer contains one of the secrets just sent. */
function leaks(info: unknown, secrets: readonly string[]): boolean {
  const text = JSON.stringify(info);
  return secrets.some((value) => value.length >= 8 && text.includes(value));
}

const management = (tenantId: string) => createTenantManagementClient(tenantId);

/** What the Runtime found behind a credential's URL (R2b C12). */
type McpPreview = Awaited<ReturnType<ReturnType<typeof management>["mcp"]["preview"]>>;

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

/** The clients' errors carry the Runtime's message. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * An Environment's Secrets tab (protocol 11, D56): the secrets of its one vault. There are no
 * user or installation vaults: an Environment's secrets reach the sessions that name it. A
 * vault-only Environment (kind `none`) has no sandbox, so it takes no shell secrets.
 */
export function EnvironmentSecrets({
  tenantId,
  environment,
}: Readonly<{ tenantId: string; environment: EnvironmentView }>) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const selectedId = environment.id;
  const sandbox = environment.kind !== "none";
  const [rows, setRows] = useState<EnvironmentSecretView[]>();
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [pending, setPending] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>("add");
  const [active, setActive] = useState<EnvironmentSecretView | undefined>();
  const [credentialName, setCredentialName] = useState("");
  const [bindingUrl, setBindingUrl] = useState("");
  const [credentialType, setCredentialType] = useState<CredentialType>("bearer");
  const [secret, setSecret] = useState("");
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([{ name: "", value: "" }]);
  const [via, setVia] = useState("");
  const [identityHeader, setIdentityHeader] = useState("");
  const [confirmName, setConfirmName] = useState("");
  // Shell credentials (R2c): a secret's hosts and header.
  const [shellHosts, setShellHosts] = useState("");
  const [shellHeader, setShellHeader] = useState("");
  const [shellFormat, setShellFormat] = useState("");
  const [preview, setPreview] = useState<McpPreview | undefined>();

  const refreshSecrets = useCallback(async () => {
    setRows(
      listFrom<EnvironmentSecretView>(
        { secrets: await sdk.environments.secrets.list(selectedId) },
        "secrets",
        "The Runtime did not return the Environment's secrets.",
      ),
    );
  }, [sdk, selectedId]);

  useEffect(() => {
    let cancelled = false;
    refreshSecrets().then(
      () => !cancelled && setError(""),
      (cause: unknown) => !cancelled && setError(messageOf(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [refreshSecrets]);

  function resetForm() {
    setCredentialName("");
    setBindingUrl("");
    setCredentialType("bearer");
    setSecret("");
    setHeaderRows([{ name: "", value: "" }]);
    setVia("");
    setIdentityHeader("");
    setConfirmName("");
    setShellHosts("");
    setShellHeader("");
    setShellFormat("");
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

  function openPanel(mode: PanelMode, row?: EnvironmentSecretView) {
    setError("");
    setSaved("");
    resetForm();
    setPanelMode(mode);
    setActive(row);
    if (row) {
      const { binding } = row;
      setCredentialName(row.name);
      setBindingUrl(binding.url ?? "");
      setCredentialType(row.type);
      setHeaderRows((row.headerNames ?? [""]).map((name) => ({ name, value: "" })));
      setVia(row.via ?? "");
      setIdentityHeader(row.identity?.header ?? "");
      setShellHosts((binding.allowedHosts ?? []).join(", "));
      setShellHeader(binding.inject?.header ?? "");
      setShellFormat(binding.inject?.format ?? "");
    }
    setPanelOpen(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSaved("");
    setPending(true);
    const secretValue = secret;
    // A PUT replaces the credential: the gateway and identity header are what the form holds.
    const routing = {
      ...(via.trim() ? { via: via.trim() } : {}),
      ...(identityHeader.trim() ? { identity: { header: identityHeader.trim() } } : {}),
    };
    try {
      if (panelMode === "add" || panelMode === "update") {
        const updating = panelMode === "update";
        if (isShellType(credentialType)) {
          const { name, secret: body } = shellSecretRequest(credentialType, {
            name: credentialName,
            hosts: shellHosts,
            value: secretValue,
            header: shellHeader,
            format: shellFormat,
          });
          const written = await sdk.environments.secrets.put(selectedId, name, body);
          if (leaks(written, [secretValue]))
            throw new Error("The Runtime returned the credential secret.");
          setSaved(
            credentialType === "environment_secret"
              ? updating
                ? `Rotated “${written.name}”. The next request uses the new value.`
                : `Saved “${written.name}”. Commands in the sandbox see $${written.name} as ${SHELL_SECRET_SENTINEL}.`
              : updating
                ? `Changed “${written.name}”. Commands see the new value from the next turn.`
                : `Saved “${written.name}”.`,
          );
        } else {
          const name = credentialName.trim();
          const url = bindingUrl.trim();
          const headers = credentialType === "headers" ? headerMap() : undefined;
          if (!headers && !secretValue) throw new Error("Enter the token.");
          const written = await sdk.environments.secrets.put(
            selectedId,
            name,
            headers
              ? { type: "headers", url, headers, ...routing }
              : { type: "bearer", url, value: secretValue, ...routing },
          );
          if (leaks(written, headers ? Object.values(headers) : [secretValue]))
            throw new Error("The Runtime returned the credential secret.");
          setSaved(
            updating
              ? `Rotated “${written.name}”.`
              : `Saved “${written.name}”. Secrets stay encrypted in the Environment's vault.`,
          );
        }
      } else if (panelMode === "delete" && active) {
        if (confirmName.trim() !== active.name)
          throw new Error("Type the credential name to confirm deletion.");
        await sdk.environments.secrets.delete(selectedId, active.name);
        setSaved(`Deleted “${active.name}”.`);
      } else {
        setPanelOpen(false);
        return;
      }
      setSecret("");
      setHeaderRows([{ name: "", value: "" }]);
      setPanelOpen(false);
      await refreshSecrets();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  /**
   * Lists the tools of the MCP server at the credential's URL, connecting with this
   * Environment's credential; the Runtime calls no tool.
   */
  async function previewTools(row: EnvironmentSecretView) {
    openPanel("preview", row);
    setPending(true);
    try {
      setPreview(
        await management(tenantId).mcp.preview({
          url: row.binding.url ?? "",
          environmentId: selectedId,
        }),
      );
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  const panelTitle =
    panelMode === "add"
      ? "Add credential"
      : panelMode === "update"
        ? credentialType === "environment_variable"
          ? "Change value"
          : "Rotate credential"
        : panelMode === "delete"
          ? "Delete credential"
          : panelMode === "preview"
            ? "Server tools"
            : "Credential details";

  const secretLabel = panelMode === "update" ? "New token" : "Token";
  const editing = panelMode === "add" || panelMode === "update";
  const shell = isShellType(credentialType);
  const adding = panelMode === "add";

  /** A shell credential's fields: a secret's hosts and header, and the value. */
  const shellFields = (
    <>
      {credentialType === "environment_secret" ? (
        <>
          <label className="grid gap-1 text-sm">
            Allowed hosts
            <Input
              value={shellHosts}
              onChange={(event) => setShellHosts(event.target.value)}
              placeholder="api.github.com, github.com"
              className="font-mono"
              required={editing}
              readOnly={!editing}
            />
            {editing ? (
              <span className="text-xs text-muted-foreground">
                Exact host names, separated by commas. Only HTTPS requests to these hosts
                carry the secret; the Environment's network allowlist must include them too.
              </span>
            ) : null}
          </label>
          <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
            <label className="grid gap-1 text-sm">
              Header
              <Input
                value={shellHeader}
                onChange={(event) => setShellHeader(event.target.value)}
                placeholder={DEFAULT_INJECT.header}
                className="font-mono"
                readOnly={!editing}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Format
              <Input
                value={shellFormat}
                onChange={(event) => setShellFormat(event.target.value)}
                placeholder={DEFAULT_INJECT.format}
                className="font-mono"
                readOnly={!editing}
              />
            </label>
          </div>
          <div className="-mt-2 grid gap-0.5 text-xs text-muted-foreground">
            <code className="break-all font-mono">{headerPreview(shellHeader, shellFormat)}</code>
            {editing ? (
              <span>
                Set on every request, replacing the CLI's own. For Basic auth, encode a part
                with <code className="font-mono">{"{base64:user:{value}}"}</code>.
              </span>
            ) : null}
          </div>
        </>
      ) : null}
      {editing ? (
        <label className="grid gap-1 text-sm">
          {credentialType === "environment_secret"
            ? panelMode === "update"
              ? "New secret value"
              : "Secret value"
            : panelMode === "update"
              ? "New value"
              : "Value"}
          <Input
            type={credentialType === "environment_secret" ? "password" : "text"}
            autoComplete="off"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            className={credentialType === "environment_variable" ? "font-mono" : undefined}
            required
          />
        </label>
      ) : null}
    </>
  );

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-muted-foreground">
          {sandbox
            ? "This Environment's vault: credentials for remote MCP servers and HTTP tools, and the secrets and variables skills' CLIs use in its sandbox. "
            : "This Environment's vault: credentials for remote MCP servers and HTTP tools. It has no sandbox, so it holds no shell secrets. "}
          Sessions that name it use them. Secrets stay encrypted in the Runtime; reads
          return metadata only.
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              void refreshSecrets().then(
                () => setError(""),
                (cause: unknown) => setError(messageOf(cause)),
              )
            }
          >
            Refresh secrets
          </Button>
          <Button onClick={() => openPanel("add")} disabled={pending}>
            <Plus />
            Add credential
          </Button>
        </div>
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
              <TableHead>Destination</TableHead>
              <TableHead>Rotated</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows === undefined ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-24 text-center text-muted-foreground"
                >
                  {error ? "Secrets unavailable." : "Loading secrets…"}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-24 text-center text-muted-foreground"
                >
                  No credentials in this Environment yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.name}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <KeyRound className="size-3.5 text-muted-foreground" />
                      <span className="font-medium">{row.name}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{TYPE_LABELS[row.type] ?? row.type}</Badge>
                    {row.via ? (
                      <Badge variant="outline" className="ml-1">
                        Gateway
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell
                    className="max-w-xs truncate font-mono text-xs"
                    title={bindingOf(row)}
                  >
                    {bindingOf(row)}
                  </TableCell>
                  <TableCell>{formatWhen(row.rotatedAt)}</TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${row.name} actions`}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => openPanel("view", row)}>
                          View
                        </DropdownMenuItem>
                        {isShellType(row.type) ? null : (
                          <DropdownMenuItem onSelect={() => void previewTools(row)}>
                            Preview tools
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onSelect={() => openPanel("update", row)}>
                          {row.type === "environment_variable" ? "Change value" : "Rotate"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => openPanel("delete", row)}>
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
            A session that names an Environment sends its credentials: a credential goes
            only to the URL it is bound to. Declare the MCP server in your agent with the
            matching destination URL. A session without an Environment sends none.
          </p>
          <pre className="whitespace-pre-wrap break-all rounded-md border bg-background p-3 text-xs text-foreground">
            {`await client.environments.secrets.put(${JSON.stringify(selectedId)}, "github", {\n  type: "bearer",\n  url: "https://api.githubcopilot.com/mcp/",\n  value: process.env.GITHUB_TOKEN,\n});\nawait client.createSession({\n  agentId: "assistant",\n  ownerUserId: "developer",\n  environment: ${JSON.stringify(selectedId)},\n});`}
          </pre>
          <p>
            A skill's CLI in the sandbox sees a secret's variable as{" "}
            <code className="font-mono text-xs text-foreground">{SHELL_SECRET_SENTINEL}</code>
            , never its value: when the CLI calls one of the secret's hosts over HTTPS, the
            Runtime's egress gate sets the real header. A variable's value is visible to the
            sandbox.
          </p>
          <p>
            Studio's New session lets you pick the Environment, and shows which of the
            agent's servers and tools it covers; so does a session's Environment tab.
            Model-provider credentials are managed in Settings, under Models.
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
                    : credentialType === "environment_variable"
                      ? "A variable is not secret: the sandbox sees its value."
                      : `The Runtime encrypts secrets in ${selectedId}'s vault. Studio never keeps a copy.`}
            </SheetDescription>
          </SheetHeader>
          <form
            className="flex flex-1 flex-col gap-4 overflow-y-auto px-4"
            onSubmit={(event) => void submit(event)}
          >
            {panelMode !== "preview" ? (
              <>
                <label className="grid gap-1 text-sm">
                  Type
                  {adding ? (
                    <select
                      className="h-9 rounded-md border bg-transparent px-3"
                      value={credentialType}
                      onChange={(event) =>
                        setCredentialType(event.target.value as CredentialType)
                      }
                    >
                      <optgroup label="MCP servers and HTTP tools">
                        <option value="bearer">Bearer token</option>
                        <option value="headers">Headers</option>
                      </optgroup>
                      {sandbox ? (
                        <optgroup label="Skills in the sandbox">
                          <option value="environment_secret">Secret</option>
                          <option value="environment_variable">Variable</option>
                        </optgroup>
                      ) : null}
                    </select>
                  ) : (
                    <Input value={TYPE_LABELS[credentialType] ?? credentialType} readOnly />
                  )}
                </label>
                <label className="grid gap-1 text-sm">
                  {shell ? "Variable name" : "Name"}
                  <Input
                    value={credentialName}
                    onChange={(event) => setCredentialName(event.target.value)}
                    placeholder={
                      shell
                        ? credentialType === "environment_secret"
                          ? "GH_TOKEN"
                          : "REGION"
                        : "github"
                    }
                    pattern={shell ? undefined : TOOL_NAME_PATTERN}
                    className={shell ? "font-mono" : undefined}
                    required={adding}
                    readOnly={!adding}
                    autoFocus={adding}
                  />
                  {adding ? (
                    <span className="text-xs text-muted-foreground">
                      {shell
                        ? credentialType === "environment_secret"
                          ? `The variable commands in the sandbox see, as ${SHELL_SECRET_SENTINEL}, never the value.`
                          : "The variable commands in the sandbox see."
                        : "A label: 1–64 letters, digits, '.', '_' or '-'. Saving a name again replaces it."}
                    </span>
                  ) : null}
                </label>
                {shell ? null : (
                  <label className="grid gap-1 text-sm">
                    Destination URL
                    <Input
                      value={bindingUrl}
                      onChange={(event) => setBindingUrl(event.target.value)}
                      placeholder="https://mcp.example.com/mcp"
                      required={adding}
                      readOnly={!adding}
                    />
                  </label>
                )}
                {shell ? shellFields : null}
                {panelMode === "view" || panelMode === "delete" ? (
                  <label className="grid gap-1 text-sm">
                    {credentialType === "environment_variable" ? "Value" : "Secret"}
                    <Input
                      type="password"
                      value={SECRET_MASK}
                      readOnly
                      autoComplete="off"
                    />
                    <span className="text-xs text-muted-foreground">
                      Masked. The Runtime never returns a credential's value.
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
                      <Input value={(active?.headerNames ?? []).join(", ")} readOnly />
                    )}
                  </fieldset>
                ) : null}
                {!shell && (editing || via) ? (
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
                {!shell && (editing || identityHeader) ? (
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
                      </span>
                    ) : null}
                  </label>
                ) : null}
                {panelMode === "delete" ? (
                  <label className="grid gap-1 text-sm">
                    Type “{active?.name}” to confirm
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
                    Created {formatWhen(active.createdAt)}
                    {active.rotatedAt ? ` · Rotated ${formatWhen(active.rotatedAt)}` : ""}
                  </p>
                ) : null}
              </>
            ) : (
              <div className="grid gap-3 text-sm">
                <p className="break-all font-mono text-xs">{active?.binding.url}</p>
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
            )}

            {error && panelOpen ? (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            ) : null}

            <SheetFooter className="px-0">
              {panelMode === "view" && active && !shell ? (
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
                    : panelMode === "add"
                      ? "Save credential"
                      : panelMode === "update"
                        ? credentialType === "environment_variable"
                          ? "Save value"
                          : "Rotate credential"
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
