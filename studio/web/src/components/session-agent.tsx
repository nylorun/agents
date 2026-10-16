import { useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import { createTenantClient, createTenantManagementClient } from "@/proxy-client";
import { useRead } from "@/resources/reads";
import { agentPath } from "@/agent-path";
import { sessionPath } from "@/session-list";
import { coverageCounts, type Coverage } from "@/credential-coverage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Metadata, ReadState } from "@/components/resource-layout";
import { CoverageList } from "@/components/coverage-list";
import { Section } from "@/components/agent-page";
import { AgentState, ManifestVersion, computeOf, date } from "@/components/agents";
import { EgressRow, egressOf } from "@/components/agent-egress";
import type { ManifestVersion as PinnedVersion } from "@/manifest/model";

/**
 * A session's Agent tab: where the session runs. It shows the Agent (its state and compute),
 * the manifest version the session pinned when it opened, what its MCP servers and HTTP tools
 * get from the Agent's secrets, its disk, the connections its sandbox opened while this
 * session's turns ran, and the other sessions on it. It only reads: what changes an Agent (a
 * reset, a restore, a secret) changes it for every session on it, so those are on the Agent's
 * own page.
 */
export function SessionAgentPanel({
  tenantId,
  sessionId,
  agentId,
  version,
}: {
  tenantId: string;
  sessionId: string;
  agentId: string;
  /** The manifest version the session pinned, when known. */
  version?: PinnedVersion;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const management = useMemo(() => createTenantManagementClient(tenantId), [tenantId]);
  const loadAgent = useCallback((signal: AbortSignal) => sdk.agents.get(agentId, { signal }), [sdk, agentId]);
  const read = useRead(loadAgent);
  // A Runtime without credential coverage shows none.
  const loadCoverage = useCallback(
    async (): Promise<Coverage | undefined> =>
      management.coverage({ agentId }).then(
        (coverage) => (Array.isArray(coverage.entries) ? coverage : undefined),
        () => undefined,
      ),
    [management, agentId],
  );
  const coverage = useRead(loadCoverage).data;
  const counts = coverage ? coverageCounts(coverage) : undefined;
  const s = read.data;
  const others = s?.sessions.filter((session) => session.id !== sessionId) ?? [];
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          className="min-w-0 break-all font-mono text-sm font-medium underline underline-offset-4"
          to={agentPath(agentId)}
        >
          {agentId}
        </Link>
        {s ? (
          <>
            <Badge variant="outline">{s.kind}</Badge>
            <AgentState state={s.state} />
          </>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" disabled={read.pending} onClick={read.reload}>
            Refresh
          </Button>
          <Button size="sm" asChild>
            <Link to={agentPath(agentId)}>Open Agent</Link>
          </Button>
        </div>
      </div>
      <ReadState {...read} onRetry={read.reload} />
      {read.error ? (
        <p className="text-sm text-muted-foreground">If the Agent was deleted, this session can take no new turn.</p>
      ) : null}
      {s ? (
        <>
          <Section title="What it runs">
            <Metadata
              entries={[
                ["Opened on", version ? `${version.name} v${version.version}` : "—"],
                [
                  "The Agent runs",
                  <span>
                    <ManifestVersion agent={s} />
                    {version && version.version !== s.resolvedVersion ? " — not the version the session pinned" : ""}
                  </span>,
                ],
                ["Harness", s.harness],
                [
                  "Sandbox",
                  s.kind === "none"
                    ? "None: credentials only"
                    : s.kind === "pod"
                      ? `Pod · ${computeOf(s)}${s.runtime.resources ? ` · ${s.runtime.resources.cpus} CPU · ${s.runtime.resources.memory}` : ""}`
                      : `Virtual workspace · ${computeOf(s)}`,
                ],
                [
                  "Allowed hosts",
                  s.kind === "none"
                    ? "—"
                    : s.runtime.network?.allowedHosts?.length
                      ? s.runtime.network.allowedHosts.join(", ")
                      : "None",
                ],
              ]}
            />
          </Section>
          {coverage && coverage.entries.length > 0 ? (
            <Section
              title={`What its tools get${counts ? ` · ${counts.covered} of ${coverage.entries.length} covered` : ""}`}
              actions={
                <Link className="text-sm underline underline-offset-4" to={agentPath(agentId, "secrets")}>
                  Manage secrets
                </Link>
              }
            >
              <CoverageList coverage={coverage} />
            </Section>
          ) : (
            <Section title="Secrets">
              <p className="text-sm text-muted-foreground">
                Its manifest declares no MCP server or HTTP tool that takes a credential.
              </p>
              <Link className="text-sm underline underline-offset-4" to={agentPath(agentId, "secrets")}>
                The Agent's secrets
              </Link>
            </Section>
          )}
          {s.disk ? (
            <Section title="Disk">
              <Metadata
                entries={[
                  ["Latest version", s.disk.latestVersion === null ? "None kept" : `v${s.disk.latestVersion}`],
                  ...(s.disk.operation
                    ? ([
                        [
                          "In progress",
                          `${s.disk.operation.kind}${s.disk.operation.version ? ` v${s.disk.operation.version}` : ""} since ${date(s.disk.operation.startedAt)}`,
                        ],
                      ] as [string, string][])
                    : []),
                ]}
              />
              <Link className="text-sm underline underline-offset-4" to={agentPath(agentId, "disk")}>
                Disk versions
              </Link>
            </Section>
          ) : null}
          {s.kind === "pod" ? <SessionConnections tenantId={tenantId} sessionId={sessionId} agentId={agentId} /> : null}
          <Section title="Other sessions on it">
            {others.length ? (
              <ul className="grid gap-1 text-sm">
                {others.map((session) => (
                  <li key={session.id} className="break-all">
                    <Link className="underline" to={sessionPath(agentId, session.id)}>
                      {session.id}
                    </Link>
                    {session.activeTurnId ? <span className="text-muted-foreground"> · running a turn</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No other session runs on it.</p>
            )}
            <p className="text-xs text-muted-foreground">
              A reset, a restore or a secret change on the Agent applies to every session on it.
            </p>
          </Section>
        </>
      ) : null}
    </div>
  );
}

/**
 * The connections the Agent's sandbox opened while this session had a turn running (D67). They
 * are the Agent's: another session's turn may have been running too, and each row says so.
 * Reads the Agent's `agent.egress` events and keeps those naming this session; the newest 50.
 */
function SessionConnections({
  tenantId,
  sessionId,
  agentId,
}: {
  tenantId: string;
  sessionId: string;
  agentId: string;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const types = ["agent.egress"] as const;
      const events = await sdk.agents.events(agentId, { types, signal });
      const mine = events
        .map((event) => egressOf(event))
        .filter((egress) => egress?.runningTurns?.some((turn) => turn.sessionId === sessionId));
      // One read holds at most the Tenant's Runtime limit of event items: the read was cut short
      // when one more, from after its last event, finds any.
      const last = events.at(-1);
      const truncated =
        last !== undefined &&
        (await sdk.agents.events(agentId, { types, from: last.seq + 1, signal })).length > 0;
      return { rows: mine.slice(-50).reverse(), truncated };
    },
    [sdk, agentId, sessionId],
  );
  const read = useRead(load);
  return (
    <Section
      title="Connections during this session's turns"
      actions={
        <Button variant="outline" size="sm" disabled={read.pending} onClick={read.reload}>
          Refresh
        </Button>
      }
    >
      <p className="text-xs text-muted-foreground">
        Every connection is the Agent's. Sessions on it run their turns at once, so a connection
        opened while this session's turn ran may belong to another session's turn.
      </p>
      <ReadState
        {...read}
        onRetry={read.reload}
        empty={read.data?.rows.length ? undefined : "No connection opened during its turns."}
      />
      {read.data?.rows.map((egress, index) =>
        egress ? <EgressRow key={`${egress.startedAt}:${index}`} egress={egress} sessionId={sessionId} /> : null,
      )}
      {read.data?.truncated ? (
        <Link className="text-xs underline" to={agentPath(agentId, "events")}>
          Older connections: the Agent's events
        </Link>
      ) : null}
    </Section>
  );
}
