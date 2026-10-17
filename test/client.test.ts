import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import type { Server } from "node:http";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { Indexer } from "../src/indexer.ts";
import { PayflowClient, PayflowApiError } from "../src/client/index.ts";
import type { Config } from "../src/config.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";

const config = {
  STELLAR_NETWORK: "testnet",
  PLAN_REGISTRY_ID: "C".repeat(56),
  VAULT_ID: "C".repeat(56),
  SUBSCRIPTION_ID: "C".repeat(56),
  CORS_ORIGIN: "*",
  PORT: 0,
} as unknown as Config;

let server: Server;
let base: string;
let client: PayflowClient;
const status = {
  cursor: 1_000,
  latest: 1_010,
  lastRunAt: Date.now(),
  lastError: null,
  mismatchedEvents: 0,
};
const db = openDatabase(":memory:");

before(async () => {
  const ix = new Indexer(db, {} as never, {} as never);
  const ev = (
    name: string,
    topics: unknown[],
    data: Record<string, unknown>,
    tx = "t",
  ): DecodedEvent => ({ name, contractId: "C", ledger: 1, txHash: tx, topics, data });

  ix.apply(ev("plan_created", [MERCHANT, 1n], {
    token: "C", amount: 10_000_000n, period: 2_592_000n, name: "Pro Monthly",
  }));
  ix.apply(ev("subscribed", [1n, SUBSCRIBER, MERCHANT], {
    plan_id: 1n, amount: 10_000_000n, period: 2_592_000n, next_charge: 1n, fee_bps: 100,
  }));
  ix.apply(ev("charged", [1n, SUBSCRIBER, MERCHANT], {
    amount: 9_900_000n, fee: 100_000n, charges_made: 1n, next_charge: 4_000_000_000n,
  }, "tx1"));

  const app = createApp(db, config, status);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
  client = new PayflowClient({ baseUrl: base });
});

after(() => {
  server.close();
  db.close();
});

describe("typed api client", () => {
  test("reads health with the shared response type", async () => {
    const health = await client.health();
    assert.equal(health.status, "ok");
    assert.equal(health.indexer?.cursor, 1_000);
    assert.equal(health.indexer?.lag, 10);
    assert.equal(health.indexer?.mismatchedEvents, 0);
    assert.equal(health.contracts.planRegistry, "C".repeat(56));
  });

  test("lists plans and sends the query parameters", async () => {
    const all = await client.plans();
    assert.equal(all.plans.length, 1);
    assert.equal(all.plans[0]?.name, "Pro Monthly");
    // Amounts stay strings end to end; the client never turns money into a float.
    assert.equal(typeof all.plans[0]?.amount, "string");

    const mine = await client.plans({ merchant: MERCHANT, limit: 10 });
    assert.equal(mine.plans.length, 1);
    const none = await client.plans({ merchant: "GNOBODY" });
    assert.equal(none.plans.length, 0);
  });

  test("fetches one plan and one mandate", async () => {
    const plan = await client.plan(1);
    assert.equal(plan.id, 1);
    const mandate = await client.mandate(1);
    assert.equal(mandate.status, "Active");
    assert.equal(mandate.fee_bps, 100);
  });

  test("mandate list, charges and due pages", async () => {
    const mandates = await client.mandates({ subscriber: SUBSCRIBER });
    assert.equal(mandates.mandates.length, 1);

    // The client serialises `ids` as a comma-separated list; unknown ids are
    // omitted server-side.
    const batch = await client.mandates({ ids: [1, 999] });
    assert.equal(batch.mandates.length, 1);
    assert.equal(batch.mandates[0]?.id, 1);

    const charges = await client.charges(1);
    assert.equal(charges.charges.length, 1);
    assert.equal(charges.charges[0]?.fee, "100000");

    const due = await client.due();
    assert.equal(due.due.length, 0);
  });

  test("summaries and stats", async () => {
    const merchant = await client.merchantSummary(MERCHANT);
    assert.equal(merchant.activeMandates, 1);
    assert.equal(merchant.totalCollected, "9900000");
    assert.equal(typeof merchant.mrr, "string");
    assert.equal(typeof merchant.arr, "string");

    const subscriber = await client.subscriberSummary(SUBSCRIBER);
    assert.equal(subscriber.totalPaid, "10000000");

    const stats = await client.stats();
    assert.equal(stats.plans, 1);
    assert.equal(stats.mandates, 1);
    assert.equal(stats.charges, 1);
  });

  test("a 404 raises PayflowApiError with the parsed error body", async () => {
    await assert.rejects(
      () => client.plan(999),
      (err: unknown) => {
        assert.ok(err instanceof PayflowApiError);
        assert.equal(err.status, 404);
        assert.deepEqual(err.body, { error: "plan_not_found" });
        return true;
      },
    );
  });

  test("accepts a bare base url with or without a trailing slash", async () => {
    assert.equal((await new PayflowClient(base).stats()).plans, 1);
    assert.equal((await new PayflowClient(base + "/").stats()).plans, 1);
  });
});
