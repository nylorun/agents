import { useCallback, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { EnvironmentManifestPlan, EnvironmentManifestView } from "@nylorun/agents";
import { Plus } from "lucide-react";
import { createTenantClient } from "@/proxy-client";
import { messageOf, useRead } from "@/resources/reads";
import { isEnvironmentIdText } from "@/environment-form";
import { environmentPath } from "@/environment-path";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { ReadState } from "@/components/resource-layout";
import { date } from "@/components/environments";

const STARTER = `{
  "$schema": "https://docs.nylorun.com/schemas/environment-manifest/v1.json",
  "manifestSchemaVersion": 1,
  "name": "scratch",
  "kind": "virtual",
  "network": { "allowedHosts": [] }
}`;

/** The JSON a person typed, as an object, or the reason it is not one. */
function parsed(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error(`Not JSON: ${(cause as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A manifest is a JSON object.");
  return value as Record<string, unknown>;
}

/**
 * Saves an environment manifest's next version (D63), from any client with a credential that
 * may write Environments (Q12). Check shows the plan; a save changes no Environment.
 */
function ManifestSheet({
  tenantId,
  from,
  onClose,
  onSaved,
}: {
  tenantId: string;
  from?: EnvironmentManifestView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const [text, setText] = useState(() =>
    from ? JSON.stringify(from.manifest, null, 2) : STARTER,
  );
  const [plan, setPlan] = useState<EnvironmentManifestPlan | undefined>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  // Saved over the version opened, or refused (`412 manifest_changed`) when someone saved since.
  const ifMatch = from?.version ?? 0;
  async function check() {
    setError("");
    setPending(true);
    try {
      setPlan(await sdk.environments.manifests.plan(parsed(text) as never, { ifMatch }));
    } catch (cause) {
      setPlan(undefined);
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      await sdk.environments.manifests.save(parsed(text) as never, { ifMatch });
      onSaved();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <form className="flex min-h-full flex-col" onSubmit={submit}>
          <SheetHeader>
            <SheetTitle>{from ? `Save a new version of ${from.name}` : "New environment manifest"}</SheetTitle>
            <SheetDescription>
              A named, versioned definition of a kind of Environment, saved like an agent. Saving
              changes no Environment: each keeps the version it was made from, and moves to a new
              one by a fork.
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-3 px-4">
            <textarea
              aria-label="Environment manifest JSON"
              className="min-h-80 rounded-md border bg-background p-2 font-mono text-xs"
              spellCheck={false}
              value={text}
              onChange={(e) => (setText(e.target.value), setPlan(undefined))}
            />
            {plan ? (
              <ul className="grid gap-1 rounded-md border p-3 text-sm">
                <li>
                  {plan.unchanged
                    ? `Unchanged: version ${plan.to} stays the latest.`
                    : `Saves version ${plan.to}${plan.from ? ` (after ${plan.from})` : ""}.`}
                </li>
                {plan.changes.length ? <li>Changes: {plan.changes.map((change) => change.path).join(", ")}</li> : null}
                {plan.warnings.map((warning) => (
                  <li key={warning.code} className="text-amber-700 dark:text-amber-400">
                    {warning.message}
                  </li>
                ))}
                {plan.errors.map((message) => (
                  <li key={message} className="text-red-600">
                    {message}
                  </li>
                ))}
                {plan.behind ? <li>{plan.behind} Environments stay on older versions until forked.</li> : null}
              </ul>
            ) : null}
            {error ? (
              <p role="alert" className="break-words text-sm text-red-600">
                {error}
              </p>
            ) : null}
          </div>
          <SheetFooter className="mt-auto flex-row justify-end gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={() => void check()}>
              Check
            </Button>
            <Button type="submit" disabled={pending}>
              Save version
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** Makes an Environment from a manifest version (`PUT /v1/environments/{id}` with `manifest`). */
function NewFromManifest({
  tenantId,
  manifest,
  onClose,
}: {
  tenantId: string;
  manifest: EnvironmentManifestView;
  onClose: () => void;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const navigate = useNavigate();
  const [id, setId] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const next = id.trim();
    if (!isEnvironmentIdText(next)) return setError("Give the Environment an id, such as team/build.");
    setPending(true);
    try {
      const made = await sdk.environments.put(next, { manifest: `${manifest.name}@${manifest.version}` });
      navigate(environmentPath(made.id));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="w-full sm:max-w-md">
        <form className="flex min-h-full flex-col" onSubmit={submit}>
          <SheetHeader>
            <SheetTitle>
              New Environment from {manifest.name} v{manifest.version}
            </SheetTitle>
            <SheetDescription>It runs this version for life.</SheetDescription>
          </SheetHeader>
          <div className="grid gap-3 px-4">
            <label className="grid gap-1 text-sm">
              Environment id
              <Input value={id} placeholder="team/build" onChange={(e) => setId(e.target.value)} />
            </label>
            {error ? (
              <p role="alert" className="break-words text-sm text-red-600">
                {error}
              </p>
            ) : null}
          </div>
          <SheetFooter className="mt-auto flex-row justify-end">
            <Button type="submit" disabled={pending}>
              Create Environment
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** The Tenant's environment manifests: each one's latest version, a JSON view, and saving. */
export function EnvironmentManifests({ tenantId }: { tenantId: string }) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const load = useCallback((signal: AbortSignal) => sdk.environments.manifests.list({ signal }), [sdk]);
  const read = useRead(load);
  const [editing, setEditing] = useState<EnvironmentManifestView | "new" | undefined>();
  const [making, setMaking] = useState<EnvironmentManifestView | undefined>();
  const [open, setOpen] = useState<string | undefined>();
  const manifests = read.data ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Environment manifests</h2>
        <Button variant="outline" onClick={() => setEditing("new")}>
          <Plus />
          New manifest
        </Button>
      </div>
      <p className="max-w-3xl text-sm text-muted-foreground">
        A manifest defines a kind of Environment as JSON, versioned like an agent. Environments are
        made from one version and never change; a new version reaches one through a fork.
      </p>
      {manifests.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Environments</TableHead>
              <TableHead>Saved</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {manifests.map((manifest) => (
              <TableRow key={manifest.name}>
                <TableCell className="whitespace-normal break-all align-top">
                  <button
                    type="button"
                    className="font-medium underline-offset-4 hover:underline"
                    onClick={() => setOpen(open === manifest.name ? undefined : manifest.name)}
                  >
                    {manifest.name}
                  </button>
                  {open === manifest.name ? (
                    <pre className="mt-2 max-w-xl whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
                      {JSON.stringify(manifest.manifest, null, 2)}
                    </pre>
                  ) : null}
                </TableCell>
                <TableCell className="align-top">v{manifest.version}</TableCell>
                <TableCell className="align-top">
                  <Badge variant="outline">{manifest.manifest.kind ?? "virtual"}</Badge>
                </TableCell>
                <TableCell className="align-top">{manifest.environments}</TableCell>
                <TableCell className="align-top text-xs">
                  {date(manifest.createdAt)}
                  <p className="text-muted-foreground">{manifest.savedBy.actor}</p>
                </TableCell>
                <TableCell className="align-top">
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditing(manifest)}>
                      New version
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setMaking(manifest)}>
                      New Environment
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      <ReadState
        {...read}
        onRetry={read.reload}
        empty={manifests.length || read.pending ? undefined : "No environment manifests yet."}
      />
      {editing ? (
        <ManifestSheet
          tenantId={tenantId}
          {...(editing === "new" ? {} : { from: editing })}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            read.reload();
          }}
        />
      ) : null}
      {making ? <NewFromManifest tenantId={tenantId} manifest={making} onClose={() => setMaking(undefined)} /> : null}
    </div>
  );
}
