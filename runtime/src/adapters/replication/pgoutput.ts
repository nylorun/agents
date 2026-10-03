/**
 * The stream relay's change source on Postgres logical replication (Durable Streams §7.1,
 * §7.4, §7.6): a persistent `pgoutput` slot on the `nylorun_stream_relay` publication, read
 * with `pg-logical-replication`. The only file importing it (with `pg`, which it needs).
 *
 * - **One reader per slot.** Postgres lets one connection hold a slot, so every Runtime
 *   process can run a source and exactly one is active; the others retry every few seconds
 *   and take over when it goes away. The slot is the leader election.
 * - **Acknowledged only on request.** The library acknowledges the last position it
 *   *received* on a timer; that is turned off (`timeoutSeconds: 0`) and keepalives are
 *   answered by the relay, which acknowledges only what S2 has.
 * - **Always from the confirmed position.** Each attempt is a new connection that starts at
 *   `0/0`, which Postgres reads as the slot's confirmed position, so a reconnect replays
 *   whatever was received but not acknowledged.
 * - **Fresh slots.** A missing slot is created; a slot Postgres invalidated
 *   (`max_slot_wal_keep_size`) is dropped and created again. Either way the relay must
 *   reconcile the record with S2; that is recorded in `relay_slots` until `reconciled()`, so a
 *   crash during reconciliation, or another process winning the slot, does not lose it.
 */
import pg from "pg";
import { LogicalReplicationService, PgoutputPlugin } from "pg-logical-replication";
import type {
  ChangeHandlers,
  ChangeSource,
  CommittedTx,
  RecordRow,
} from "../../streams/relay/types.js";

