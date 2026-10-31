import type { RiskEventV2 } from "../../../../packages/contracts/src/generated/event.js";
import { MAX_BATCH_EVENTS, PrivacySafeQueue } from "./queue.js";

export const API_BASE_URL = "http://127.0.0.1:8787/api/v1";
export const DEFAULT_API_ORIGIN = "http://127.0.0.1:8787";

export function normalizeApiOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || raw !== raw.trim() || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    const local = url.origin === DEFAULT_API_ORIGIN;
    if ((!local && url.protocol !== "https:") || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

export function apiPatternForOrigin(origin: string): string {
  const normalized = normalizeApiOrigin(origin);
  if (!normalized) throw new TypeError("API origin is invalid");
  return `${new URL(normalized).origin}/*`;
}

type ApiBaseProvider = () => Promise<string>;
export type DeviceCredential = { token: string; deviceId: string };
export type FlushResult = "idle" | "sent" | "reconnect" | "retry" | "quarantined";
type BatchResponse = { accepted: number; duplicates: number; rejected: number };

export function retryDelayMs(attempt: number): number {
  const boundedAttempt = Math.min(10, Math.max(1, Math.floor(attempt)));
  return Math.min(30_000 * (2 ** (boundedAttempt - 1)), 6 * 60 * 60 * 1000);
}

function validResponse(value: unknown, submittedCount: number): value is BatchResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  return Number.isSafeInteger(response.accepted) && Number(response.accepted) >= 0
    && Number.isSafeInteger(response.duplicates) && Number(response.duplicates) >= 0
    && response.rejected === 0 && Number(response.accepted) + Number(response.duplicates) === submittedCount;
}

export class EventApiClient {
  private readonly queue: PrivacySafeQueue;
  private readonly getCredential: () => Promise<DeviceCredential | null>;
  private readonly request: typeof fetch;
  private readonly getApiBase: ApiBaseProvider;

  constructor(
    queue: PrivacySafeQueue,
    getCredential: () => Promise<DeviceCredential | null>,
    request?: typeof fetch,
    getApiBase?: ApiBaseProvider,
  ) {
    // Resolve fetch lazily so the class can be constructed in environments
    // (e.g. test VM contexts) where fetch is not yet defined at module load.
    this.request = request ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    this.getApiBase = getApiBase ?? (async () => API_BASE_URL);
    this.queue = queue;
    this.getCredential = getCredential;
  }

  async flushOneBatch(): Promise<FlushResult> {
    const credential = await this.getCredential();
    if (!credential) return "reconnect";
    const queued = (await this.queue.batch()).slice(0, MAX_BATCH_EVENTS);
    if (queued.length === 0) return "idle";
    const ids = queued.map(({ event }) => event.eventId);
    const body = JSON.stringify({ contractVersion: "v2", events: queued.map(({ event }) => event as RiskEventV2) });
    let apiBase: string;
    try { apiBase = await this.getApiBase(); } catch { return "retry"; }
    let response: Response;
    try {
      response = await this.request(`${apiBase.replace(/\/$/u, "")}/events/batch`, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential.token}` },
        body,
      });
    } catch {
      return "retry";
    }
    if (response.status === 401) return "reconnect";
    if (response.status === 422 || (response.status >= 400 && response.status < 500)) {
      await this.queue.quarantine(ids, response.status);
      return "quarantined";
    }
    if (!response.ok) return "retry";
    let result: unknown;
    try { result = await response.json(); } catch { return "retry"; }
    if (!validResponse(result, queued.length)) return "retry";
    await this.queue.acknowledge(ids);
    return "sent";
  }
}
