import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import pino from "pino";
import { redact } from "../src/lib/logger.ts";

test("logging an object containing the keeper secret prints [Redacted]", () => {
  let out = "";
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      out += chunk.toString();
      cb();
    },
  });
  const log = pino({ redact }, sink);
  log.info({ KEEPER_SECRET: "SABC123" }, "top level");
  log.info({ config: { KEEPER_SECRET: "SABC123" } }, "nested");
  assert.ok(!out.includes("SABC123"));
  assert.equal(out.split("[Redacted]").length - 1, 2);
});
