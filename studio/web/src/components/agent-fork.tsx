import { useMemo, useState, type FormEvent } from "react";
import type { AgentForkPlan, AgentView } from "@nylorun/agents";
import { createTenantClient } from "@/proxy-client";
import { messageOf } from "@/resources/reads";
import { forkRequest, type ForkForm } from "@/agent-form";
import { manifestNameOf } from "@/agent-list";
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
function PlanSummary({ plan }: { plan: AgentForkPlan }) {
  return (
    <ul className="grid gap-1 rounded-md border p-3 text-sm">
      <li>
        Made from {plan.manifest.name} v{plan.manifest.version}, kind {plan.kind}.
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
        <li className="font-medium">
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
 * Forks `source` into a new Agent (`POST /v1/agents/{id}/fork`, Q15): how an Agent moves to
 * another manifest version, since none ever changes what it runs. Check shows the plan first.
 */
export function ForkSheet({
  tenantId,
  source,
  latest,
  disk: diskVersion,
  onClose,
  onForked,
}: {
  tenantId: string;
  source: AgentView;
  /** The latest version of the source's manifest, when known. */
  latest?: number;
  /** The disk version the new Agent starts from; default a snapshot taken at the fork. */
  disk?: number;
  onClose: () => void;
  onForked: (agent: AgentView) => void;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const name = manifestNameOf(source);
  const next = latest !== undefined && latest > source.resolvedVersion ? latest : undefined;
  const [form, setForm] = useState<ForkForm>({
    id: `${source.id}-v${next ?? source.resolvedVersion}${next === undefined ? "-fork" : ""}`,
    manifest: next === undefined ? source.manifest : `${name}@${next}`,
    disk: diskVersion ?? (source.kind === "none" ? "empty" : "latest"),
    secrets: "copy",
  });
  const [plan, setPlan] = useState<AgentForkPlan | undefined>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const set = (patch: Partial<ForkForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setPlan(undefined);
  };
  async function check() {
    setError("");
    setPending(true);
    try {
      setPlan(await sdk.agents.planFork(source.id, forkRequest(form)));
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
      onForked((await sdk.agents.fork(source.id, forkRequest(form))).agent);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }
  const diskValue = String(form.disk);
  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <form className="flex min-h-full flex-col" onSubmit={submit}>
          <SheetHeader>
            <SheetTitle>Fork {source.id}</SheetTitle>
            <SheetDescription>
              A fork is a new Agent, made from a manifest version, with this one's disk and the
              secrets the new version declares: the way to change a kind, harness or storage.
              Another version of the same manifest moves this Agent in place instead.
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-4 px-4">
            <label className="grid gap-1 text-sm">
              New Agent id
              <Input value={form.id} onChange={(e) => set({ id: e.target.value })} className="font-mono" />
            </label>
            <label className="grid gap-1 text-sm">
              Agent manifest
              <Input
                placeholder={name}
                value={form.manifest}
                onChange={(e) => set({ manifest: e.target.value })}
                className="font-mono"
              />
              <span className="text-xs text-muted-foreground">
                name (its latest version) or name@version; empty for {name}'s latest.
              </span>
            </label>
            {source.kind === "none" ? null : (
              <label className="grid gap-1 text-sm">
                Disk
                <select
                  className="h-8 rounded-md border bg-background px-2"
                  value={diskValue}
                  onChange={(e) =>
                    set({
                      disk:
                        e.target.value === "latest" || e.target.value === "empty"
                          ? e.target.value
                          : Number(e.target.value),
                    })
                  }
                >
                  <option value="latest">A snapshot of this disk, now</option>
                  {diskVersion === undefined ? null : (
                    <option value={String(diskVersion)}>Disk version {diskVersion}</option>
                  )}
                  <option value="empty">Empty</option>
                </select>
              </label>
            )}
            <label className="grid gap-1 text-sm">
              Secrets
              <select
                className="h-8 rounded-md border bg-background px-2"
                value={form.secrets}
                onChange={(e) => set({ secrets: e.target.value as "copy" | "none" })}
              >
                <option value="copy">Copy those the new version declares</option>
                <option value="none">Copy none</option>
              </select>
            </label>
            {plan ? <PlanSummary plan={plan} /> : null}
            {error ? (
              <p role="alert" className="break-words text-sm text-destructive">
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
