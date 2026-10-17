import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { SECONDS_PER_MONTH, SECONDS_PER_YEAR } from "./helpers.ts";
import type { MerchantSummary } from "./types.ts";

/** `GET /merchants/:address/summary`. */
export function merchantsRouter(db: DatabaseSync): Router {
  const r = Router();

  r.get("/merchants/:address/summary", (req, res) => {
    const address = String(req.params.address);
    const active = db
      .prepare(
        "SELECT COUNT(*) AS n FROM mandates WHERE merchant = ? AND status = 'Active'",
      )
      .get(address) as { n: number };
    const collected = db
      .prepare(
        "SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS total, COUNT(*) AS n FROM charges WHERE merchant = ?",
      )
      .get(address) as { total: number; n: number };
    // Recurring revenue, normalised from each mandate's own period: MRR over a
    // 30-day month and ARR over a 365-day year. Integer division truncates,
    // which is fine at base-unit (stroop) scale.
    const recurring = db
      .prepare(
        // Only module-level constants are interpolated here; the address is a
        // bound parameter, so no request data reaches the SQL text.
        // eslint-disable-next-line no-restricted-syntax
        `SELECT COALESCE(SUM(CAST(amount AS INTEGER) * ${SECONDS_PER_MONTH} / period), 0) AS mrr,
                COALESCE(SUM(CAST(amount AS INTEGER) * ${SECONDS_PER_YEAR} / period), 0) AS arr
           FROM mandates WHERE merchant = ? AND status = 'Active' AND period > 0`,
      )
      .get(address) as { mrr: number; arr: number };

    const body: MerchantSummary = {
      merchant: address,
      activeMandates: active.n,
      totalCollected: String(collected.total),
      chargeCount: collected.n,
      mrr: String(recurring.mrr),
      arr: String(recurring.arr),
    };
    res.json(body);
  });

  return r;
}
