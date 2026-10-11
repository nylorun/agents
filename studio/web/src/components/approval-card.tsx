import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { PendingApproval } from "@/approvals";

/**
 * A tool call the Tool Gate holds for a person (R5 step 2): its tool, why it is held, and its
 * input, with Approve and Deny. Approving sends the exact call shown; denying fails it to the
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
      aria-label={`Approve ${approval.toolName ?? "tool call"}`}
      className="space-y-3 rounded-xl border border-amber-500/60 bg-amber-50/40 p-4 dark:bg-amber-950/20"
    >
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
          Waiting for approval
        </p>
        <p className="mt-1 font-medium">
          {approval.toolName ?? "A tool call"}
          {approval.server ? <span className="text-muted-foreground"> · {approval.server}</span> : null}
        </p>
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
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </section>
  );
}
