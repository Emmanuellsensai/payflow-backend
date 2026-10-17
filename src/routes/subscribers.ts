import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import type { MandateRow, SubscriberSummary } from "./types.ts";

/** `GET /subscribers/:address/summary`. */
export function subscribersRouter(db: DatabaseSync): Router {
  const r = Router();

  r.get("/subscribers/:address/summary", (req, res) => {
    const address = String(req.params.address);
    const mandates = db
      .prepare("SELECT * FROM mandates WHERE subscriber = ? ORDER BY id DESC")
      .all(address) as unknown as MandateRow[];
    const paid = db
      .prepare(
        "SELECT COALESCE(SUM(CAST(amount AS INTEGER) + CAST(fee AS INTEGER)), 0) AS total FROM charges WHERE subscriber = ?",
      )
      .get(address) as { total: number };
    const body: SubscriberSummary = {
      subscriber: address,
      mandates,
      totalPaid: String(paid.total),
    };
    res.json(body);
  });

  return r;
}
