import type { StudioTenantInfo } from "@/config";

export function TenantOverview({
  tenant,
  waitingForAgents = false,
}: {
  tenant: StudioTenantInfo;
  waitingForAgents?: boolean;
}) {
  return (
    <section className="mx-auto w-full max-w-3xl flex-1 space-y-6 overflow-auto p-8">
      <h1 className="text-2xl font-semibold">Runtime tenant</h1>
      <dl className="space-y-4 rounded-lg border p-5">
        <div>
          <dt className="text-sm text-muted-foreground">Name</dt>
          <dd className="mt-1 font-medium">{tenant.name}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Tenant ID</dt>
          <dd className="mt-1 break-all font-mono text-sm">{tenant.id}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Runtime</dt>
          <dd className="mt-1 text-sm">Connected</dd>
        </div>
      </dl>
      <div className="space-y-2 rounded-lg bg-muted p-4 text-sm text-muted-foreground">
        {waitingForAgents ? <p>No agents registered yet.</p> : null}
        <p>
          Use the Runtime through the SDK, CLI, or your own client. Agents and
          sessions appear here as you use them. See the{" "}
          <a
            className="text-primary underline underline-offset-4"
            href="https://docs.nylorun.com"
            target="_blank"
            rel="noopener noreferrer"
          >
            documentation
          </a>{" "}
          to get started.
        </p>
      </div>
    </section>
  );
}
