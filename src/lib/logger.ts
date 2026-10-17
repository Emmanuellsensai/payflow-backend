import pino from "pino";

// Never let a key reach a log aggregator, at the top level or one level down
// (config objects, error objects with an attached config).
export const redact = {
  paths: ["*.KEEPER_SECRET", "KEEPER_SECRET", "*.secret", "secret", "req.headers.authorization"],
  censor: "[Redacted]",
};

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "payflow-backend" },
  redact,
});

export type Logger = typeof logger;
