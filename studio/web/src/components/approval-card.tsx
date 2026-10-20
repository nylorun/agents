import { useState } from "react";
import { Button } from "@/components/ui/button";
import { approvalTitle, calledAs, type PendingApproval } from "@/approvals";
import { STATUS_DOT } from "@/lib/status";
import { cn } from "@/lib/utils";

/**
 * A tool call the Tool Gate holds for a person (R5 step 2): its tool by identity (`server / tool`
 * for an MCP tool, with the name the model called it by when that differs), why it is held, and
 * its input, with Approve and Deny. Approving sends the exact call shown; denying fails it to the
 * model as `tool.denied`, unsent.
 */
export function ApprovalCard(props: {
  readonly approval: PendingApproval;
  readonly answer: (approved: boolean) => Promise<void>;
}) {
  const { approval } = props;
  const [answering, setAnswering] = useState<boolean | undefined>();
  const [error, setError] = useState("");
  async function answer(approved: boolean) {
    setAnswering(approved);
    setError("");
    try {
      await props.answer(approved);
    } catch (e) {
      setError(String(e));
      setAnswering(undefined);
    }
  }
  return (
    <section
      aria-label={`Approve ${approvalTitle(approval)}`}
      className="space-y-3 rounded-lg border border-ring p-4"
    >
      <div>
        <p className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT.attention)} />
          Waiting for approval
        </p>
        <p className="mt-1 font-medium">
          {approvalTitle(approval)}
          {approval.server && !approval.tool ? (
            <span className="text-muted-foreground"> · {approval.server}</span>
          ) : null}
        </p>
        {calledAs(approval) ? (
          <p className="text-xs text-muted-foreground">
            The model called it <code className="font-mono">{calledAs(approval)}</code>
          </p>
        ) : null}
        {approval.reason ? <p className="text-sm text-muted-foreground">{approval.reason}</p> : null}
      </div>
      {approval.input !== undefined ? (
        <pre className="max-h-64 overflow-auto rounded-md border bg-background p-3 text-xs">
          {JSON.stringify(approval.input, null, 2)}
        </pre>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" disabled={answering !== undefined} onClick={() => void answer(true)}>
          {answering === true ? "Approving…" : "Approve"}
        </Button>
        <Button size="sm" variant="outline" disabled={answering !== undefined} onClick={() => void answer(false)}>
          {answering === false ? "Denying…" : "Deny"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
