import type { DatabaseSync } from "node:sqlite";
import { rpc } from "@stellar/stellar-sdk";
import type { Config } from "./config.ts";
import { readCursor, writeCursor } from "./lib/db.ts";
import {
  big,
  decodeEvent,
  num,
  specProblems,
  str,
  type DecodedEvent,
} from "./lib/stellar.ts";
import { logger } from "./lib/logger.ts";

/** RPC caps a single getEvents window; stay well inside it. */
const LEDGER_WINDOW = 8_000;
const PAGE_LIMIT = 200;

/** The RPC calls the indexer makes. Narrow so tests can supply a fake. */
export type IndexerRpc = Pick<rpc.Server, "getLatestLedger" | "getHealth" | "getEvents">;

/** What `apply` did with an event, so a pass can account for every one. */
export type ApplyOutcome = "applied" | "mismatched" | "unknown";

export interface TickResult {
  /** Events applied in this pass. */
  applied: number;
  /** Events that failed contract-spec validation; reported, not projected. */
  mismatched: number;
  /** Next ledger to read; everything before it has been indexed. */
  cursor: number;
  /** Latest ledger the RPC node reported. */
  latest: number;
}

/** Progress, exposed on /health so a stalled indexer is visible. */
export interface IndexerStatus {
  cursor: number;
  latest: number;
  lastRunAt: number | null;
  lastError: string | null;
  /**
   * Events seen since process start that did not match the contract spec.
   * A growing count means the contracts changed shape and the projection is
   * silently missing data — check the warn logs for which events.
   */
  mismatchedEvents?: number;
}

export class Indexer {
  private readonly db: DatabaseSync;
  private readonly server: IndexerRpc;
  private readonly config: Config;
  readonly status: IndexerStatus = {
    cursor: 0,
    latest: 0,
    lastRunAt: null,
    lastError: null,
    mismatchedEvents: 0,
  };
  /** Events since process start that failed spec validation. */
  get mismatchedEvents(): number {
    return this.status.mismatchedEvents ?? 0;
  }

  constructor(db: DatabaseSync, server: IndexerRpc, config: Config) {
    this.db = db;
    this.server = server;
    this.config = config;
  }

  private contractIds(): string[] {
    return [
      this.config.PLAN_REGISTRY_ID,
      this.config.VAULT_ID,
      this.config.SUBSCRIPTION_ID,
    ];
  }

  /**
   * Where this pass starts: the saved cursor; with none, the configured start
   * ledger (normally the one the contracts were deployed at); with neither,
   * the oldest ledger the RPC node still serves. The result is clamped to the
   * node's retention window, since RPC rejects ranges that begin before it.
   */
  private async firstLedger(saved: number): Promise<number> {
    const health = await this.server.getHealth();
    const oldest = health.oldestLedger;
    const wanted = saved > 0 ? saved : this.config.INDEXER_START_LEDGER;
    if (wanted > 0 && wanted >= oldest) return wanted;
    if (wanted > 0) {
      logger.warn(
        { wanted, oldest },
        "start ledger is older than the RPC retention window; events before it are lost",
      );
    }
    return oldest;
  }

  /**
   * Fetch every page of one ledger window. Cursor pages cannot carry
   * `endLedger`, so events at or past `end` are dropped here; a short page does
   * not prove the range is exhausted, only an empty page or the range end does.
   */
  private async fetchWindow(
    start: number,
    end: number,
    filters: rpc.Api.EventFilter[],
  ): Promise<rpc.Api.EventResponse[]> {
    const events: rpc.Api.EventResponse[] = [];
    let page = await this.server.getEvents({
      startLedger: start,
      endLedger: end,
      filters,
      limit: PAGE_LIMIT,
    });

    for (;;) {
      let pastEnd = false;
      for (const raw of page.events ?? []) {
        if (raw.ledger >= end) {
          pastEnd = true;
          break;
        }
        events.push(raw);
      }
      if (pastEnd || (page.events ?? []).length === 0 || !page.cursor) break;
      page = await this.server.getEvents({ cursor: page.cursor, filters, limit: PAGE_LIMIT });
    }
    return events;
  }

