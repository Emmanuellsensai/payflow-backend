/**
 * Typed API client for the Payflow backend.
 *
 * Response types are re-exported from `src/routes/types.ts` — the same
 * declarations the route handlers annotate their bodies with — so the
 * frontend and any other consumer depend on these instead of re-declaring
 * them by hand. Import it from the built package:
 *
 * ```ts
 * import { PayflowClient } from "payflow-backend/client";
 * const api = new PayflowClient("http://localhost:8080");
 * const { plans } = await api.plans({ merchant });
 * ```
 */
import type {
  ChargePage,
  DuePage,
  HealthResponse,
  MandatePage,
  MandateRow,
  MerchantSummary,
  PlanPage,
  PlanRow,
  StatsResponse,
  SubscriberSummary,
} from "../routes/types.ts";

// Types shared with the backend, not copied: one declaration in
// src/routes/types.ts serves the handlers, this client and every consumer.
export type {
  ApiErrorResponse,
  ChargePage,
  ChargeRow,
  DueMandateRow,
  DuePage,
  HealthResponse,
  HealthStatus,
  MandatePage,
  MandateRow,
  MerchantSummary,
  PlanPage,
  PlanRow,
  StatsResponse,
  SubscriberSummary,
} from "../routes/types.ts";

export interface PlansQuery {
  merchant?: string;
  limit?: number;
}

export interface MandatesQuery {
  /** Batch lookup; at most 100 ids, serialised as `1,2,3`. */
  ids?: number[];
  subscriber?: string;
  merchant?: string;
  status?: string;
  limit?: number;
}

export interface PageQuery {
  limit?: number;
}

export interface PayflowClientOptions {
  /** Base URL of the API, e.g. `https://payflow-backend.onrender.com`. */
  baseUrl: string;
  /** Override fetch for testing; defaults to the global implementation. */
  fetch?: typeof globalThis.fetch;
}

/** Raised when the API answers with a non-2xx status. */
export class PayflowApiError extends Error {
  readonly status: number;
  /** Parsed JSON body when it was valid JSON, otherwise the raw text. */
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`payflow api responded with status ${status}`);
    this.name = "PayflowApiError";
    this.status = status;
    this.body = body;
  }
}

/** Small typed wrapper over the Payflow REST API. Read-only endpoints. */
export class PayflowClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: PayflowClientOptions | string) {
    const opts = typeof options === "string" ? { baseUrl: options } : options;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  private async get<T>(path: string, query?: object): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const res = await this.fetchImpl(url.toString());
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      throw new PayflowApiError(res.status, body);
    }
    return body as T;
  }

  health(): Promise<HealthResponse> {
    return this.get<HealthResponse>("/health");
  }

  plans(query: PlansQuery = {}): Promise<PlanPage> {
    return this.get<PlanPage>("/api/plans", query);
  }

  plan(id: number): Promise<PlanRow> {
    return this.get<PlanRow>(`/api/plans/${id}`);
  }

  mandates(query: MandatesQuery = {}): Promise<MandatePage> {
    return this.get<MandatePage>("/api/mandates", query);
  }

  mandate(id: number): Promise<MandateRow> {
    return this.get<MandateRow>(`/api/mandates/${id}`);
  }

  charges(mandateId: number, query: PageQuery = {}): Promise<ChargePage> {
    return this.get<ChargePage>(`/api/mandates/${mandateId}/charges`, query);
  }

  due(query: PageQuery = {}): Promise<DuePage> {
    return this.get<DuePage>("/api/due", query);
  }

  merchantSummary(address: string): Promise<MerchantSummary> {
    return this.get<MerchantSummary>(`/api/merchants/${encodeURIComponent(address)}/summary`);
  }

  subscriberSummary(address: string): Promise<SubscriberSummary> {
    return this.get<SubscriberSummary>(`/api/subscribers/${encodeURIComponent(address)}/summary`);
  }

  stats(): Promise<StatsResponse> {
    return this.get<StatsResponse>("/api/stats");
  }
}
