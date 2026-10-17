import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { Config } from "../config.ts";
import { traceRpc } from "./telemetry.ts";

export function makeRpc(config: Config): rpc.Server {
  return traceRpc(
    new rpc.Server(config.SOROBAN_RPC_URL, {
      allowHttp: config.SOROBAN_RPC_URL.startsWith("http://"),
    }),
  );
}

/** A contract event flattened into plain JS values. */
export interface DecodedEvent {
  /** snake_case name emitted as topic 0 by the `#[contractevent]` macro. */
  name: string;
  contractId: string;
  ledger: number;
  txHash: string;
  /** Topic values after topic 0, in declaration order. */
  topics: unknown[];
  /** Non-topic fields. The macro emits these as a map by default. */
  data: Record<string, unknown>;
}

/**
 * Decode a raw RPC event.
 *
 * The `#[contractevent]` macro puts the snake_case struct name in topic 0,
 * each `#[topic]` field in the topics that follow, and every remaining field
 * in a map in the data section. Anything that does not match that shape is
 * skipped rather than throwing, so one malformed event cannot stall the
 * indexer.
 */
export function decodeEvent(raw: rpc.Api.EventResponse): DecodedEvent | null {
  try {
    const topics = raw.topic.map((t: xdr.ScVal) => scValToNative(t));
    const [name, ...rest] = topics;
    if (typeof name !== "string") return null;

    const value = scValToNative(raw.value);
    const data =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : { value };

    return {
      name,
      contractId: raw.contractId?.toString() ?? "",
      ledger: raw.ledger,
      txHash: raw.txHash,
      topics: rest,
      data,
    };
  } catch {
    return null;
  }
}

/** i128 values arrive as bigint; store them as strings to avoid precision loss. */
export function big(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Math.trunc(value).toString();
  if (typeof value === "string") return value;
  return "0";
}

export function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  return 0;
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}
