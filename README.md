<h1 align="center">Payflow — Backend</h1>

<p align="center">
  <strong>Event indexer, settlement keeper, and read API for the Payflow protocol.</strong>
</p>

<p align="center">
  <a href="https://github.com/MMM-pay/payflow-backend/actions/workflows/ci.yml">
    <img alt="CI" src="https://github.com/MMM-pay/payflow-backend/actions/workflows/ci.yml/badge.svg"/>
  </a>
  <img alt="Node" src="https://img.shields.io/badge/node-22-green"/>
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-5.9-blue"/>
  <img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-green"/>
</p>

> **Live demo:** https://mmm-pay.github.io/payflow-frontend/ ·
> **Docs:** https://mmm-pay.github.io/payflow-docs/

---

## What this does

Soroban contracts can answer "what is the state of mandate 7?" but they cannot
answer "show me every mandate this merchant has, sorted by revenue." That is
what this service is for. It does three jobs:

| Component | Job |
|---|---|
| **Indexer** | Polls Soroban RPC for contract events and projects them into SQLite |
| **Keeper** | Finds mandates that have fallen due and calls `charge` on-chain |
| **API** | Serves the projection to the frontend over REST |

### The keeper is not a trust dependency

`charge` is permissionless on-chain. This keeper holds no user funds and has no
privileged role — it only pays the transaction fee to trigger settlement. If it
stops running, merchants and subscribers can settle their own mandates directly.
Nothing is lost but timeliness.

### Indexing is idempotent by construction

The ledger cursor advances only after a batch is applied, so a crash mid-batch
replays that range on restart. Every write is designed for that:

- `plans` and `mandates` are upserts keyed on the on-chain id.
- `charges` is keyed on `(tx_hash, mandate_id)`, so a replayed ledger cannot
  double-count revenue.
- Mandate updates are guarded by `WHERE charges_made < ?`, so an out-of-order
  event can never move a mandate backwards.

## Quick start

```bash
npm install
cp .env.example .env      # already points at the deployed testnet contracts
npm test                  # 39 tests, no network needed
npm run dev
```

Index until caught up with the network, then exit (cron, backfills):

```bash
npm run indexer
```

Run one settlement pass and exit (needs `KEEPER_SECRET`):

```bash
npm run keeper
```

### How the loops behave

- **No overlapping passes.** Each loop schedules its next pass only after the
  current one finishes, so a slow backfill cannot race itself on the cursor
  and the keeper cannot submit two transactions with the same sequence number.
- **Where indexing starts.** The saved cursor; with none, `INDEXER_START_LEDGER`
  (the ledger the contracts were deployed at); with neither, the oldest ledger
  the RPC node still serves. A cursor older than the node's retention window is
  moved forward with a warning, since RPC rejects ranges that start before it.
- **Exact ranges.** Each pass reads `[cursor, cursor + 8000)` and never the
  ledger RPC is still closing, and it keeps paging until a page is empty or
  passes the range end: a short page does not mean the range is exhausted.
- **Failing mandates back off.** A mandate whose charge fails (usually an
  empty vault) is retried after 1 minute, then 2, 4 and so on up to 6 hours. A
  success clears it. Without this, 25 underfunded mandates at the front of the
  queue would block every other mandate.

## API

