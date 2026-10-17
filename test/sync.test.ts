import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { openDatabase, readCursor, writeCursor } from "../src/lib/db.ts";
import { Indexer, type IndexerRpc } from "../src/indexer.ts";
import { Keeper, type KeeperRpc } from "../src/keeper.ts";
import { every } from "../src/lib/loop.ts";
import type { Config } from "../src/config.ts";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const config = {
  PLAN_REGISTRY_ID: CONTRACT,
  VAULT_ID: CONTRACT,
  SUBSCRIPTION_ID: CONTRACT,
  INDEXER_START_LEDGER: 0,
  INDEXER_FETCH_CONCURRENCY: 1,
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  // A throwaway testnet key; the fake RPC never submits anything.
  KEEPER_SECRET: "SBK2VIYYSVG76E7VC3QHYARNFLY2EAQXDHRC7BMXBBGIFG74ARPRMNQM",
} as unknown as Config;

/** A raw RPC event for a plan_created in `ledger`. */
function rawEvent(ledger: number, planId: number): rpc.Api.EventResponse {
  return {
    ledger,
    txHash: `tx-${planId}`,
    topic: [
      nativeToScVal("plan_created", { type: "symbol" }),
      nativeToScVal(MERCHANT, { type: "address" }),
      nativeToScVal(planId, { type: "u64" }),
    ],
    value: nativeToScVal({ token: CONTRACT, amount: 10n, period: 60n, name: `p${planId}` }, {
      type: { token: ["symbol", "address"], amount: ["symbol", "i128"], period: ["symbol", "u64"], name: ["symbol", "string"] },
    }),
  } as unknown as rpc.Api.EventResponse;
}

interface FakeChain {
  latest: number;
  oldest: number;
  events: rpc.Api.EventResponse[];
  calls: Array<Record<string, unknown>>;
}

/**
 * An RPC node holding `events`. Range requests return events in
 * [startLedger, endLedger); cursor requests continue after the cursor
 * without an end bound, as the real API does.
 */
function fakeRpc(chain: FakeChain, pageSize = 200): IndexerRpc {
  return {
    getLatestLedger: async () => ({ sequence: chain.latest }) as never,
    getHealth: async () => ({ oldestLedger: chain.oldest, latestLedger: chain.latest }) as never,
    getEvents: async (req: Record<string, unknown>) => {
      chain.calls.push(req);
      let pool: rpc.Api.EventResponse[];
      if (req.cursor !== undefined) {
        pool = chain.events.slice(Number(req.cursor));
      } else {
        const start = req.startLedger as number;
        const end = (req.endLedger as number | undefined) ?? Infinity;
        pool = chain.events.filter((e) => e.ledger >= start && e.ledger < end);
      }
      const page = pool.slice(0, Math.min(pageSize, req.limit as number));
      const offset = chain.events.indexOf(page[page.length - 1]!) + 1;
      return { events: page, cursor: String(offset), latestLedger: chain.latest } as never;
    },
  } as unknown as IndexerRpc;
}

/**
 * Wraps the fake RPC with a small delay and records how many requests overlap.
 * The delay is what makes concurrent fetches observable to the test.
 */
function trackingRpc(chain: FakeChain, pageSize = 200) {
  const base = fakeRpc(chain, pageSize);
  let inFlight = 0;
  let maxInFlight = 0;
  const rpc = {
    ...base,
    getEvents: async (req: Record<string, unknown>) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await base.getEvents(req as never);
      } finally {
        inFlight -= 1;
      }
    },
  } as unknown as IndexerRpc;
  return { rpc, maxInFlight: () => maxInFlight };
}

function plans(db: ReturnType<typeof openDatabase>): number[] {
  return (db.prepare("SELECT id FROM plans ORDER BY id").all() as { id: number }[]).map((r) => r.id);
}

