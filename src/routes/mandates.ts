import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { limitOf } from "./helpers.ts";
import type {
  ChargePage,
  ChargeRow,
  DueMandateRow,
  DuePage,
  MandatePage,
  MandateRow,
} from "./types.ts";

/** Upper bound on ids in one batch request. */
const MAX_IDS = 100;

/**
 * Parse `?ids=1,2,3`. Returns null when any token is not a positive integer
 * and `tooMany` when the raw list exceeds MAX_IDS — checked before de-duping,
 * so a client cannot send an unbounded list.
 */
function parseIds(raw: unknown): { ids: number[]; tooMany: boolean } | null {
  const tokens = String(raw).split(",");
  const ids: number[] = [];
  for (const token of tokens) {
    const text = token.trim();
    if (!/^\d+$/.test(text)) return null;
    const id = Number(text);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    ids.push(id);
  }
  return { ids: [...new Set(ids)], tooMany: tokens.length > MAX_IDS };
}

/** `GET /mandates*` and the keeper-facing `GET /due`. */
export function mandatesRouter(db: DatabaseSync): Router {
  const r = Router();

  r.get("/mandates", (req, res) => {
    const { ids, subscriber, merchant, status } = req.query;
    const where: string[] = [];
    const args: unknown[] = [];
    if (ids !== undefined) {
      const parsed = parseIds(ids);
      if (parsed === null) {
        res.status(400).json({ error: "invalid_ids" });
        return;
      }
      if (parsed.tooMany) {
        res.status(400).json({ error: "too_many_ids" });
        return;
      }
      where.push(`id IN (${parsed.ids.map(() => "?").join(",")})`);
      args.push(...parsed.ids);
    }
    if (subscriber) {
      where.push("subscriber = ?");
      args.push(String(subscriber));
    }
    if (merchant) {
      where.push("merchant = ?");
      args.push(String(merchant));
    }
    if (status) {
      where.push("status = ?");
      args.push(String(status));
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    args.push(limitOf(req.query.limit));
    const rows = db
      // `clause` is assembled above from fixed predicates; every value is a
      // bound parameter, so this interpolation is structural, not user data.
      // eslint-disable-next-line no-restricted-syntax
      .prepare(`SELECT * FROM mandates ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...(args as never[]));
    const body: MandatePage = { mandates: rows as unknown as MandateRow[] };
    res.json(body);
  });

  r.get("/mandates/:id", (req, res) => {
    const row = db
      .prepare("SELECT * FROM mandates WHERE id = ?")
      .get(Number(req.params.id)) as unknown as MandateRow | undefined;
    if (!row) {
      res.status(404).json({ error: "mandate_not_found" });
      return;
    }
    res.json(row);
  });

  r.get("/mandates/:id/charges", (req, res) => {
    const rows = db
      .prepare("SELECT * FROM charges WHERE mandate_id = ? ORDER BY ledger DESC LIMIT ?")
      .all(Number(req.params.id), limitOf(req.query.limit));
    const body: ChargePage = { charges: rows as unknown as ChargeRow[] };
    res.json(body);
  });

  /** Mandates chargeable right now, per the indexed projection. */
  r.get("/due", (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const rows = db
      .prepare(
        `SELECT id, subscriber, merchant, next_charge, amount
           FROM mandates
          WHERE status = 'Active' AND next_charge <= ?
            AND (max_charges = 0 OR charges_made < max_charges)
          ORDER BY next_charge ASC LIMIT ?`,
      )
      .all(now, limitOf(req.query.limit));
    const body: DuePage = { now, due: rows as unknown as DueMandateRow[] };
    res.json(body);
  });

  return r;
}
