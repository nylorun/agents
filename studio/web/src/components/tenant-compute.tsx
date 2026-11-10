import { useCallback, useMemo, useState, type FormEvent } from "react";
import { cn } from "@/lib/utils";
import { createTenantManagementClient } from "@/proxy-client";
import { messageOf, useRead } from "@/resources/reads";
import {
  computeSections,
  parseLimit,
  sandboxForm,
  sandboxPut,
  sizeInput,
  type ArtifactsView,
  type SandboxView,
  type SkillsView,
} from "@/tenant-spec";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReadState } from "@/components/resource-layout";
import { FormField, SidePanel, StatusDot, TableToolbar } from "@/components/data-table";

/**
 * Where the Tenant's Agents run: the sandbox the Runtime chose and the backends it found, then
 * the most an Agent's runtime section may ask for, where harnesses may run, and what artifacts
 * and skills may hold. Edit compute settings changes the limits, the stop grace and the storage.
 */
export function TenantCompute({ tenantId, agents }: { tenantId: string; agents?: number }) {
  const management = useMemo(() => createTenantManagementClient(tenantId), [tenantId]);
  const load = useCallback(
    async () => {
      const [sandbox, artifacts, skills] = await Promise.all([
        management.settings.sandbox.get(),
        management.settings.artifacts.get().catch(() => undefined),
        management.settings.skills.get().catch(() => undefined),
      ]);
      return { sandbox, artifacts, skills };
    },
    [management],
  );
  const read = useRead(load);
  const [editing, setEditing] = useState(false);
  const data = read.data;
  const sections = data ? computeSections(data.sandbox, data.artifacts, data.skills, agents) : [];
  return (
    <div>
      <TableToolbar>
        <span className="text-sm text-muted-foreground">Where every Agent's sandbox runs, and the most one may ask for</span>
        <span className="ml-auto" />
        <Button variant="outline" size="sm" disabled={!data} onClick={() => setEditing(true)}>
          Edit compute settings…
        </Button>
      </TableToolbar>
      <ReadState {...read} pending={read.pending && !data} onRetry={read.reload} />
      {sections.map((section) => (
        <section key={section.id} aria-label={section.title}>
          <div className="flex items-baseline gap-2 px-4 pt-4 pb-1.5">
            <h2 className="text-sm font-semibold">{section.title}</h2>
            <span className="truncate text-xs text-muted-foreground">{section.hint}</span>
          </div>
          <ul>
            {section.rows.map((row) => (
              <li key={row.label} className="flex h-10 items-center gap-3 border-b px-4 text-sm">
                <span
                  className={cn("w-44 shrink-0 truncate text-muted-foreground", row.monoLabel && "font-mono text-[13px] text-foreground")}
                  title={row.label}
                >
                  {row.label}
                </span>
                <span className={cn("min-w-0 flex-1 truncate", row.mono && "font-mono text-[13px]")} title={row.value}>
                  {row.value}
                </span>
                {row.note ? (
                  <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground" title={row.note}>
                    {row.tone ? <StatusDot tone={row.tone}>{row.note}</StatusDot> : row.note}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {editing && data ? (
        <EditCompute
          {...data}
          onClose={() => setEditing(false)}
          save={async (sandbox, artifacts, skills) => {
            await Promise.all([
              sandbox ? management.settings.sandbox.put(sandbox) : undefined,
              artifacts ? management.settings.artifacts.put(artifacts) : undefined,
              skills ? management.settings.skills.put(skills) : undefined,
            ]);
            setEditing(false);
            read.reload();
          }}
        />
      ) : null}
    </div>
  );
}

type SandboxPut = Parameters<ReturnType<typeof createTenantManagementClient>["settings"]["sandbox"]["put"]>[0];
type ArtifactsPut = Parameters<ReturnType<typeof createTenantManagementClient>["settings"]["artifacts"]["put"]>[0];
type SkillsPut = Parameters<ReturnType<typeof createTenantManagementClient>["settings"]["skills"]["put"]>[0];

/**
 * The compute settings, as one form; only the parts it changes are saved. The sandbox settings
 * it puts are the Tenant's stored ones with the changed fields set, so a setting the form does
 * not show (`engine`, `placement`) or that the Tenant left to its default stays as it was.
 */
function EditCompute({
  sandbox,
  artifacts,
  skills,
  onClose,
  save,
}: {
  sandbox: SandboxView;
  artifacts?: ArtifactsView;
  skills?: SkillsView;
  onClose: () => void;
  save: (sandbox?: SandboxPut, artifacts?: ArtifactsPut, skills?: SkillsPut) => Promise<void>;
}) {
  const effective = sandbox.effective;
  const initial = {
    ...sandboxForm(sandbox),
    fileBytes: artifacts ? sizeInput(artifacts.limits.fileBytes) : "",
    totalBytes: artifacts ? sizeInput(artifacts.limits.totalBytes) : "",
    skillBytes: skills ? sizeInput(skills.limits.totalBytes) : "",
  };
  const [form, setForm] = useState(initial);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const set = (key: keyof typeof initial) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const fail = (message: string) => {
      setError(message);
      return undefined;
    };
    const bytes = (text: string, what: string) => {
      const value = parseLimit("sizeBytes", text);
      return value === undefined ? fail(`${what} must be a size such as 512MiB or 2GiB.`) : value;
    };
    const sandboxSaved = sandboxPut(sandbox.config, sandboxForm(sandbox), form);
    if (sandboxSaved.error) return fail(sandboxSaved.error);
    const sandboxBody: SandboxPut | undefined = sandboxSaved.put;
    let artifactsPut: ArtifactsPut | undefined;
    if (artifacts && (form.fileBytes !== initial.fileBytes || form.totalBytes !== initial.totalBytes)) {
      const fileBytes = bytes(form.fileBytes, "Artifact file");
      const totalBytes = bytes(form.totalBytes, "Artifacts in all");
      if (fileBytes === undefined || totalBytes === undefined) return;
      artifactsPut = { limits: { fileBytes, totalBytes } };
    }
    let skillsPut: SkillsPut | undefined;
    if (skills && form.skillBytes !== initial.skillBytes) {
      const totalBytes = bytes(form.skillBytes, "Skill files");
      if (totalBytes === undefined) return;
      skillsPut = { limits: { totalBytes } };
    }
    if (!sandboxBody && !artifactsPut && !skillsPut) return onClose();
    setPending(true);
    try {
      await save(sandboxBody, artifactsPut, skillsPut);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPending(false);
    }
  }

  const field = (key: keyof typeof initial, label: string, hint?: string) => (
    <FormField label={label} {...(hint ? { hint } : {})}>
      {(props) => <Input {...props} value={form[key]} onChange={(event) => set(key)(event.target.value)} />}
    </FormField>
  );
  return (
    <SidePanel
      title="Compute settings"
      description="The most an Agent may ask for, and what artifacts and skills hold"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="compute-settings" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <form id="compute-settings" className="space-y-4" onSubmit={(event) => void submit(event)}>
        <FormField label="Allowed hosts" hint="One per line, such as api.github.com or *.example.com. An Agent allows a subset.">
          {(props) => (
            <textarea
              {...props}
              className="min-h-24 rounded-md border bg-transparent px-3 py-2 font-mono text-xs"
              value={form.network}
              onChange={(event) => set("network")(event.target.value)}
            />
          )}
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          {field("cpus", "Most CPUs")}
          {field("memory", "Most memory")}
          {field("defaultCpus", "Default CPUs")}
          {field("defaultMemory", "Default memory")}
        </div>
        {field("idle", "Idle", "Stop compute after this long without a turn, such as 15m or 1h.")}
        {effective.lifecycle ? field("stopGrace", "Stop grace", "How long a pod has to stop, such as 10s.") : null}
        {effective.limits.environments !== undefined ? field("environments", "Most Agents") : null}
        {artifacts ? (
          <div className="grid grid-cols-2 gap-3">
            {field("fileBytes", "Artifact file")}
            {field("totalBytes", "Artifacts in all")}
          </div>
        ) : null}
        {skills ? field("skillBytes", "Skill files", "The most one skill's files may hold together.") : null}
        {error ? (
          <p role="alert" className="text-sm break-words text-destructive">
            {error}
          </p>
        ) : null}
      </form>
    </SidePanel>
  );
}