export interface PgoutputSourceOptions {
  /** A Postgres URL whose role may replicate (`REPLICATION`) and read `nylorun_streams`. */
  connectionString: string;
  /**
   * The Tenant the database holds. The record has no Tenant column (one Tenant per
   * database), so every row read is this Tenant's.
   */
  tenantId: string;
  /** Default `nylorun_stream_relay`. */
  slot?: string;
  /** Default `nylorun_stream_relay`. */
  publication?: string;
  /** The schema of the record tables. Default `nylorun_streams`. */
  schema?: string;
  /** Wait between attempts to take the slot. Default 5 s. */
  retryMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export const DEFAULT_RELAY_SLOT = "nylorun_stream_relay";

interface DecodingTx {
  rows: RecordRow[];
}

export function createPgoutputSource(options: PgoutputSourceOptions): ChangeSource {
  const slot = options.slot ?? DEFAULT_RELAY_SLOT;
  const publication = options.publication ?? "nylorun_stream_relay";
  const schema = options.schema ?? "nylorun_streams";
  const retryMs = options.retryMs ?? 5000;
  const { tenantId } = options;
  const log = options.log ?? (() => {});
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: 2,
    application_name: "nylorun-stream-relay",
  });
  let service: LogicalReplicationService | undefined;
  let stopped = false;
  let running: Promise<void> | undefined;
  let wake: (() => void) | undefined;

  /** Creates the slot when missing or lost; true when the record must be reconciled. */
  async function prepareSlot(): Promise<boolean> {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ wal_status: string | null; active: boolean }>(
        "SELECT wal_status, active FROM pg_replication_slots WHERE slot_name = $1",
        [slot],
      );
      const existing = rows[0];
      if (existing?.wal_status === "lost" && !existing.active) {
        log("replication slot was invalidated; creating it again", { slot });
        await client.query("SELECT pg_drop_replication_slot($1)", [slot]);
      }
      if (!existing || existing.wal_status === "lost") {
        try {
          await client.query("SELECT pg_create_logical_replication_slot($1, 'pgoutput')", [slot]);
          log("replication slot created", { slot });
          await client.query(
            `INSERT INTO ${schema}.relay_slots (slot_name, reconcile_pending) VALUES ($1, true)
             ON CONFLICT (slot_name) DO UPDATE SET reconcile_pending = true`,
            [slot],
          );
        } catch (error) {
          // Another process created it first; its row says whether to reconcile.
          if ((error as { code?: string }).code !== "42710") throw error;
        }
      }
      const pending = await client.query<{ reconcile_pending: boolean }>(
        `SELECT reconcile_pending FROM ${schema}.relay_slots WHERE slot_name = $1`,
        [slot],
      );
      // A slot created before this table knew it: reconcile once to be sure.
      return pending.rows[0]?.reconcile_pending ?? true;
    } finally {
      client.release();
    }
  }

  async function attempt(handlers: ChangeHandlers): Promise<void> {
    const fresh = await prepareSlot();
    // `stop()` during `prepareSlot` had no service to stop: do not start one it cannot.
    if (stopped) return;
    const current = new LogicalReplicationService(
      { connectionString: options.connectionString, application_name: "nylorun-stream-relay" },
      { acknowledge: { auto: false, timeoutSeconds: 0 }, flowControl: { enabled: false } },
    );
    service = current;
    let decoding: DecodingTx | undefined;
    current.on("start", () => handlers.onActive({ fresh }));
    current.on("data", (_lsn: string, message: Record<string, any>) => {
      switch (message.tag) {
        case "begin":
          decoding = { rows: [] };
          break;
        case "insert":
          if (
            decoding &&
            message.relation?.schema === schema &&
            message.relation?.name === "session_events"
          )
            decoding.rows.push(rowOf(message.new, tenantId));
          break;
        case "commit": {
          const tx: CommittedTx = { endLsn: message.commitEndLsn, rows: decoding?.rows ?? [] };
          decoding = undefined;
          // A transaction with no record rows still moves the slot once acknowledged.
          handlers.onTx(tx);
          break;
        }
      }
    });
    current.on("heartbeat", (lsn: string, _timestamp: number, shouldRespond: boolean) => {
      // Mid-transaction, the server's position may be past rows not yet delivered.
      if (!shouldRespond || decoding) return;
      const position = handlers.onKeepalive(lsn);
      if (position) void current.acknowledge(position).catch(() => {});
    });
    current.on("error", () => {});
    const plugin = new PgoutputPlugin({ protoVersion: 1, publicationNames: [publication] });
    // Resolves when replication ends, rejects when it fails; `0/0` = the slot's confirmed position.
    await current.subscribe(plugin, slot, "0/00000000");
  }

  async function run(handlers: ChangeHandlers): Promise<void> {
    while (!stopped) {
      let failure: unknown;
      try {
        await attempt(handlers);
      } catch (error) {
        failure = error;
      }
      if (stopped) break;
      const busy = (failure as { code?: string } | undefined)?.code === "55006";
      // Another process holds the slot: it is the relay. Anything else: report and retry.
      handlers.onInactive(busy ? undefined : failure ?? new Error("replication ended"));
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, retryMs).unref?.();
      });
      wake = undefined;
    }
  }

  return {
    start(handlers) {
      if (running) throw new Error("The change source is already started");
      running = run(handlers);
    },
    acknowledge(lsn) {
      void service?.acknowledge(lsn).catch(() => {});
    },
    async reconciled() {
      await pool.query(`UPDATE ${schema}.relay_slots SET reconcile_pending = false WHERE slot_name = $1`, [
        slot,
      ]);
    },
    async lag() {
      // An idle relay confirms one byte past the last record, ahead of pg_current_wal_lsn():
      // that is no lag, not -1 (the Admin status refuses a negative lag).
      const { rows } = await pool.query<{ lag: string | null }>(
        `SELECT GREATEST(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn), 0)::text AS lag
         FROM pg_replication_slots WHERE slot_name = $1`,
        [slot],
      );
      return rows[0]?.lag == null ? undefined : Number(rows[0].lag);
    },
    async stop() {
      stopped = true;
      wake?.();
      await service?.stop().catch(() => undefined);
      await running?.catch(() => undefined);
      await pool.end().catch(() => undefined);
    },
  };
}

/** A decoded `session_events` row (`pg` parses `json`; `bigint` arrives as text). */
function rowOf(values: Record<string, any>, tenantId: string): RecordRow {
  return {
    tenantId,
    sessionId: values.session_id,
    seq: Number(values.seq),
    generation: Number(values.generation),
    body: typeof values.body === "string" ? JSON.parse(values.body) : values.body,
  };
}