Base path `/api`. All amounts are strings in the token's smallest unit
(stroops for XLM) to avoid JavaScript float precision loss.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/health` | Status (`starting`, `ok`, `catching_up`), indexer cursor and lag, contract IDs |
| `GET` | `/api/plans?merchant=&limit=` | Published plans |
| `GET` | `/api/plans/:id` | One plan |
| `GET` | `/api/mandates?subscriber=&merchant=&status=` | Mandates |
| `GET` | `/api/mandates/:id` | One mandate |
| `GET` | `/api/mandates/:id/charges` | Settlement history |
| `GET` | `/api/due` | Mandates chargeable right now |
| `GET` | `/api/merchants/:address/summary` | Active mandates, revenue, MRR and ARR |
| `GET` | `/api/subscribers/:address/summary` | Mandates and total paid |
| `GET` | `/api/stats` | Protocol totals and last indexed ledger |

Example:

```bash
curl localhost:8080/api/merchants/GB343X.../summary
{
  "merchant": "GB343X...",
  "activeMandates": 1,
  "totalCollected": "19800000",
  "chargeCount": 2,
  "mrr": "432000000000",
  "arr": "5256000000000"
}
```

`mrr` and `arr` normalise every active mandate's own period to a 30-day month
(2,592,000 s) and a 365-day year (31,536,000 s) respectively:

```
mrr = sum(amount × 2592000 / period)   over active mandates
arr = sum(amount × 31536000 / period)  over active mandates
```

A yearly plan of 120,000000 stroops therefore reports `arr` of 120000000 and
an `mrr` of 9863013. A short-period demo plan produces a very large figure;
that is arithmetic, not a bug.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | RPC endpoint |
| `NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Network id |
| `PLAN_REGISTRY_ID` | — | Deployed registry contract |
| `VAULT_ID` | — | Deployed vault contract |
| `SUBSCRIPTION_ID` | — | Deployed subscription contract |
| `KEEPER_ENABLED` | `false` | Turn on automatic settlement |
| `KEEPER_SECRET` | — | `S...` key that pays settlement fees. Required when the keeper is on |
| `KEEPER_INTERVAL_MS` | `60000` | Settlement poll interval |
| `INDEXER_INTERVAL_MS` | `10000` | Indexing poll interval |
| `INDEXER_START_LEDGER` | `0` | Where to start with no saved cursor. `0` starts from the oldest ledger RPC still serves |
| `DATABASE_PATH` | `./payflow.db` | SQLite file |
| `PORT` | `8080` | HTTP port |
| `CORS_ORIGIN` | `*` | Comma-separated allowed origins |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | � | OTLP/HTTP collector base URL. Unset disables tracing at no cost |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | How long shutdown waits for in-flight passes |

Setting `OTEL_EXPORTER_OTLP_ENDPOINT` exports OpenTelemetry spans for every
RPC call (`rpc.<method>`), indexer and keeper pass, and HTTP request. Every
response carries an `X-Request-Id` (a caller-supplied id is reused), which also
appears in the request logs. Secrets such as `KEEPER_SECRET` are redacted from
logs.

The keeper is **off** by default. Turning it on requires funding
`KEEPER_SECRET` with XLM for transaction fees.

## Deployment

**API.** `render.yaml` is a Render blueprint for the free plan: Node 22 and
`/health` as the health check. The free plan has no disk, so the SQLite
projection is rebuilt from `INDEXER_START_LEDGER` after each restart, which
takes seconds while the deployment ledger is within RPC retention (about 7
days on testnet). On a paid plan, add a disk and point `DATABASE_PATH` at it.

**Keeper.** [`.github/workflows/keeper.yml`](.github/workflows/keeper.yml)
settles due testnet mandates roughly every 15 minutes from GitHub Actions,
using the `KEEPER_SECRET` repository secret, and caches its projection between
runs. A free web service sleeps when idle, so it is not a reliable place for
the keeper. The key only pays fees: if the workflow stops, anyone can still
call `charge`.

## Related repositories

| Repo | Role |
|---|---|
| [payflow-contract](https://github.com/MMM-pay/payflow-contract) | Soroban contracts this service indexes |
| [payflow-backend](https://github.com/MMM-pay/payflow-backend) | This repo |
| [payflow-frontend](https://github.com/MMM-pay/payflow-frontend) | Consumes this API |
| [payflow-docs](https://github.com/MMM-pay/payflow-docs) | Protocol documentation |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). CI runs `lint`, `typecheck`, `test`
and `build`; all four must pass. Changes are recorded in
[CHANGELOG.md](CHANGELOG.md).

## Security

See [SECURITY.md](SECURITY.md). Unaudited, testnet only.

## Maintainers

| Name | Role | Contact |
|---|---|---|
| Victor Adeleke | Lead maintainer | [@titilope12](https://github.com/titilope12) |

## Contributors

<a href="https://github.com/MMM-pay/payflow-backend/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=MMM-pay/payflow-backend"/>
</a>

## License

Apache-2.0.
