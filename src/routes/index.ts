import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { mandatesRouter } from "./mandates.ts";
import { merchantsRouter } from "./merchants.ts";
import { plansRouter } from "./plans.ts";
import { statsRouter } from "./stats.ts";
import { subscribersRouter } from "./subscribers.ts";

/**
 * One router per resource: `plans.ts`, `mandates.ts`, `merchants.ts`,
 * `subscribers.ts` and `stats.ts`, with shared query helpers in
 * `helpers.ts` and response shapes in `types.ts`. This file only composes
 * them, so route ownership is obvious from a path prefix and two features
 * rarely touch the same file.
 *
 * The response types are the backend's single source of truth for the API:
 * handlers annotate their bodies with them and the typed client
 * (`src/client/index.ts`) re-exports them, so types are shared, not copied.
 */
export function buildRoutes(db: DatabaseSync): Router {
  const r = Router();
  r.use(plansRouter(db));
  r.use(mandatesRouter(db));
  r.use(merchantsRouter(db));
  r.use(subscribersRouter(db));
  r.use(statsRouter(db));
  return r;
}

export * from "./types.ts";
