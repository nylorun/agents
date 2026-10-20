import { useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import type { AgentFolderDiagnostic, AgentManifestPlan } from "@nylorun/agents";
import { FolderUp } from "lucide-react";
import { createTenantClient, tenantRuntimeFetch } from "@/proxy-client";
import { messageOf } from "@/resources/reads";
import { formatBytes } from "@/attachments";
import {
  diagnosticPlace,
  folderName,
  FolderRefusedError,
  hashFolder,
  pickedFolder,
  planChangeLines,
  planHeadline,
  sendFolder,
  sortedDiagnostics,
  uploadMissing,
  type BrowserFile,
  type FolderRuntime,
  type HashedFolder,
} from "@/agent-folder";
import { Button } from "@/components/ui/button";
import { SidePanel } from "@/components/data-table";

type Step =
  | { kind: "working"; dir: string; text: string }
  | { kind: "plan"; dir: string; name: string; folder: HashedFolder; uploaded: number; plan: AgentManifestPlan }
  | { kind: "saving"; dir: string; name: string; folder: HashedFolder; uploaded: number; plan: AgentManifestPlan }
  | { kind: "refused"; dir: string; name?: string; message: string; diagnostics: readonly AgentFolderDiagnostic[] };

/**
 * Upload folder (track T7): pick an agent's folder in the browser, and Studio hashes each file,
 * uploads the ones the Runtime does not hold, and shows the plan of saving it (what changes,
 * errors, warnings and the compiler's diagnostics) before it saves it, as `nylorun apply` does.
 * The manifest takes the name `AGENT.md` gives it.
 */
export function UploadFolder({
  tenantId,
  hint,
  onSaved,
}: Readonly<{ tenantId: string; hint: string; onSaved: (name: string, version: number) => void }>) {
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController>(null);
  const [step, setStep] = useState<Step>();
  const runtime = useMemo<FolderRuntime>(() => {
    const sdk = createTenantClient(tenantId);
    return {
      has: (sha256, signal) => sdk.files.has(sha256, signal ? { signal } : {}),
      upload: (bytes, sha256, signal) => sdk.files.upload(bytes, { sha256, ...(signal ? { signal } : {}) }),
      fetch: tenantRuntimeFetch(tenantId),
    };
  }, [tenantId]);

  function close() {
    abort.current?.abort();
    setStep(undefined);
  }

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const picked = pickedFolder(Array.from(event.target.files ?? []) as BrowserFile[]);
    // The same folder picked again is a new pick.
    event.target.value = "";
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const { signal } = controller;
    const dir = picked.dir || "folder";
    let name: string | undefined;
    try {
      if (!picked.files.some((file) => file.path === "AGENT.md"))
        throw new Error(`${dir} has no AGENT.md at its top: pick the agent's own folder, the one that holds AGENT.md.`);
      setStep({ kind: "working", dir, text: `Hashing ${picked.files.length} files…` });
      const folder = await hashFolder(picked, (done, total) =>
        setStep({ kind: "working", dir, text: `Hashing ${done} of ${total} files…` }),
      );
      signal.throwIfAborted();
      name = folderName(folder.agentMd, dir);
      const uploaded = await uploadMissing(
        runtime,
        folder,
        (done, total) => setStep({ kind: "working", dir, text: `Checking and uploading files: ${done} of ${total}…` }),
        signal,
      );
      setStep({ kind: "working", dir, text: "Planning the save…" });
      const plan = await sendFolder(runtime, name, folder.entries, { dryRun: true, signal });
      if (!signal.aborted) setStep({ kind: "plan", dir, name, folder, uploaded, plan });
    } catch (cause) {
      if (signal.aborted) return;
      setStep({
        kind: "refused",
        dir,
        ...(name === undefined ? {} : { name }),
        message: messageOf(cause),
        diagnostics: cause instanceof FolderRefusedError ? cause.diagnostics : [],
      });
    }
  }

  async function save() {
    if (step?.kind !== "plan") return;
    const { dir, name, folder, plan } = step;
    setStep({ ...step, kind: "saving" });
    try {
      // Made over the version the plan was made over: a save in between is refused (412).
      const saved = await sendFolder(runtime, name, folder.entries, { ifMatch: plan.from ?? 0 });
      setStep(undefined);
      onSaved(name, saved.manifest.version);
    } catch (cause) {
      setStep({
        kind: "refused",
        dir,
        name,
        message: messageOf(cause),
        diagnostics: cause instanceof FolderRefusedError ? cause.diagnostics : [],
      });
    }
  }

  const planned = step?.kind === "plan" || step?.kind === "saving" ? step : undefined;
  const canSave = planned !== undefined && planned.plan.errors.length === 0 && !planned.plan.unchanged;
  return (
    <>
      <input
        ref={input}
        type="file"
        className="hidden"
        aria-label="Agent folder"
        onChange={(event) => void pick(event)}
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
      />
      <Button variant="outline" size="sm" title={hint} onClick={() => input.current?.click()} className="shrink-0">
        <FolderUp aria-hidden />
        Upload folder…
      </Button>
      {step ? (
        <SidePanel
          title={step.kind === "working" ? `Upload ${step.dir}` : `Upload ${step.name ?? step.dir}`}
          description={
            planned
              ? `${planned.dir}/ · ${planned.folder.entries.length === 1 ? "1 file" : `${planned.folder.entries.length} files`} · ${formatBytes(
                  planned.folder.entries.reduce((sum, entry) => sum + entry.size, 0),
                )} · ${planned.uploaded} uploaded`
              : `${step.dir}/`
          }
          onClose={close}
          wide
          footer={
            <>
              <Button variant="outline" size="sm" onClick={close}>
                {planned?.plan.unchanged || step.kind === "refused" ? "Close" : "Cancel"}
              </Button>
              {canSave ? (
                <Button size="sm" onClick={() => void save()} disabled={step.kind === "saving"}>
                  {step.kind === "saving" ? "Saving…" : `Save v${planned.plan.to}`}
                </Button>
              ) : null}
            </>
          }
        >
          {step.kind === "working" ? (
            <p role="status" className="text-sm text-muted-foreground">
              {step.text}
            </p>
          ) : step.kind === "refused" ? (
            <>
              <p role="alert" className="text-sm break-words">
                {step.message}
              </p>
              <Diagnostics diagnostics={step.diagnostics} />
            </>
          ) : planned ? (
            <FolderPlan plan={planned.plan} />
          ) : null}
        </SidePanel>
      ) : null}
    </>
  );
}

