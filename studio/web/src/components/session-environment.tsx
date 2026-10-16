import { useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import { createTenantClient, createTenantManagementClient } from "@/proxy-client";
import { useRead } from "@/resources/reads";
import { environmentPath } from "@/environment-path";
import { sessionHref, type SessionEnvironment } from "@/session-open";
import { coverageCounts, type Coverage } from "@/credential-coverage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Metadata, ReadState } from "@/components/resource-layout";
import { CoverageList } from "@/components/coverage-list";
import { Section } from "@/components/environment-page";
import { date, stateOf } from "@/components/environments";
import { EgressRow, egressOf } from "@/components/environment-egress";

/**
 * A session's Environment tab: where the session runs. It shows the Environment the session
 * names (or that it names none), the recipe version it opened on, what this agent's MCP servers
 * and HTTP tools get from its secrets, its disk, the connections its sandbox opened while this
 * session's turns ran, and the other sessions that share it. It only
 * reads: what changes an Environment (a reset, a restore, a secret) changes it for every session
 * that names it, so those are on the Environment's own page.
 */
export function SessionEnvironmentPanel({
  tenantId,
  sessionId,
  agentId,
  environment,
}: {
  tenantId: string;
  sessionId: string;
  agentId: string;
  /** `null`: the session names none; undefined: not known yet. */
  environment: SessionEnvironment | null | undefined;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const management = useMemo(() => createTenantManagementClient(tenantId), [tenantId]);
  const id = environment?.id;
  const known = environment !== undefined;
  const loadEnvironment = useCallback(
    async (signal: AbortSignal) =>
      id === undefined ? undefined : sdk.environments.get(id, { signal }),
    [sdk, id],
  );
  const read = useRead(loadEnvironment);
  // A Runtime without credential coverage shows none.
  const loadCoverage = useCallback(
    async (): Promise<Coverage | undefined> =>
      !known
        ? undefined
        : management
            .coverage({ agentId, ...(id === undefined ? {} : { environmentId: id }) })
            .then(
              (coverage) => (Array.isArray(coverage.entries) ? coverage : undefined),
              () => undefined,
            ),
    [management, agentId, id, known],
  );
  const coverage = useRead(loadCoverage).data;
  const counts = coverage ? coverageCounts(coverage) : undefined;

  if (environment === undefined)
    return <p className="p-4 text-sm text-muted-foreground">Loading the session's Environment…</p>;

  const credentials =
    coverage && coverage.entries.length > 0 ? (
      <Section
        title={`What this agent's tools get${counts ? ` · ${counts.covered} of ${coverage.entries.length} covered` : ""}`}
        actions={
          id === undefined ? undefined : (
            <Link
              className="text-sm underline underline-offset-4"
              to={environmentPath(id, "secrets")}
            >
              Manage secrets
            </Link>
          )
        }
      >
        <CoverageList coverage={coverage} />
      </Section>
    ) : null;

  if (environment === null)
    return (
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        <Section title="No Environment">
          <p className="text-sm text-muted-foreground">
            This session names no Environment: it has no sandbox and no secrets. Its
            MCP servers and HTTP tools are called without credentials, and it has no
            shell or disk. A session names its Environment when it opens.
          </p>
          <Button variant="outline" size="sm" asChild>
            <Link to="/environments">Environments</Link>
          </Button>
        </Section>
        {credentials}
      </div>
    );

  const s = read.data;
  const others = s?.sessions.filter((session) => session.id !== sessionId) ?? [];
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          className="min-w-0 break-all font-mono text-sm font-medium underline underline-offset-4"
          to={environmentPath(environment.id)}
        >
          {environment.id}
        </Link>
        {s ? (
          <>
            <Badge variant="outline">{s.kind}</Badge>
            <Badge variant="secondary">{stateOf(s)}</Badge>
          </>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" disabled={read.pending} onClick={read.reload}>
            Refresh
          </Button>
          <Button size="sm" asChild>
            <Link to={environmentPath(environment.id)}>Open Environment</Link>
          </Button>
        </div>
      </div>
      <ReadState {...read} onRetry={read.reload} />
      {read.error ? (
        <p className="text-sm text-muted-foreground">
          If the Environment was deleted, this session can take no new turn.
        </p>
      ) : null}
      {s ? (
        <>
          <Section title="Recipe">
            <Metadata
              entries={[
                [
                  "Opened on",
                  environment.version === undefined ? "—" : `Version ${environment.version}`,
                ],
                [
                  "Now",
                  `Version ${s.version}${
                    environment.version !== undefined && environment.version !== s.version
                      ? " — changed since the session opened"
                      : ""
                  }`,
                ],
                ["Harness", s.manifest.harness],
                [
                  "Sandbox",
                  s.kind === "none"
                    ? "None: credentials only"
                    : s.kind === "pod"
                      ? `Pod${s.manifest.resources ? ` · ${s.manifest.resources.cpus} CPU · ${s.manifest.resources.memory}` : ""}`
                      : "Virtual workspace",
                ],
                [
                  "Allowed hosts",
                  s.kind === "none"
                    ? "—"
                    : s.manifest.network?.allowedHosts?.length
                      ? s.manifest.network.allowedHosts.join(", ")
                      : "None",
                ],
              ]}
            />
          </Section>
          {credentials ?? (
            <Section title="Secrets">
              <p className="text-sm text-muted-foreground">
                This agent declares no MCP server or HTTP tool that takes a credential.
              </p>
              <Link
                className="text-sm underline underline-offset-4"
                to={environmentPath(environment.id, "secrets")}
              >
                The Environment's secrets
              </Link>
            </Section>
          )}
          {s.disk ? (
            <Section title="Disk">
              <Metadata
                entries={[
                  [
                    "Latest version",
                    s.disk.latestVersion === null ? "None kept" : `v${s.disk.latestVersion}`,
                  ],
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
              <Link
                className="text-sm underline underline-offset-4"
                to={environmentPath(environment.id, "disk")}
              >
                Disk versions
              </Link>
            </Section>
          ) : null}
          {s.kind === "pod" ? (
            <SessionConnections tenantId={tenantId} sessionId={sessionId} environmentId={environment.id} />
          ) : null}
          <Section title="Shared with">
            {others.length ? (
              <ul className="grid gap-1 text-sm">
                {others.map((session) => (
                  <li key={session.id} className="break-all">
                    <Link className="underline" to={sessionHref(session.id)}>
                      {session.id}
                    </Link>
                    {session.activeTurnId ? (
                      <span className="text-muted-foreground"> · running a turn</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No other session names it.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              A reset, a restore or a secret change on the Environment applies to every
              session that names it.
            </p>
          </Section>
        </>
      ) : null}
    </div>
  );
}

/**
 * The connections the Environment's sandbox opened while this session had a turn running (D67).
 * They are the Environment's: another session's turn may have been running too, and each row
 * says so. Reads the Environment's `environment.egress` events and keeps those naming this
 * session; the newest 50.
 */
function SessionConnections({
  tenantId,
  sessionId,
  environmentId,
}: {
  tenantId: string;
  sessionId: string;
  environmentId: string;
}) {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const types = ["environment.egress"] as const;
      const events = await sdk.environments.events(environmentId, { types, signal });
      const mine = events
        .map((event) => egressOf(event))
        .filter((egress) => egress?.runningTurns?.some((turn) => turn.sessionId === sessionId));
      // One read holds at most the Tenant's Runtime limit `environmentEventItems`: the read was
      // cut short when one more, from after its last event, finds any.
      const last = events.at(-1);
      const truncated =
        last !== undefined &&
        (await sdk.environments.events(environmentId, { types, from: last.seq + 1, signal })).length > 0;
      return { rows: mine.slice(-50).reverse(), truncated };
    },
    [sdk, environmentId, sessionId],
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
        Every connection is the Environment's. Sessions on it run their turns at once, so a
        connection opened while this session's turn ran may belong to another session's turn.
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
        <Link className="text-xs underline" to={environmentPath(environmentId, "events")}>
          Older connections: the Environment's events
        </Link>
      ) : null}
    </Section>
  );
}
