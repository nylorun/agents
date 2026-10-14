import { useMemo, useState, type FormEvent } from "react";
import type { EnvironmentForkPlan, EnvironmentView } from "@nylorun/agents";
import { createTenantClient } from "@/proxy-client";
import { messageOf } from "@/resources/reads";
import { isEnvironmentIdText } from "@/environment-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

/** What a fork plan says, in a few lines. */
function PlanSummary({ plan }: { plan: EnvironmentForkPlan }) {
  return (
    <ul className="grid gap-1 rounded-md border p-3 text-sm">
      <li>
        Made from{" "}
        {plan.manifest ? `${plan.manifest.name} v${plan.manifest.version}` : "the source's fields"}, kind{" "}
        {plan.kind}.
      </li>
      <li>
        Disk:{" "}
        {plan.disk === null
          ? "empty"
          : plan.disk === "latest"
            ? "a snapshot of the source's disk, taken at the fork"
            : `the source's version ${plan.disk}`}
        {plan.setup ? "; the new setup runs on it before the first turn" : ""}.
      </li>
      <li>
        Secrets copied: {plan.secrets.copied.length ? plan.secrets.copied.join(", ") : "none"}
        {plan.secrets.dropped.length ? `; left behind: ${plan.secrets.dropped.join(", ")}` : ""}.
      </li>
      {plan.secrets.missing.length ? (
        <li className="text-amber-700 dark:text-amber-400">
          Still to set before use: {plan.secrets.missing.join(", ")}.
        </li>
      ) : null}
      <li>
        {plan.changes.length
          ? `${plan.changes.length} ${plan.changes.length === 1 ? "change" : "changes"}: ${plan.changes
              .map((change) => change.path)
              .join(", ")}`
          : "Runs the same as the source."}
      </li>
      <li>
        The source keeps what it runs, its disk and its {plan.sessions}{" "}
        {plan.sessions === 1 ? "session" : "sessions"}.
      </li>
    </ul>
  );
}

/**
 * Forks `source` into a new Environment (`POST /v1/environments/{id}/fork`, Q15): how it gets a
 * new manifest version, since none ever changes what it runs. Check shows the plan first.
 */
export function ForkSheet({
  tenantId,
  source,
  latest,
  onClose,
  onForked,
}: {
  tenantId: string;
  source: EnvironmentView;
  /** The latest version of the source's manifest, when known. */
  latest?: number;
  onClose: () => void;
  onForked: (environment: EnvironmentView) => void;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const [id, setId] = useState(`${source.id}-v${latest ?? (source.manifestVersion ?? 1) + 1}`);
  const [manifest, setManifest] = useState(
    source.manifestName === undefined ? "" : `${source.manifestName}${latest ? `@${latest}` : ""}`,
  );
  const [disk, setDisk] = useState<"latest" | "empty">(source.kind === "none" ? "empty" : "latest");
  const [secrets, setSecrets] = useState<"copy" | "none">("copy");
  const [plan, setPlan] = useState<EnvironmentForkPlan | undefined>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const options = () => {
    const next = id.trim();
    if (!isEnvironmentIdText(next)) throw new Error("Give the new Environment an id, such as team/build-v2.");
    return {
      id: next,
      ...(manifest.trim() ? { manifest: manifest.trim() } : {}),
      disk,
      secrets,
    };
  };
  async function check() {
    setError("");
    setPending(true);
    try {
      setPlan(await sdk.environments.planFork(source.id, options()));
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
      onForked((await sdk.environments.fork(source.id, options())).environment);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <form className="flex min-h-full flex-col" onSubmit={submit}>
          <SheetHeader>
            <SheetTitle>Fork {source.id}</SheetTitle>
            <SheetDescription>
              An Environment never changes what it runs. A fork is a new Environment, made from a
              manifest version, with this one's disk and the secrets the new version declares.
              Point new sessions at it when you are ready.
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-4 px-4">
            <label className="grid gap-1 text-sm">
              New Environment id
              <Input value={id} onChange={(e) => (setId(e.target.value), setPlan(undefined))} />
            </label>
            <label className="grid gap-1 text-sm">
              Environment manifest
              <Input
                placeholder={source.manifestName ?? "name or name@version"}
                value={manifest}
                onChange={(e) => (setManifest(e.target.value), setPlan(undefined))}
              />
              <span className="text-xs text-muted-foreground">
                name (its latest version) or name@version
                {source.manifestName ? `; empty for ${source.manifestName}'s latest` : ""}.
              </span>
            </label>
            {source.kind === "none" ? null : (
              <label className="grid gap-1 text-sm">
                Disk
                <select
                  className="h-9 rounded-md border bg-background px-2"
                  value={disk}
                  onChange={(e) => (setDisk(e.target.value as "latest" | "empty"), setPlan(undefined))}
                >
                  <option value="latest">A snapshot of this disk, now</option>
                  <option value="empty">Empty</option>
                </select>
              </label>
            )}
            <label className="grid gap-1 text-sm">
              Secrets
              <select
                className="h-9 rounded-md border bg-background px-2"
                value={secrets}
                onChange={(e) => (setSecrets(e.target.value as "copy" | "none"), setPlan(undefined))}
              >
                <option value="copy">Copy those the new version declares</option>
                <option value="none">Copy none</option>
              </select>
            </label>
            {plan ? <PlanSummary plan={plan} /> : null}
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
              Fork
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