  /**
   * Index ledgers [cursor, min(cursor + LEDGER_WINDOW * concurrency, latest)).
   *
   * Up to `INDEXER_FETCH_CONCURRENCY` windows are fetched in parallel, but
   * their events are applied in ledger order and the cursor only advances after
   * a window has been applied. If a fetch fails, windows already applied keep
   * their cursor and the next pass resumes at the failed one. A crash mid-range
   * replays that range on restart; every apply path is idempotent so that is
   * safe.
   */
  async tick(): Promise<TickResult> {
    const latest = (await this.server.getLatestLedger()).sequence;
    const start = await this.firstLedger(readCursor(this.db, 0));

    this.status.latest = latest;
    if (start > latest) {
      this.status.cursor = start;
      return { applied: 0, mismatched: 0, cursor: start, latest };
    }

    // endLedger is exclusive. Including `latest` would read a ledger that is
    // still being ingested and could miss part of it.
    const end = Math.min(start + LEDGER_WINDOW, latest);
    if (end <= start) {
      this.status.cursor = start;
      return { applied: 0, mismatched: 0, cursor: start, latest };
    }

    const filters: rpc.Api.EventFilter[] = [
      { type: "contract", contractIds: this.contractIds() },
    ];
    const concurrency = Math.max(1, this.config.INDEXER_FETCH_CONCURRENCY ?? 1);
    const windows: Array<{ start: number; end: number }> = [];
    for (let s = start; s < latest && windows.length < concurrency; s += LEDGER_WINDOW) {
      windows.push({ start: s, end: Math.min(s + LEDGER_WINDOW, latest) });
    }

    const fetched = await Promise.allSettled(
      windows.map((w) => this.fetchWindow(w.start, w.end, filters)),
    );
    let applied = 0;
    let mismatched = 0;
    let cursor = start;
    let failure: unknown;

    for (let i = 0; i < windows.length; i += 1) {
      const result = fetched[i]!;
      if (result.status === "rejected") {
        failure = result.reason;
        break;
      }
      for (const raw of result.value) {
        const decoded = decodeEvent(raw);
        if (!decoded) continue;
        if (this.apply(decoded) !== "mismatched") applied += 1;
        else mismatched += 1;
      }
      // Only advance after this window is applied, so a later failure resumes
      // here instead of replaying what already landed.
      cursor = windows[i]!.end;
      writeCursor(this.db, cursor);
    }

    this.status.cursor = cursor;
    if (failure !== undefined) throw failure;
    return { applied, mismatched, cursor, latest };
  }

