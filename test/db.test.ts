import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { openDatabase } from "../src/lib/db.ts";

type Db = ReturnType<typeof openDatabase>;

/** The query plan SQLite would use for `sql`, as one readable line. */
function queryPlan(db: Db, sql: string, args: unknown[] = []): string {
  return db
    // A fixed prefix over fixed test SQL; no request data is involved.
    // eslint-disable-next-line no-restricted-syntax
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...(args as never[]))
    .map((r) => String((r as { detail: string }).detail))
    .join(" | ");
}

describe("summary query indexes", () => {
  test("migrate creates the covering indexes", () => {
    const db = openDatabase(":memory:");
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);

    assert.ok(names.includes("mandates_merchant_status_period_amount"));
    assert.ok(names.includes("charges_merchant_amount"));
    assert.ok(names.includes("charges_subscriber_amount_fee"));
    db.close();
  });

  test("merchant summary queries use covering indexes, not table scans", () => {
    const db = openDatabase(":memory:");

    const active = queryPlan(
      db,
      "SELECT COUNT(*) AS n FROM mandates WHERE merchant = ? AND status = 'Active'",
      ["M"],
    );
    assert.match(active, /COVERING INDEX/);
    assert.doesNotMatch(active, /SCAN mandates\b/);

    const collected = queryPlan(
      db,
      "SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS total, COUNT(*) AS n FROM charges WHERE merchant = ?",
      ["M"],
    );
    assert.match(collected, /COVERING INDEX/);
    assert.doesNotMatch(collected, /SCAN charges\b/);

    const recurring = queryPlan(
      db,
      `SELECT COALESCE(SUM(CAST(amount AS INTEGER) * 2592000 / period), 0) AS mrr
         FROM mandates WHERE merchant = ? AND status = 'Active' AND period > 0`,
      ["M"],
    );
    assert.match(recurring, /COVERING INDEX/);
    assert.doesNotMatch(recurring, /SCAN mandates\b/);

    db.close();
  });

  test("subscriber summary total uses a covering index", () => {
    const db = openDatabase(":memory:");
    const paid = queryPlan(
      db,
      "SELECT COALESCE(SUM(CAST(amount AS INTEGER) + CAST(fee AS INTEGER)), 0) AS total FROM charges WHERE subscriber = ?",
      ["S"],
    );
    assert.match(paid, /COVERING INDEX/);
    assert.doesNotMatch(paid, /SCAN charges\b/);
    db.close();
  });
});
