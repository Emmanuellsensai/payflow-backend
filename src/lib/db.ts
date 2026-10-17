import { DatabaseSync } from "node:sqlite";

/**
 * Schema notes.
 *
 * `plans` and `mandates` are projections rebuilt from contract events, so every
 * write is an idempotent upsert keyed on the on-chain id. Re-indexing the same
 * ledger range twice must not change the result.
 *
 * `charges` is an append-only log keyed on (tx_hash, mandate_id) so a replayed
 * ledger cannot double-count revenue.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursor (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  last_ledger  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id          INTEGER PRIMARY KEY,
  merchant    TEXT    NOT NULL,
  name        TEXT    NOT NULL DEFAULT '',
  token       TEXT    NOT NULL,
  amount      TEXT    NOT NULL,
  period      INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  ledger      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plans_merchant ON plans(merchant);

CREATE TABLE IF NOT EXISTS mandates (
  id           INTEGER PRIMARY KEY,
  subscriber   TEXT    NOT NULL,
  merchant     TEXT    NOT NULL,
  plan_id      INTEGER NOT NULL,
  amount       TEXT    NOT NULL,
  period       INTEGER NOT NULL,
  next_charge  INTEGER NOT NULL,
  last_charge  INTEGER NOT NULL DEFAULT 0,
  charges_made INTEGER NOT NULL DEFAULT 0,
  max_charges  INTEGER NOT NULL DEFAULT 0,
  fee_bps      INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'Active',
  -- 'subscriber' or 'merchant' once cancelled; NULL otherwise.
  ended_by     TEXT,
  ledger       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mandates_subscriber ON mandates(subscriber);
CREATE INDEX IF NOT EXISTS mandates_merchant   ON mandates(merchant);
CREATE INDEX IF NOT EXISTS mandates_due        ON mandates(status, next_charge);

CREATE TABLE IF NOT EXISTS charges (
  tx_hash      TEXT    NOT NULL,
  mandate_id   INTEGER NOT NULL,
  subscriber   TEXT    NOT NULL,
  merchant     TEXT    NOT NULL,
  amount       TEXT    NOT NULL,
  fee          TEXT    NOT NULL,
  charges_made INTEGER NOT NULL,
  next_charge  INTEGER NOT NULL,
  ledger       INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, mandate_id)
);
CREATE INDEX IF NOT EXISTS charges_merchant   ON charges(merchant);
CREATE INDEX IF NOT EXISTS charges_subscriber ON charges(subscriber);
CREATE INDEX IF NOT EXISTS charges_mandate    ON charges(mandate_id);

CREATE TABLE IF NOT EXISTS vault_events (
  tx_hash      TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  user         TEXT    NOT NULL,
  token        TEXT    NOT NULL,
  counterparty TEXT,
  amount       TEXT    NOT NULL,
  balance      TEXT    NOT NULL,
  ledger       INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, kind, user, amount)
);
CREATE INDEX IF NOT EXISTS vault_events_user ON vault_events(user);
`;

/**
 * Columns added after the first deployment. CREATE TABLE IF NOT EXISTS leaves
 * an existing table alone, so new columns have to be added explicitly. Each
 * entry is applied only when absent, which keeps repeated startups a no-op.
 */
const ADDED_COLUMNS: ReadonlyArray<[table: string, column: string, decl: string]> = [
  ["plans", "name", "TEXT NOT NULL DEFAULT ''"],
  ["mandates", "fee_bps", "INTEGER NOT NULL DEFAULT 0"],
  ["mandates", "ended_by", "TEXT"],
];

/**
 * Indexes added after the first deployment. Each is created only when its
 * table exists (a migration may run against a partially built database) and
 * `IF NOT EXISTS` keeps repeated startups a no-op. These are covering indexes
 * for the merchant and subscriber summary routes: the aggregates read only
 * the indexed columns, so the planner never touches the table b-tree.
 */
const ADDED_INDEXES: ReadonlyArray<[table: string, name: string, columns: string]> = [
  ["mandates", "mandates_merchant_status_period_amount", "merchant, status, period, amount"],
  ["charges", "charges_merchant_amount", "merchant, amount"],
  ["charges", "charges_subscriber_amount_fee", "subscriber, amount, fee"],
];

export function migrate(db: DatabaseSync): void {
  for (const [table, column, decl] of ADDED_COLUMNS) {
    const columns = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as {
      name: string;
    }[];
    // An empty result means the table itself is absent, so there is nothing to
    // migrate -- SCHEMA will have created it with the column already present.
    if (columns.length === 0) continue;
    if (!columns.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }

  for (const [table, name, columns] of ADDED_INDEXES) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (exists) db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${columns})`);
  }
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function readCursor(db: DatabaseSync, fallback: number): number {
  const row = db.prepare("SELECT last_ledger FROM cursor WHERE id = 1").get() as
    | { last_ledger: number }
    | undefined;
  return row?.last_ledger ?? fallback;
}

export function writeCursor(db: DatabaseSync, ledger: number): void {
  db.prepare(
    `INSERT INTO cursor (id, last_ledger) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_ledger = excluded.last_ledger`,
  ).run(ledger);
}