  /** Run passes until the cursor reaches the RPC's latest ledger. */
  async catchUp(maxPasses = 1_000): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxPasses; i += 1) {
      const r = await this.tick();
      total += r.applied;
      if (r.cursor >= r.latest) break;
    }
    return total;
  }

  /**
   * Route a decoded event to its projection, but only after it matches the
   * committed contract spec (`src/lib/event_spec.json`).
   *
   * An event that fails validation is logged with every problem and counted
   * in `mismatchedEvents`; it is never projected, so a renamed contract field
   * surfaces immediately instead of silently storing zeros. Events whose name
   * the spec does not cover are left to the switch below, which ignores
   * unknown names.
   */
  apply(e: DecodedEvent): ApplyOutcome {
    const problems = specProblems(e);
    if (problems !== null && problems.length > 0) {
      this.status.mismatchedEvents = this.mismatchedEvents + 1;
      logger.warn(
        {
          name: e.name,
          contractId: e.contractId,
          ledger: e.ledger,
          txHash: e.txHash,
          problems,
        },
        "event does not match the contract spec; not applied",
      );
      return "mismatched";
    }

    switch (e.name) {
      case "plan_created":
        this.onPlanCreated(e);
        return "applied";
      case "plan_status_changed":
        this.onPlanStatus(e);
        return "applied";
      case "subscribed":
        this.onSubscribed(e);
        return "applied";
      case "charged":
        this.onCharged(e);
        return "applied";
      case "cancelled":
        this.onStatus(e, "Cancelled", "subscriber");
        return "applied";
      case "mandate_ended":
        this.onStatus(e, "Cancelled", "merchant");
        return "applied";
      case "mandate_completed":
        this.onStatus(e, "Completed");
        return "applied";
      case "pause_changed":
        this.onPauseChanged(e);
        return "applied";
      case "deposit":
      case "withdraw":
      case "debit":
        this.onVaultEvent(e);
        return "applied";
      default:
        logger.debug({ name: e.name }, "unhandled event");
        return "unknown";
    }
  }

  private onPlanCreated(e: DecodedEvent): void {
    const [merchant, planId] = e.topics;
    this.db
      .prepare(
        `INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET
           merchant = excluded.merchant, name = excluded.name,
           token = excluded.token,
           amount = excluded.amount, period = excluded.period`,
      )
      .run(
        num(planId),
        str(merchant),
        str(e.data.name),
        str(e.data.token),
        big(e.data.amount),
        num(e.data.period),
        e.ledger,
      );
  }

  private onPlanStatus(e: DecodedEvent): void {
    const [, planId] = e.topics;
    this.db
      .prepare("UPDATE plans SET active = ? WHERE id = ?")
      .run(e.data.active ? 1 : 0, num(planId));
  }

  private onSubscribed(e: DecodedEvent): void {
    const [mandateId, subscriber, merchant] = e.topics;
    this.db
      .prepare(
        `INSERT INTO mandates
           (id, subscriber, merchant, plan_id, amount, period, next_charge,
            last_charge, charges_made, max_charges, fee_bps, status, ledger)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 'Active', ?)
         ON CONFLICT(id) DO UPDATE SET
           subscriber  = excluded.subscriber,
           merchant    = excluded.merchant,
           max_charges = excluded.max_charges,
           fee_bps     = excluded.fee_bps`,
      )
      .run(
        num(mandateId),
        str(subscriber),
        str(merchant),
        num(e.data.plan_id),
        big(e.data.amount),
        num(e.data.period),
        num(e.data.next_charge),
        num(e.data.max_charges),
        num(e.data.fee_bps),
        e.ledger,
      );
  }

  private onCharged(e: DecodedEvent): void {
    const [mandateId, subscriber, merchant] = e.topics;
    const id = num(mandateId);

    this.db
      .prepare(
        `INSERT OR IGNORE INTO charges
           (tx_hash, mandate_id, subscriber, merchant, amount, fee,
            charges_made, next_charge, ledger, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.txHash,
        id,
        str(subscriber),
        str(merchant),
        big(e.data.amount),
        big(e.data.fee),
        num(e.data.charges_made),
        num(e.data.next_charge),
        e.ledger,
        Date.now(),
      );

    // The Charged event carries next_charge but not last_charge. The contract
    // sets next_charge = now + period, so the settlement time is recoverable
    // from the mandate's own period.
    // Guard against out-of-order delivery: never move a mandate backwards.
    this.db
      .prepare(
        `UPDATE mandates
            SET charges_made = ?,
                next_charge  = ?,
                last_charge  = MAX(0, ? - period)
          WHERE id = ? AND charges_made < ?`,
      )
      .run(
        num(e.data.charges_made),
        num(e.data.next_charge),
        num(e.data.next_charge),
        id,
        num(e.data.charges_made),
      );
  }

  /** `endedBy` records which side cancelled; completion leaves it null. */
  private onStatus(e: DecodedEvent, status: string, endedBy: string | null = null): void {
    const [mandateId] = e.topics;
    this.db
      .prepare("UPDATE mandates SET status = ?, ended_by = ? WHERE id = ?")
      .run(status, endedBy, num(mandateId));
  }

  private onPauseChanged(e: DecodedEvent): void {
    const [mandateId] = e.topics;
    this.db
      .prepare(
        `UPDATE mandates SET status = ?
          WHERE id = ? AND status IN ('Active','Paused')`,
      )
      .run(e.data.paused ? "Paused" : "Active", num(mandateId));
  }

  private onVaultEvent(e: DecodedEvent): void {
    const [user, token, counterparty] = e.topics;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO vault_events
           (tx_hash, kind, user, token, counterparty, amount, balance, ledger)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.txHash,
        e.name,
        str(user),
        str(token),
        counterparty === undefined ? null : str(counterparty),
        big(e.data.amount),
        big(e.data.balance),
        e.ledger,
      );
  }
}