/** The plan of saving a folder: what a save would do, then why not, then what changes. */
function FolderPlan({ plan }: Readonly<{ plan: AgentManifestPlan }>) {
  const lines = planChangeLines(plan.changes);
  const moves = plan.moves.now + plan.moves.nextStart + plan.moves.secrets;
  return (
    <>
      <div className="space-y-1">
        <p role="status" className="text-sm font-medium">
          {planHeadline(plan)}
        </p>
        {plan.errors.length === 0 && !plan.unchanged ? (
          <p className="text-xs text-muted-foreground">
            {moves === 0 ? "No Agent moves to it" : moves === 1 ? "1 Agent moves to it" : `${moves} Agents move to it`}
            {plan.behind ? ` · ${plan.behind} stay on older versions` : ""}
          </p>
        ) : null}
      </div>
      {plan.errors.length > 0 ? (
        <Section title="Errors">
          {plan.errors.map((error) => (
            <li key={error} className="break-words">
              {error}
            </li>
          ))}
        </Section>
      ) : null}
      {plan.warnings.length > 0 ? (
        <Section title="Warnings">
          {plan.warnings.map((warning) => (
            <li key={warning.code + warning.message} className="break-words">
              {warning.message}
            </li>
          ))}
        </Section>
      ) : null}
      {lines.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            {lines.length === 1 ? "1 change" : `${lines.length} changes`}
            {plan.from === null ? "" : ` from v${plan.from}`}
          </p>
          <pre aria-label="Changes" className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-all">
            {lines.map((line) => `${line.mark} ${line.field}${line.text ? `  ${line.text}` : ""}`).join("\n")}
          </pre>
        </div>
      ) : null}
      <Diagnostics diagnostics={plan.diagnostics ?? []} />
    </>
  );
}

/** The compiler's diagnostics, errors first, each with its file, line and column. */
function Diagnostics({ diagnostics }: Readonly<{ diagnostics: readonly AgentFolderDiagnostic[] }>) {
  if (diagnostics.length === 0) return null;
  return (
    <Section title={diagnostics.length === 1 ? "1 diagnostic" : `${diagnostics.length} diagnostics`}>
      {sortedDiagnostics(diagnostics).map((item, index) => (
        <li key={index} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3">
          <span className={item.severity === "error" ? "font-medium" : "text-muted-foreground"}>{item.severity}</span>
          <span className="break-words">
            {diagnosticPlace(item) ? <span className="mr-1.5 font-mono text-xs">{diagnosticPlace(item)}</span> : null}
            {item.message}
          </span>
        </li>
      ))}
    </Section>
  );
}

function Section({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="space-y-1.5 text-sm">{children}</ul>
    </div>
  );
}
