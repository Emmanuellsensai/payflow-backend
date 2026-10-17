import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { readCursor } from "../lib/db.ts";
import type { StatsResponse } from "./types.ts";

/** `GET /stats`. */
export function statsRouter(db: DatabaseSync): Router {
  const r = Router();

  r.get("/stats", (_req, res) => {
    const one = (sql: string): number =>
      (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;
    const body: StatsResponse = {
      plans: one("SELECT COUNT(*) AS n FROM plans"),
      mandates: one("SELECT COUNT(*) AS n FROM mandates"),
      activeMandates: one("SELECT COUNT(*) AS n FROM mandates WHERE status = 'Active'"),
      charges: one("SELECT COUNT(*) AS n FROM charges"),
      lastIndexedLedger: readCursor(db, 0),
    };
    res.json(body);
  });

  return r;
}
