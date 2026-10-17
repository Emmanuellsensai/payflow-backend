import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { pinoHttp } from "pino-http";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import type { IndexerStatus } from "./indexer.ts";
import { buildRoutes } from "./routes/index.ts";
import type { HealthResponse } from "./routes/types.ts";
import { logger } from "./lib/logger.ts";
import { withSpan } from "./lib/telemetry.ts";

/** Ledgers the indexer may trail the network by before /health reports it. */
const MAX_LAG = 120;

export function createApp(db: DatabaseSync, config: Config, indexer?: IndexerStatus): Express {
  const app = express();

  app.use(
    pinoHttp({
      logger,
      // Accept a caller's id (bounded, so it cannot flood logs) or mint one.
      genReqId: (req, res) => {
        const given = req.headers["x-request-id"];
        const id = typeof given === "string" && /^[\w.-]{1,128}$/.test(given) ? given : randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
    }),
  );
  app.use((req, res, next) => {
    void withSpan(`${req.method} request`, () => {
      return new Promise<void>((resolve) => {
        res.once("close", resolve);
        next();
      });
    });
  });
  app.use(
    cors({
      origin: config.CORS_ORIGIN === "*" ? true : config.CORS_ORIGIN.split(","),
      // Browsers hide non-safelisted response headers from scripts unless exposed.
      exposedHeaders: ["X-Request-Id"],
    }),
  );
  app.use(express.json({ limit: "64kb" }));

  // Always 200 so a slow backfill does not get the service restarted; the
  // body says whether the projection is current.
  app.get("/health", (_req, res) => {
    const lag = indexer && indexer.latest > 0 ? Math.max(0, indexer.latest - indexer.cursor) : null;
    const body: HealthResponse = {
      status: lag === null ? "starting" : lag <= MAX_LAG ? "ok" : "catching_up",
      network: config.STELLAR_NETWORK,
      indexer: indexer
        ? {
            cursor: indexer.cursor,
            latestLedger: indexer.latest,
            lag,
            lastRunAt: indexer.lastRunAt ? new Date(indexer.lastRunAt).toISOString() : null,
            lastError: indexer.lastError,
            mismatchedEvents: indexer.mismatchedEvents ?? 0,
          }
        : null,
      contracts: {
        planRegistry: config.PLAN_REGISTRY_ID,
        vault: config.VAULT_ID,
        subscription: config.SUBSCRIPTION_ID,
      },
    };
    res.json(body);
  });

  app.use("/api", buildRoutes(db));

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, "unhandled request error");
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
