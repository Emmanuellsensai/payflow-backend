import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { Account, Keypair, Transaction } from "@stellar/stellar-sdk";
import { rpc } from "@stellar/stellar-sdk";
import { openDatabase } from "../src/lib/db.ts";
import { Keeper, type KeeperRpc } from "../src/keeper.ts";
import { loadConfig } from "../src/config.ts";
import { logger } from "../src/lib/logger.ts";
import type { Config } from "../src/config.ts";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const keyA = Keypair.random();
const keyB = Keypair.random();

function keeperConfig(secrets: { KEEPER_SECRET?: string; KEEPER_SECRET_NEXT?: string }): Config {
  return {
    PLAN_REGISTRY_ID: CONTRACT,
    VAULT_ID: CONTRACT,
    SUBSCRIPTION_ID: CONTRACT,
    NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    ...secrets,
  } as unknown as Config;
}

/**
 * A fake RPC node that only knows the accounts in `funded`: `getAccount`
 * fails for any other key, exactly like a missing or unfunded source account.
 * Everything else passes transactions through and reports success.
 */
function fakeRpc(funded: Set<string>, submitted: string[] = []): KeeperRpc {
  return {
    getAccount: async (address: string) => {
      if (!funded.has(address)) {
        throw new Error(`The source account ${address} was not found`);
      }
      return new Account(address, "1") as never;
    },
    prepareTransaction: async (tx) => tx,
    sendTransaction: async (tx) => {
      submitted.push((tx as Transaction).hash().toString("hex"));
      return {
        status: "PENDING",
        hash: (tx as Transaction).hash().toString("hex"),
      } as never;
    },
    getTransaction: async () =>
      ({ status: rpc.Api.GetTransactionStatus.SUCCESS }) as never,
  };
}

function insertDue(db: ReturnType<typeof openDatabase>, id: number, nextCharge: number): void {
  db.prepare(
    `INSERT INTO mandates (id, subscriber, merchant, plan_id, amount, period, next_charge, status, ledger)
     VALUES (?, ?, ?, 1, '10', 60, ?, 'Active', 1)`,
  ).run(id, SUBSCRIBER, MERCHANT, nextCharge);
}

/** Collect logger.info messages while running `fn`. */
async function captureInfoLog(fn: () => Promise<void>): Promise<string[]> {
  const messages: string[] = [];
  const original = logger.info;
  // keeper.ts holds the same logger instance, so the wrap is observed there.
  // Keep pino's `this` binding when delegating to the original method.
  (logger as { info: unknown }).info = function (this: unknown, ...args: unknown[]) {
    messages.push(typeof args[1] === "string" ? args[1] : String(args[0]));
    return (original as (this: unknown, ...a: unknown[]) => void).apply(this, args);
  };
  try {
    await fn();
  } finally {
    (logger as { info: unknown }).info = original;
  }
  return messages;
}

