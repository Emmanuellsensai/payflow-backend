# Changelog

All notable changes to payflow-backend. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- **Zero-downtime keeper key rotation (#71).** The keeper accepts a standby
  key in `KEEPER_SECRET_NEXT`: if the active key's source account is unusable
  it rotates mid-pass and retries the same mandate, and after a pass settles
  with the new key it logs that the previous key can be retired. Secrets are
  reloaded on `SIGHUP` (`.env` re-read, config re-validated) so promotion of
  the standby needs no restart. Tested by swapping keys between passes.
- **Typed API client (#72).** `src/client/index.ts` is a small typed fetch
  client for every endpoint, returning the same response types the route
  handlers annotate their bodies with (`src/routes/types.ts`) — shared, not
  copied. Exposed as the `payflow-backend/client` subpath after `npm run
  build` and tested against the HTTP test server.
- **Spec-driven event decoding (#73).** Event shapes live in the committed
  contract spec `src/lib/event_spec.json`. The indexer validates every
  decoded event before projecting it: mismatches (renamed fields, wrong
  types, extra data or topics) are logged with the exact problems, counted
  per pass in `TickResult.mismatched` and in `/health`'s
  `indexer.mismatchedEvents`, and never stored as zeros.
- **`arr` on the merchant summary.** `/api/merchants/:address/summary` now
  reports annual recurring revenue next to `mrr`: every active mandate
  normalised to a 365-day year. Both formulas are documented in the README.
- **Parallel window backfill (#59).** The indexer fetches up to
  `INDEXER_FETCH_CONCURRENCY` (default 4, max 16) 8,000-ledger windows at
  once and applies them in ledger order. The cursor advances only after a
  window is applied, so a failed later window resumes at the last applied
  one; `1` restores strictly sequential reads.
- **Batch mandate lookup (#61).** `/api/mandates?ids=1,2,3` returns up to 100
  mandates in one request. Unknown ids are omitted, more than 100 ids is
  `400 too_many_ids`, and a non-numeric id is `400 invalid_ids`. The typed
  client's `MandatesQuery` gained `ids`.
- **SQL template lint rule (#65).** ESLint rejects `prepare()` calls whose
  SQL is an interpolated template literal. Vetted static fragments carry an
  explained `eslint-disable-next-line` comment, and a test runs the real
  config against a deliberately bad query to prove the rule fires.

### Changed

- **Summary query indexes (#66).** Covering indexes for the merchant and
  subscriber summary aggregates (`mandates(merchant, status, period, amount)`,
  `charges(merchant, amount)`, `charges(subscriber, amount, fee)`) are added
  through the startup migration, so existing databases gain them without a
  rebuild. `EXPLAIN QUERY PLAN` now reports covering-index searches instead
  of table lookups.

- **One router per resource (#74).** `src/routes/index.ts` is split into
  `plans.ts`, `mandates.ts`, `merchants.ts`, `subscribers.ts` and `stats.ts`
  with shared query helpers in `helpers.ts`. No change in behaviour: paths,
  query handling and response shapes are identical and the existing API
  tests pass unchanged.

## [0.2.0] - 2026-10-09

Points at the v0.2.0 contract suite on testnet.

### Fixed

- **The keeper could stall behind failing mandates.** Every pass retried the
  25 oldest due mandates first, so 25 underfunded vaults blocked every other
  mandate indefinitely. A failed charge now backs off (1 minute, doubling, up
  to 6 hours) and a success clears it.
- **Passes could overlap.** Indexer and keeper ran on `setInterval`, so a pass
  slower than the interval ran alongside the next one. Overlapping indexer
  passes could move the cursor backwards; overlapping keeper passes submitted
  transactions with the same sequence number. Each loop now waits for its pass
  to finish.
- **A fresh indexer saw only the last ~11 hours.** With no cursor it started
  8,000 ledgers back. It now starts at `INDEXER_START_LEDGER` or, if unset, the
  oldest ledger the RPC node serves, and moves a cursor that fell out of
  retention forward instead of failing.
- **Ranges could end early.** A page with fewer than 200 events was taken to
  mean the range was exhausted. Paging now continues until a page is empty or
  passes the end of the range, which is passed to RPC as `endLedger`.
- **`npm run indexer` indexed one window and exited.** It now runs until it has
  caught up.
- **`npm run lint` could not run**: ESLint was not installed. ESLint 9 with
  typescript-eslint is configured and CI enforces it.
- **The Render blueprint could not deploy on the free plan**, which has no
  persistent disk. It now rebuilds the projection from the deployment ledger.

### Added

- `mandate_ended` events (a merchant ending a mandate) are projected as
  `Cancelled`, and mandates record who ended them in `ended_by`.
- `/health` reports `starting`, `ok` or `catching_up`, the indexer cursor, its
  lag behind the network, and the last error.
- A scheduled GitHub Actions keeper that settles due testnet mandates without
  an always-on server.

### Changed

- `@stellar/stellar-sdk` 13 → 17, for testnet's current protocol.
- 24 → 39 tests, including indexer sync against a fake RPC node, keeper
  backoff, and loop overlap.

## [0.1.0] - 2026-09-02

Event indexer, settlement keeper and read API for the first testnet
deployment.

[0.2.0]: https://github.com/MMM-pay/payflow-backend/releases/tag/v0.2.0
