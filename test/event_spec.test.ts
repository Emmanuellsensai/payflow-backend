import assert from "node:assert/strict";
import { test, describe, beforeEach } from "node:test";
import { nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { Indexer, type IndexerRpc } from "../src/indexer.ts";
import { specProblems, type DecodedEvent } from "../src/lib/stellar.ts";
import type { Config } from "../src/config.ts";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function event(
  name: string,
  topics: unknown[],
  data: Record<string, unknown>,
): DecodedEvent {
  return { name, contractId: "C", ledger: 100, txHash: "tx-" + name, topics, data };
}

describe("contract spec validation", () => {
  let d: ReturnType<typeof openDatabase>;
  let ix: Indexer;

  beforeEach(() => {
    d = openDatabase(":memory:");
    ix = new Indexer(d, {} as never, {} as never);
  });

  test("a well-formed event passes the spec", () => {
    const problems = specProblems(
      event("plan_created", [MERCHANT, 1n], {
        token: TOKEN,
        amount: 10_000_000n,
        period: 2_592_000n,
        name: "Pro Monthly",
      }),
    );
    assert.deepEqual(problems, []);
  });

  test("a renamed event field is reported, not silently stored as 0", () => {
    // The contract renamed `next_charge` to `charge_after`: the old field is
    // missing and the new one is unknown. Both must surface as problems.
    const bad = event("charged", [1n, SUBSCRIBER, MERCHANT], {
      amount: 9_900_000n,
      fee: 100_000n,
      charges_made: 1n,
      charge_after: 1_700_060_000n,
    });
    const problems = specProblems(bad);
    assert.ok(problems, "the event is spec-covered");
    assert.ok(
      problems!.some((p) => p.includes("next_charge") && p.includes("missing")),
      `missing field reported: ${problems!.join("; ")}`,
    );
    assert.ok(
      problems!.some((p) => p.includes("charge_after")),
      "the unknown replacement field is reported too",
    );

    ix.apply(event("subscribed", [1n, SUBSCRIBER, MERCHANT], {
      plan_id: 1n,
      amount: 10_000_000n,
      period: 2_592_000n,
      next_charge: 1_700_000_000n,
    }));
    const outcome = ix.apply(bad);
    assert.equal(outcome, "mismatched");
    assert.equal(ix.mismatchedEvents, 1, "the mismatch is counted");

    const charges = d.prepare("SELECT * FROM charges").all();
    assert.equal(charges.length, 0, "nothing is written for a mismatched event");
    const mandate = d.prepare("SELECT * FROM mandates WHERE id = 1").get() as Record<
      string,
      unknown
    >;
    assert.equal(mandate.charges_made, 0, "the mandate was not advanced to zeros");
    assert.equal(mandate.next_charge, 1_700_000_000, "nor overwritten with 0");
  });

  test("a retyped amount is reported instead of becoming 0", () => {
    const bad = event("plan_created", [MERCHANT, 2n], {
      token: TOKEN,
      amount: "ten million",
      period: 60n,
    });
    assert.ok(
      specProblems(bad)!.some((p) => p.includes("'amount'") && p.includes("i128")),
      "the field name and expected type appear in the report",
    );
    assert.equal(ix.apply(bad), "mismatched");
    assert.equal(d.prepare("SELECT * FROM plans").all().length, 0, "no zero row stored");
  });

  test("a negative value in an unsigned field is reported", () => {
    const bad = event("subscribed", [1n, SUBSCRIBER, MERCHANT], {
      plan_id: 1n,
      amount: 10n,
      period: -60n,
      next_charge: 1n,
    });
    assert.ok(specProblems(bad)!.some((p) => p.includes("period")));
  });

  test("extra topics are reported", () => {
    const bad = event("pause_changed", [1n, SUBSCRIBER, "someone else"], { paused: true });
    assert.ok(specProblems(bad)!.some((p) => p.includes("unexpected topic")));
  });

  test("optional fields may be absent", () => {
    // Deployments emitted plan_created without a name before names existed.
    assert.deepEqual(
      specProblems(
        event("plan_created", [MERCHANT, 3n], {
          token: TOKEN,
          amount: 1n,
          period: 60n,
        }),
      ),
      [],
    );
  });

  test("events outside the spec are ignored, not counted as mismatches", () => {
    assert.equal(specProblems(event("some_future_event", [], { x: 1n })), null);
    assert.equal(ix.apply(event("some_future_event", [], { x: 1n })), "unknown");
    assert.equal(ix.mismatchedEvents, 0);
  });
});

/** Raw RPC event: a plan_created whose data map lost the `amount` field. */
function badRawEvent(ledger: number): rpc.Api.EventResponse {
  return {
    ledger,
    txHash: `tx-bad-${ledger}`,
    topic: [
      nativeToScVal("plan_created", { type: "symbol" }),
      nativeToScVal(MERCHANT, { type: "address" }),
      nativeToScVal(9n, { type: "u64" }),
    ],
    value: nativeToScVal(
      { token: TOKEN, period: 60n, name: "renamed" },
      {
        type: {
          token: ["symbol", "address"],
          period: ["symbol", "u64"],
          name: ["symbol", "string"],
        },
      },
    ),
  } as unknown as rpc.Api.EventResponse;
}

describe("indexer counts spec mismatches per pass", () => {
  test("a mismatched event is logged, counted and skipped by tick", async () => {
    const d = openDatabase(":memory:");
    const chain: rpc.Api.EventResponse[] = [badRawEvent(150)];
    const server = {
      getLatestLedger: async () => ({ sequence: 200 }) as never,
      getHealth: async () => ({ oldestLedger: 1, latestLedger: 200 }) as never,
      getEvents: async () => ({ events: chain, cursor: "" }) as never,
    } as unknown as IndexerRpc;
    const config = {
      PLAN_REGISTRY_ID: TOKEN,
      VAULT_ID: TOKEN,
      SUBSCRIPTION_ID: TOKEN,
      INDEXER_START_LEDGER: 100,
    } as unknown as Config;

    const ix = new Indexer(d, server, config);
    const r = await ix.tick();

    assert.equal(r.applied, 0);
    assert.equal(r.mismatched, 1, "the pass reports what failed validation");
    assert.equal(ix.mismatchedEvents, 1);
    assert.equal(ix.status.mismatchedEvents, 1, "visible through /health state");
    assert.equal(d.prepare("SELECT * FROM plans").all().length, 0, "not projected");
    assert.equal(r.cursor, 200, "the cursor still advances past the range");
    d.close();
  });
});