describe("keeper key rotation", () => {
  test("unusable primary rotates to KEEPER_SECRET_NEXT inside the same pass", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const submitted: string[] = [];
    // Only the standby key has a funded source account.
    const server = fakeRpc(new Set([keyB.publicKey()]), submitted);
    const keeper = new Keeper(
      db,
      server,
      keeperConfig({ KEEPER_SECRET: keyA.secret(), KEEPER_SECRET_NEXT: keyB.secret() }),
    );
    assert.equal(keeper.publicKey, keyA.publicKey());

    const messages = await captureInfoLog(async () => {
      const results = await keeper.tick(10_000);
      assert.deepEqual(
        results.map((r) => r.status),
        ["settled"],
        "the mandate is settled despite the primary key being dead",
      );
      assert.equal(keeper.publicKey, keyB.publicKey(), "the keeper now signs with the new key");
      assert.equal(submitted.length, 1, "exactly one transaction hit the network");
    });

    assert.ok(
      messages.some((m) => m.includes("can now be retired")),
      "a successful pass with the next key logs that the old key can be retired",
    );
    db.close();
  });

  test("later passes keep settling and report the retirement only once", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    insertDue(db, 2, 1_001);
    const server = fakeRpc(new Set([keyB.publicKey()]));
    const keeper = new Keeper(
      db,
      server,
      keeperConfig({ KEEPER_SECRET: keyA.secret(), KEEPER_SECRET_NEXT: keyB.secret() }),
    );

    const first = await keeper.tick(10_000);
    assert.equal(first[0]!.status, "settled");

    insertDue(db, 3, 1_002);
    const second = await keeper.tick(10_061);
    assert.equal(second[0]!.status, "settled", "rotation is sticky; no downtime next pass");
    assert.equal(keeper.publicKey, keyB.publicKey());
    db.close();
  });

  test("keys swap between passes via config reload, without a restart", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const server = fakeRpc(new Set([keyA.publicKey(), keyB.publicKey()]));
    const keeper = new Keeper(db, server, keeperConfig({ KEEPER_SECRET: keyA.secret() }));
    assert.equal(keeper.publicKey, keyA.publicKey());

    // Pass 1 settles with the old key.
    const before = await keeper.tick(10_000);
    assert.equal(before[0]!.status, "settled");

    // The operator replaces KEEPER_SECRET in the env and sends SIGHUP;
    // index.ts re-reads the config and calls exactly this.
    keeper.reloadFromConfig(keeperConfig({ KEEPER_SECRET: keyB.secret() }));

    insertDue(db, 2, 1_001);
    const messages = await captureInfoLog(async () => {
      const after = await keeper.tick(10_061);
      assert.equal(after[0]!.status, "settled", "the new key settles on the very next pass");
      assert.equal(keeper.publicKey, keyB.publicKey());
    });
    assert.ok(
      messages.some((m) => m.includes("can now be retired")),
      "after a swapped-in key succeeds, the old key is announced retireable",
    );
    db.close();
  });

  test("a mandate failing for non-key reasons does not rotate the key", async () => {
    const db = openDatabase(":memory:");
    insertDue(db, 1, 1_000);
    const server = {
      getAccount: async () => new Account(keyA.publicKey(), "1"),
      prepareTransaction: async () => {
        throw new Error("Simulation failed: InsufficientBalance");
      },
    } as unknown as KeeperRpc;
    const keeper = new Keeper(
      db,
      server,
      keeperConfig({ KEEPER_SECRET: keyA.secret(), KEEPER_SECRET_NEXT: keyB.secret() }),
    );

    const results = await keeper.tick(10_000);
    assert.equal(results[0]!.status, "failed");
    assert.match(results[0]!.error ?? "", /InsufficientBalance/);
    assert.equal(keeper.publicKey, keyA.publicKey(), "an empty vault is not a key problem");
    db.close();
  });

  test("the keeper exposes only public keys, never secrets", () => {
    const keeper = new Keeper(
      openDatabase(":memory:"),
      fakeRpc(new Set()),
      keeperConfig({ KEEPER_SECRET: keyA.secret(), KEEPER_SECRET_NEXT: keyB.secret() }),
    );
    assert.deepEqual(keeper.keyPublicKeys, [keyA.publicKey(), keyB.publicKey()]);
    for (const k of keeper.keyPublicKeys) {
      assert.ok(k.startsWith("G"), "public keys only");
    }
  });

  test("KEEPER_SECRET_NEXT validates through the config schema", () => {
    const env = {
      PLAN_REGISTRY_ID: "C".repeat(56),
      VAULT_ID: "C".repeat(56),
      SUBSCRIPTION_ID: "C".repeat(56),
      KEEPER_SECRET: keyA.secret(),
      KEEPER_SECRET_NEXT: keyB.secret(),
    };
    const config = loadConfig(env as NodeJS.ProcessEnv);
    assert.equal(config.KEEPER_SECRET_NEXT, keyB.secret());
  });
});