describe("indexer sync", () => {
  test("starts at the configured ledger and stops before the latest one", async () => {
    const db = openDatabase(":memory:");
    const chain: FakeChain = {
      latest: 1_100,
      oldest: 500,
      events: [rawEvent(900, 1), rawEvent(1_050, 2), rawEvent(1_100, 3)],
      calls: [],
    };
    const ix = new Indexer(db, fakeRpc(chain), { ...config, INDEXER_START_LEDGER: 1_000 });

    const r = await ix.tick();

    assert.deepEqual(plans(db), [2], "ledger 900 is before the start; 1100 is still open");
    assert.equal(r.cursor, 1_100);
    assert.equal(readCursor(db, 0), 1_100);
    assert.equal(chain.calls[0]!.startLedger, 1_000);
    assert.equal(chain.calls[0]!.endLedger, 1_100);
  });

  test("with no start configured, begins at the oldest ledger RPC serves", async () => {
    const db = openDatabase(":memory:");
    const chain: FakeChain = { latest: 700, oldest: 600, events: [rawEvent(650, 1)], calls: [] };
    await new Indexer(db, fakeRpc(chain), config).tick();
    assert.equal(chain.calls[0]!.startLedger, 600);
    assert.deepEqual(plans(db), [1]);
  });

  test("a cursor that fell out of retention restarts at the oldest ledger", async () => {
    const db = openDatabase(":memory:");
    writeCursor(db, 100);
    const chain: FakeChain = { latest: 700, oldest: 600, events: [], calls: [] };
    await new Indexer(db, fakeRpc(chain), config).tick();
    assert.equal(chain.calls[0]!.startLedger, 600);
  });

  test("follows cursor pages but ignores events past the range end", async () => {
    const db = openDatabase(":memory:");
    // Three events inside the first window and one far beyond it. With a page
    // size of 2 the second page is a cursor page, which has no end bound.
    const chain: FakeChain = {
      latest: 20_000,
      oldest: 1,
      events: [rawEvent(10, 1), rawEvent(11, 2), rawEvent(12, 3), rawEvent(15_000, 4)],
      calls: [],
    };
    const ix = new Indexer(db, fakeRpc(chain, 2), { ...config, INDEXER_START_LEDGER: 10 });

    const r = await ix.tick();

    assert.deepEqual(plans(db), [1, 2, 3]);
    assert.equal(r.cursor, 8_010, "one window of 8000 ledgers");
    assert.ok(chain.calls.some((c) => c.cursor !== undefined), "a cursor page was requested");
  });

  test("fetching windows concurrently gives the same result as sequential", async () => {
    const events = [
      rawEvent(10, 1),
      rawEvent(9_000, 2),
      rawEvent(17_000, 3),
      rawEvent(24_999, 4),
    ];
    const sequentialDb = openDatabase(":memory:");
    const sequential = new Indexer(
      sequentialDb,
      fakeRpc({ latest: 25_000, oldest: 1, events, calls: [] }),
      { ...config, INDEXER_START_LEDGER: 10 },
    );
    const sequentialApplied = await sequential.catchUp();

    const parallelDb = openDatabase(":memory:");
    const tracker = trackingRpc({ latest: 25_000, oldest: 1, events, calls: [] });
    const parallel = new Indexer(parallelDb, tracker.rpc, {
      ...config,
      INDEXER_START_LEDGER: 10,
      INDEXER_FETCH_CONCURRENCY: 3,
    });
    const parallelApplied = await parallel.catchUp();

    assert.deepEqual(plans(parallelDb), plans(sequentialDb));
    assert.equal(parallelApplied, sequentialApplied);
    assert.equal(readCursor(parallelDb, 0), readCursor(sequentialDb, 0));
    assert.ok(tracker.maxInFlight() > 1, "windows were fetched concurrently");
  });

  test("a failed window keeps the cursor at the last applied window", async () => {
    const db = openDatabase(":memory:");
    const chain: FakeChain = {
      latest: 25_000,
      oldest: 1,
      events: [rawEvent(10, 1), rawEvent(9_000, 2), rawEvent(17_000, 3)],
      calls: [],
    };
    const base = fakeRpc(chain);
    let failWindow = true;
    const flaky = {
      ...base,
      getEvents: async (req: Record<string, unknown>) => {
        if (failWindow && req.startLedger === 8_010) {
          failWindow = false;
          throw new Error("rpc unavailable");
        }
        return base.getEvents(req as never);
      },
    } as unknown as IndexerRpc;
    const ix = new Indexer(db, flaky, {
      ...config,
      INDEXER_START_LEDGER: 10,
      INDEXER_FETCH_CONCURRENCY: 3,
    });

    await assert.rejects(() => ix.tick(), /rpc unavailable/);
    assert.equal(readCursor(db, 0), 8_010, "only the window that was applied advances the cursor");
    assert.deepEqual(plans(db), [1]);

    // The next pass resumes at the failed window and finishes the range.
    const r = await ix.tick();
    assert.equal(r.cursor, 25_000);
    assert.deepEqual(plans(db), [1, 2, 3]);
  });

  test("catchUp runs passes until the cursor reaches the latest ledger", async () => {
    const db = openDatabase(":memory:");
    const chain: FakeChain = {
      latest: 20_000,
      oldest: 1,
      events: [rawEvent(10, 1), rawEvent(15_000, 2), rawEvent(19_999, 3)],
      calls: [],
    };
    const ix = new Indexer(db, fakeRpc(chain), { ...config, INDEXER_START_LEDGER: 10 });

    await ix.catchUp();

    assert.deepEqual(plans(db), [1, 2, 3]);
    assert.equal(readCursor(db, 0), 20_000);
    assert.equal(ix.status.cursor, 20_000);
  });

  test("replaying a range does not duplicate rows", async () => {
    const db = openDatabase(":memory:");
    const chain: FakeChain = { latest: 200, oldest: 1, events: [rawEvent(150, 1)], calls: [] };
    const ix = new Indexer(db, fakeRpc(chain), { ...config, INDEXER_START_LEDGER: 100 });
    await ix.tick();
    writeCursor(db, 100);
    await ix.tick();
    assert.deepEqual(plans(db), [1]);
  });
});

