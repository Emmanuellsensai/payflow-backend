import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { initTelemetry, withSpan } from "../src/lib/telemetry.ts";

test("withSpan just runs the function when tracing is off", async () => {
  assert.equal(await withSpan("noop", async () => 42), 42);
});

test("spans are exported as OTLP JSON, nested spans share a trace, errors are marked", async () => {
  interface Span {
    name: string;
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    status: { code: number };
  }
  interface Payload {
    resourceSpans: { scopeSpans: { spans: Span[] }[] }[];
  }
  const bodies: { url: string | undefined; json: Payload }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push({ url: req.url, json: JSON.parse(raw) as Payload });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const stop = initTelemetry(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await withSpan("outer", async () => {
    await withSpan("inner", async () => {});
    await withSpan("failing", async () => {
      throw new Error("boom");
    }).catch(() => {});
  });
  await stop();
  server.close();

  assert.equal(bodies[0].url, "/v1/traces");
  const spans = bodies[0].json.resourceSpans[0].scopeSpans[0].spans;
  const byName = Object.fromEntries(spans.map((s) => [s.name, s])) as Record<string, Span>;
  assert.equal(byName.inner.traceId, byName.outer.traceId);
  assert.equal(byName.inner.parentSpanId, byName.outer.spanId);
  assert.equal(byName.failing.status.code, 2);
});
