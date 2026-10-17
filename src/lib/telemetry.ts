import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * Minimal OpenTelemetry tracing: spans are exported as OTLP/HTTP JSON to
 * `OTEL_EXPORTER_OTLP_ENDPOINT`. With no endpoint, `withSpan` just calls the
 * function, so tracing costs nothing when disabled.
 */
interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string | undefined;
  name: string;
  start: bigint;
  end: bigint;
  error?: string;
}

const FLUSH_MS = 5_000;
const MAX_BUFFER = 1_000;
const active = new AsyncLocalStorage<{ traceId: string; spanId: string }>();
let endpoint: string | undefined;
let buffer: Span[] = [];
let timer: NodeJS.Timeout | undefined;

const nowNs = (): bigint => BigInt(Date.now()) * 1_000_000n;

async function flush(): Promise<void> {
  if (!endpoint || buffer.length === 0) return;
  const spans = buffer;
  buffer = [];
  const body = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "payflow-backend" } }] },
        scopeSpans: [
          {
            scope: { name: "payflow-backend" },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              parentSpanId: s.parentSpanId,
              name: s.name,
              kind: 1,
              startTimeUnixNano: s.start.toString(),
              endTimeUnixNano: s.end.toString(),
              status: s.error ? { code: 2, message: s.error } : { code: 1 },
            })),
          },
        ],
      },
    ],
  };
  try {
    await fetch(`${endpoint}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Tracing must never break the service; drop the batch.
  }
}

/** Turn tracing on when an endpoint is given. Returns a function that flushes and stops. */
export function initTelemetry(url: string | undefined): () => Promise<void> {
  if (!url) return async () => {};
  endpoint = url.replace(/\/+$/, "");
  timer = setInterval(() => void flush(), FLUSH_MS);
  timer.unref();
  return async () => {
    if (timer) clearInterval(timer);
    await flush();
    endpoint = undefined;
  };
}

/** Run `fn` inside a span, recording failures. Calls `fn` directly when tracing is off. */
export function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!endpoint) return fn();
  const parent = active.getStore();
  const ctx = {
    traceId: parent?.traceId ?? randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
  };
  const span: Span = { ...ctx, parentSpanId: parent?.spanId, name, start: nowNs(), end: 0n };
  const finish = (error?: unknown): void => {
    span.end = nowNs();
    if (error !== undefined) span.error = error instanceof Error ? error.message : String(error);
    if (buffer.length < MAX_BUFFER) buffer.push(span);
  };
  return active.run(ctx, async () => {
    try {
      const result = await fn();
      finish();
      return result;
    } catch (err) {
      finish(err);
      throw err;
    }
  });
}

/** Wrap every method of an RPC client so each call becomes a span named `rpc.<method>`. */
export function traceRpc<T extends object>(server: T): T {
  return new Proxy(server, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return (...args: unknown[]) =>
        withSpan(`rpc.${prop}`, async () => (await (value as (...a: unknown[]) => unknown).apply(target, args)) as never);
    },
  });
}
