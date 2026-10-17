/**
 * Shapes of every REST response, defined once and shared three ways: the
 * route handlers annotate their bodies with these (so the API cannot drift
 * from them without failing typecheck), `src/routes/index.ts` re-exports
 * them, and the typed client in `src/client/index.ts` returns them. The
 * frontend consumes them through the client instead of re-declaring types.
 *
 * Amounts are decimal strings in the token's smallest unit (stroops for
 * XLM); they are never JS numbers.
 */

export interface PlanRow {
  id: number;
  merchant: string;
  name: string;
  token: string;
  /** String amount, token's smallest unit. */
  amount: string;
  period: number;
  active: number;
  ledger: number;
}

export interface MandateRow {
  id: number;
  subscriber: string;
  merchant: string;
  plan_id: number;
  /** String amount, token's smallest unit. */
  amount: string;
  period: number;
  next_charge: number;
  last_charge: number;
  charges_made: number;
  max_charges: number;
  fee_bps: number;
  status: string;
  ended_by: string | null;
  ledger: number;
}

export interface ChargeRow {
  tx_hash: string;
  mandate_id: number;
  subscriber: string;
  merchant: string;
  /** String amount, token's smallest unit. */
  amount: string;
  /** String protocol fee in the same unit. */
  fee: string;
  charges_made: number;
  next_charge: number;
  ledger: number;
  created_at: number;
}

/** A mandate from the `/due` list: the chargeable subset of a mandate. */
export interface DueMandateRow {
  id: number;
  subscriber: string;
  merchant: string;
  next_charge: number;
  amount: string;
}

export interface PlanPage {
  plans: PlanRow[];
}

export interface MandatePage {
  mandates: MandateRow[];
}

export interface ChargePage {
  charges: ChargeRow[];
}

export interface DuePage {
  now: number;
  due: DueMandateRow[];
}

export interface MerchantSummary {
  merchant: string;
  activeMandates: number;
  /** String sum of charged amounts, token's smallest unit. */
  totalCollected: string;
  chargeCount: number;
  /** String MRR: active mandates normalised to a 30-day month. */
  mrr: string;
  /** String ARR: active mandates normalised to a 365-day year. */
  arr: string;
}

export interface SubscriberSummary {
  subscriber: string;
  mandates: MandateRow[];
  /** String sum of amount + fee paid, token's smallest unit. */
  totalPaid: string;
}

export interface StatsResponse {
  plans: number;
  mandates: number;
  activeMandates: number;
  charges: number;
  lastIndexedLedger: number;
}

export type HealthStatus = "starting" | "ok" | "catching_up";

export interface HealthResponse {
  status: HealthStatus;
  network: string;
  indexer: {
    cursor: number;
    latestLedger: number;
    lag: number | null;
    lastRunAt: string | null;
    lastError: string | null;
    /** Contract events that failed spec validation since process start. */
    mismatchedEvents: number;
  } | null;
  contracts: {
    planRegistry: string;
    vault: string;
    subscription: string;
  };
}

/** Error bodies are `{ error: <code> }`; codes are stable per endpoint. */
export interface ApiErrorResponse {
  error: string;
}
