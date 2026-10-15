import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type {
  EnvironmentManifestPlan,
  EnvironmentManifestView,
  EnvironmentView,
} from "@nylorun/agents";
import { Check, Copy, FileJson } from "lucide-react";
import { createTenantClient } from "@/proxy-client";
import { messageOf } from "@/resources/reads";
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
export function ManifestSheet({
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
export function NewFromManifest({
  tenantId,
  manifest,
  onClose,
  onCreated,
}: {
  tenantId: string;
  manifest: EnvironmentManifestView;
  onClose: () => void;
  onCreated?: (environment: EnvironmentView) => void;
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
      onCreated?.(made);
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

/**
 * The manifest the Environments list is filtered on, in one line: its latest version and who
 * saved it, its JSON in a side panel (a manifest can be long), and saving its next version.
 */
export function ManifestBar({
  manifest,
  onNewVersion,
}: {
  manifest: EnvironmentManifestView;
  onNewVersion: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/30 px-4 py-2 text-sm">
      <FileJson className="size-4 shrink-0 text-muted-foreground" />
      <span className="font-medium">{manifest.name}</span>
      <span className="tabular-nums text-muted-foreground">v{manifest.version}</span>
      <Badge variant="outline">{manifest.manifest.kind ?? "virtual"}</Badge>
      <span className="text-xs text-muted-foreground">
        Saved {date(manifest.createdAt)} by {manifest.savedBy.actor}
      </span>
      <div className="ml-auto flex gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          View manifest
        </Button>
        <Button size="sm" variant="outline" onClick={onNewVersion}>
          New version
        </Button>
      </div>
      {open ? (
        <ManifestPanel
          manifest={manifest}
          onClose={() => setOpen(false)}
          onNewVersion={() => {
            setOpen(false);
            onNewVersion();
          }}
        />
      ) : null}
    </div>
  );
}

/** A manifest version's JSON in a side panel, read only, to copy or to save a next version from. */
function ManifestPanel({
  manifest,
  onClose,
  onNewVersion,
}: {
  manifest: EnvironmentManifestView;
  onClose: () => void;
  onNewVersion: () => void;
}) {
  const json = JSON.stringify(manifest.manifest, null, 2);
  const [copied, setCopied] = useState(false);
  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="w-full sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>
            {manifest.name} v{manifest.version}
          </SheetTitle>
          <SheetDescription>
            {manifest.manifest.kind ?? "virtual"} · {manifest.environments}{" "}
            {manifest.environments === 1 ? "Environment" : "Environments"} made from it · saved{" "}
            {date(manifest.createdAt)} by {manifest.savedBy.actor}
          </SheetDescription>
        </SheetHeader>
        <pre
          aria-label={`${manifest.name} manifest JSON`}
          className="mx-4 min-h-0 flex-1 overflow-auto whitespace-pre rounded-md border bg-muted/40 p-3 font-mono text-xs"
        >
          {json}
        </pre>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button
            variant="outline"
            onClick={() =>
              void navigator.clipboard?.writeText(json).then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }
          >
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy JSON"}
          </Button>
          <Button onClick={onNewVersion}>New version</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
