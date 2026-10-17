import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { limitOf } from "./helpers.ts";
import type { PlanPage, PlanRow } from "./types.ts";

/** `GET /plans` and `GET /plans/:id`. */
export function plansRouter(db: DatabaseSync): Router {
  const r = Router();

  r.get("/plans", (req, res) => {
    const { merchant } = req.query;
    const rows = merchant
      ? db
          .prepare("SELECT * FROM plans WHERE merchant = ? ORDER BY id DESC LIMIT ?")
          .all(String(merchant), limitOf(req.query.limit))
      : db
          .prepare("SELECT * FROM plans ORDER BY id DESC LIMIT ?")
          .all(limitOf(req.query.limit));
    const body: PlanPage = { plans: rows as unknown as PlanRow[] };
    res.json(body);
  });

  r.get("/plans/:id", (req, res) => {
    const row = db
      .prepare("SELECT * FROM plans WHERE id = ?")
      .get(Number(req.params.id)) as unknown as PlanRow | undefined;
    if (!row) {
      res.status(404).json({ error: "plan_not_found" });
      return;
    }
    res.json(row);
  });

  return r;
}