/** A keeper whose every charge fails at simulation, as an empty vault would. */
function failingKeeper(db: ReturnType<typeof openDatabase>, failIds: Set<number>) {
  const attempted: number[] = [];
  const server = {
    getAccount: async () => {
      throw new Error("unused");
    },
  } as unknown as KeeperRpc;
  const keeper = new Keeper(db, server, config);
  // Replace submission so the test controls which mandates fail.
  keeper.settle = async (mandateId: number) => {
    attempted.push(mandateId);
    return failIds.has(mandateId)
      ? { mandateId, status: "failed" as const, error: "InsufficientBalance" }
      : { mandateId, status: "settled" as const, txHash: `tx${mandateId}` };
  };
  return { keeper, attempted };
}

function insertDue(db: ReturnType<typeof openDatabase>, id: number, nextCharge: number): void {
  db.prepare(
    `INSERT INTO mandates (id, subscriber, merchant, plan_id, amount, period, next_charge, status, ledger)
     VALUES (?, ?, ?, 1, '10', 60, ?, 'Active', 1)`,
  ).run(id, SUBSCRIBER, MERCHANT, nextCharge);
}

describe("keeper", () => {
  test("mandates that keep failing do not starve the rest", async () => {
    const db = openDatabase(":memory:");
    // 25 old, underfunded mandates fill a whole batch ahead of mandate 100.
    const failing = new Set<number>();
    for (let id = 1; id <= 25; id += 1) {
      insertDue(db, id, 1_000 + id);
      failing.add(id);
    }
    insertDue(db, 100, 5_000);
    const { keeper, attempted } = failingKeeper(db, failing);

    await keeper.tick(10_000);
    assert.ok(!attempted.includes(100), "first pass is all old failures");

    attempted.length = 0;
    await keeper.tick(10_010);
    assert.deepEqual(attempted, [100], "failures back off; the healthy mandate gets its turn");
  });

  test("backoff doubles per failure and is capped", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const { keeper } = failingKeeper(db, new Set([1]));

    let now = 10_000;
    await keeper.tick(now);
    assert.equal(keeper.retryIn(1, now), 60);
    now += 60;
    await keeper.tick(now);
    assert.equal(keeper.retryIn(1, now), 120);
    for (let i = 0; i < 20; i += 1) {
      now += keeper.retryIn(1, now);
      await keeper.tick(now);
    }
    assert.equal(keeper.retryIn(1, now), 6 * 60 * 60);
  });

  test("a successful charge clears the backoff", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const failing = new Set([1]);
    const { keeper } = failingKeeper(db, failing);

    await keeper.tick(10_000);
    assert.ok(keeper.retryIn(1, 10_000) > 0);
    failing.delete(1);
    await keeper.tick(10_060);
    assert.equal(keeper.retryIn(1, 10_060), 0);
  });
});

describe("loop", () => {
  // Wall-clock budgets are generous: the assertion is about ordering, not
  // speed, and a starved timer under parallel CI load must not fail them.
  test("never runs two passes at once", async () => {
    let running = 0;
    let maxRunning = 0;
    let passes = 0;
    const loop = every(1, async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 15));
      running -= 1;
      passes += 1;
    });
    await new Promise((r) => setTimeout(r, 400));
    await loop.stop();
    assert.ok(passes >= 2, "the loop kept going");
    assert.equal(maxRunning, 1);
  });

  test("stop waits for a slow pass in flight", async () => {
    let finished = false;
    const loop = every(1, async () => {
      await new Promise((r) => setTimeout(r, 50));
      finished = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    await loop.stop();
    assert.equal(finished, true);
  });

  test("keeps going after a pass throws", async () => {
    let passes = 0;
    const loop = every(1, async () => {
      passes += 1;
      throw new Error("boom");
    });
    await new Promise((r) => setTimeout(r, 150));
    await loop.stop();
    assert.ok(passes >= 2);
  });
});
