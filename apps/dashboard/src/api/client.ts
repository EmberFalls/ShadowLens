import type { ApprovalStatus, DataClient, DomainSummaryV2, EventPageV2, RiskEventV2, SiteId, SummaryV2, TimeseriesV2, DeviceListV2 } from "./types.js";

export type ApiErrorCode = "UNAUTHORIZED" | "FORBIDDEN" | "UNAVAILABLE" | "INVALID_RESPONSE" | "REQUEST_FAILED";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: ApiErrorCode, message: string, readonly requestId?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export interface OwnerAuthClient {
  getCurrentSession(): Promise<boolean>;
  login(password: string): Promise<void>;
  logout(): Promise<void>;
}

export type LiveDataClient = DataClient & OwnerAuthClient;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type ClientOptions = { baseUrl?: string; fetchImpl?: FetchLike; onUnauthorized?: () => void };

const SITE_IDS = new Set(["SANDBOX", "CHATGPT", "GEMINI", "CLAUDE", "COPILOT", "PERPLEXITY"]);
const SUPPORT = new Set(["GUARDED", "BEST_EFFORT", "UNSUPPORTED"]);
const APPROVAL = new Set(["APPROVED", "UNAPPROVED", "UNREVIEWED"]);
const FORBIDDEN = /prompt|raw.?text|matched.?value|snippet|filename|file.?name|url|text|value/i;
const COUNTS = ["siteVisitsObserved", "distinctAiSitesObserved", "guardedAttempts", "policyBlocks", "failedSafe", "redactionsPlanned", "redactionsPageAttested", "warningsIssued", "pageAttestedReleases", "observedDevices", "freshDevices", "staleDevices"] as const;
const CATEGORIES = new Set(["PII_EMAIL", "PII_PHONE", "PII_PAYMENT_CARD", "PII_AADHAAR", "PII_INDIA_PAN", "PII_GSTIN", "PII_IFSC", "PII_UPI", "SECRET_TOKEN", "SECRET_PRIVATE_KEY", "CONFIDENTIAL_MARKER", "SOURCE_CODE_CONTEXT", "CUSTOM_PROTECTED_TERM", "BULK_CONTACT_LIST"]);
const REASONS = new Set(["DETECTED_PII", "DETECTED_SECRET", "DETECTED_CONFIDENTIAL", "DETECTED_SOURCE_CODE", "DETECTED_BULK", "DETECTED_CUSTOM_TERM", "POLICY_ALLOW", "POLICY_WARN", "POLICY_REDACT", "POLICY_BLOCK", "POLICY_FALLBACK_WARN", "USER_CANCELLED", "USER_ACKNOWLEDGED", "USER_APPROVED_REDACTION", "REDACTION_RESIDUAL", "RELEASE_WRITE_MISMATCH", "EDITOR_CHANGED", "SCANNER_TIMEOUT", "INPUT_TOO_LONG", "INVALID_POLICY", "ENGINE_FAILURE", "BACKEND_OFFLINE", "UNSUPPORTED_AI_SITE_SEEN", "UPLOAD_UNINSPECTED", "PAGE_ACK_RECEIVED", "PAGE_ACK_TIMEOUT"]);

export function createApiClient(options: ClientOptions = {}): LiveDataClient {
  const baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  async function request<T>(path: string, validate: (value: unknown) => value is T, body?: unknown, method?: "POST" | "PUT"): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/api/v1${path}`, {
        method: method ?? (body === undefined ? "GET" : "PUT"),
        credentials: "include",
        cache: "no-store",
        headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError(0, "UNAVAILABLE", "The local service could not be reached.");
    }
    if (response.status === 401) {
      options.onUnauthorized?.();
      throw new ApiError(401, "UNAUTHORIZED", "Sign in to view owner data.", response.headers.get("X-Request-ID") ?? undefined);
    }
    if (response.status === 403) throw new ApiError(403, "FORBIDDEN", "This request was rejected.", response.headers.get("X-Request-ID") ?? undefined);
    if (response.status >= 500) throw new ApiError(response.status, "UNAVAILABLE", "The local service is temporarily unavailable.", response.headers.get("X-Request-ID") ?? undefined);
    if (!response.ok) throw new ApiError(response.status, "REQUEST_FAILED", "The request could not be completed.", response.headers.get("X-Request-ID") ?? undefined);
    let value: unknown;
    try { value = await response.json(); } catch { throw new ApiError(502, "INVALID_RESPONSE", "The local service returned an invalid response."); }
    if (!validate(value) || containsForbidden(value)) throw new ApiError(502, "INVALID_RESPONSE", "The local service returned data outside the dashboard contract.");
    return value;
  }

  return {
    getSummary(days) {
      const expectedDays = clampDays(days);
      const query = new URLSearchParams({ days: String(expectedDays) });
      return request(`/analytics/summary?${query}`, (value): value is SummaryV2 => isSummary(value) && value.windowDays === expectedDays);
    },
    getTimeseries(days, timezone) {
      const expectedDays = clampDays(days);
      const query = new URLSearchParams({ days: String(expectedDays), tz: timezone });
      return request(`/analytics/timeseries?${query}`, (value): value is TimeseriesV2 => isTimeseries(value) && value.windowDays === expectedDays && value.timezone === timezone);
    },
    getEvents(limit, cursor) {
      const expectedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 50;
      const query = new URLSearchParams({ limit: String(expectedLimit) });
      if (cursor) query.set("cursor", cursor);
      return request(`/analytics/events?${query}`, (value): value is EventPageV2 => isEventPage(value) && value.items.length <= expectedLimit);
    },
    getDomains() { return request("/domains", isDomains); },
    setApproval(siteId, approvalStatus) {
      if (!SITE_IDS.has(siteId) || !APPROVAL.has(approvalStatus)) throw new ApiError(400, "REQUEST_FAILED", "The selected tool or approval is invalid.");
      return request(`/domains/${encodeURIComponent(siteId)}/approval`, (value): value is DomainSummaryV2 => isDomain(value) && value.siteId === siteId && value.approvalStatus === approvalStatus, { approvalStatus });
    },
    getDevices() { return request("/devices", isDeviceList); },
    getCurrentSession() { return request("/auth/me", isSession).then(() => true); },
    async login(password) {
      await request("/auth/login", isOk, { password }, "POST");
      await request("/auth/me", isSession);
    },
    async logout() { await request("/auth/logout", isOk, {}, "POST"); },
  };
}

function clampDays(value: number): number { return Number.isFinite(value) ? Math.max(1, Math.min(30, Math.floor(value))) : 7; }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function hasKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)); }
function isCount(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function isIso(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function isSummary(value: unknown): value is SummaryV2 {
  return object(value) && hasKeys(value, ["contractVersion", "windowDays", "timezone", ...COUNTS, "categories", "fromUtc", "toUtc", "coverageNote"]) && value.contractVersion === "v2" && isCount(value.windowDays) && Number(value.windowDays) >= 1 && Number(value.windowDays) <= 30
    && ["UTC", "Asia/Kolkata"].includes(String(value.timezone)) && COUNTS.every(key => isCount(value[key]))
    && object(value.categories) && Object.entries(value.categories).every(([key, count]) => CATEGORIES.has(key) && isCount(count)) && isIso(value.fromUtc) && isIso(value.toUtc) && typeof value.coverageNote === "string";
}
function isTimeseries(value: unknown): value is TimeseriesV2 {
  return object(value) && hasKeys(value, ["contractVersion", "windowDays", "timezone", "buckets"]) && value.contractVersion === "v2" && isCount(value.windowDays) && Number(value.windowDays) >= 1 && Number(value.windowDays) <= 30
    && ["UTC", "Asia/Kolkata"].includes(String(value.timezone)) && Array.isArray(value.buckets) && value.buckets.every(bucket => object(bucket)
      && hasKeys(bucket, ["bucketDateLocal", "siteVisitsObserved", "guardedAttempts", "policyBlocks", "failedSafe", "redactionsPageAttested"])
      && typeof bucket.bucketDateLocal === "string" && /^\d{4}-\d{2}-\d{2}$/.test(bucket.bucketDateLocal)
      && ["siteVisitsObserved", "guardedAttempts", "policyBlocks", "failedSafe", "redactionsPageAttested"].every(key => isCount(bucket[key])));
}
function isRiskEvent(value: unknown): value is RiskEventV2 {
  if (!object(value) || value.contractVersion !== "v2" || typeof value.eventId !== "string" || !isIso(value.clientObservedAt) || typeof value.deviceId !== "string") return false;
  if (value.kind === "SITE_VISIT") return hasKeys(value, ["contractVersion", "eventId", "clientObservedAt", "deviceId", "kind", "siteId", "supportStatus", "reasonCodes"])
    && SITE_IDS.has(String(value.siteId)) && SUPPORT.has(String(value.supportStatus)) && Array.isArray(value.reasonCodes) && value.reasonCodes.every(reason => reason === "UNSUPPORTED_AI_SITE_SEEN");
  if (value.kind === "DEVICE_HEARTBEAT") return hasKeys(value, ["contractVersion", "eventId", "clientObservedAt", "deviceId", "kind", "extensionVersion"]) && typeof value.extensionVersion === "string";
  if (value.kind === "SUBMISSION") return hasKeys(value, ["contractVersion", "eventId", "clientObservedAt", "deviceId", "kind", "siteId", "coverageMode", "decisionAction", "disposition", "aggregateTier", "scoreBand", "categoryCounts", "policyRevision", "engineVersion", "lengthBand", "reasonCodes"])
    && SITE_IDS.has(String(value.siteId)) && ["SANDBOX_GUARDED", "THIRD_PARTY_BEST_EFFORT", "UNSUPPORTED"].includes(String(value.coverageMode))
    && ["ALLOW", "WARN", "REDACT", "BLOCK", null].includes(value.decisionAction as string | null)
    && ["CANCELLED", "BLOCKED", "FAILED_SAFE", "RELEASED_UNVERIFIED", "PAGE_ATTESTED"].includes(String(value.disposition))
    && ["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL", "NOT_EVALUATED"].includes(String(value.aggregateTier))
    && ["ZERO", "LOW", "MEDIUM", "HIGH", "CRITICAL", "NOT_EVALUATED"].includes(String(value.scoreBand))
    && object(value.categoryCounts) && Object.entries(value.categoryCounts).every(([key, count]) => CATEGORIES.has(key) && isCount(count))
    && isCount(value.policyRevision) && typeof value.engineVersion === "string"
    && ["EMPTY", "1_99", "100_999", "1000_PLUS"].includes(String(value.lengthBand)) && Array.isArray(value.reasonCodes) && value.reasonCodes.length <= 8 && value.reasonCodes.every(reason => REASONS.has(String(reason)));
  return false;
}
function isEventPage(value: unknown): value is EventPageV2 { return object(value) && hasKeys(value, ["contractVersion", "items", "nextCursor"]) && value.contractVersion === "v2" && Array.isArray(value.items) && value.items.every(isRiskEvent) && (value.nextCursor === null || typeof value.nextCursor === "string"); }
function isDomain(value: unknown): value is DomainSummaryV2 {
  return object(value) && hasKeys(value, ["siteId", "approvalStatus", "supportStatus", "siteVisitsObserved", "guardedAttempts", "lastVisitAt"]) && SITE_IDS.has(String(value.siteId)) && APPROVAL.has(String(value.approvalStatus)) && SUPPORT.has(String(value.supportStatus))
    && isCount(value.siteVisitsObserved) && isCount(value.guardedAttempts) && (value.lastVisitAt === null || isIso(value.lastVisitAt));
}
function isDomains(value: unknown): value is DomainSummaryV2[] { return Array.isArray(value) && value.every(isDomain); }
function isDeviceList(value: unknown): value is DeviceListV2 {
  return object(value) && hasKeys(value, ["contractVersion", "items"]) && value.contractVersion === "v2" && Array.isArray(value.items) && value.items.every(device => object(device)
    && hasKeys(device, ["deviceId", "lastHeartbeatAt", "lastEventAt", "observation"])
    && typeof device.deviceId === "string" && (device.lastHeartbeatAt === null || isIso(device.lastHeartbeatAt))
    && (device.lastEventAt === null || isIso(device.lastEventAt)) && ["RECENTLY_SEEN", "STALE", "NEVER_SEEN"].includes(String(device.observation)));
}
function isSession(value: unknown): value is { authenticated: true } { return object(value) && hasKeys(value, ["authenticated"]) && value.authenticated === true; }
function isOk(value: unknown): value is { ok: true } { return object(value) && hasKeys(value, ["ok"]) && value.ok === true; }
function containsForbidden(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbidden);
  if (!object(value)) return false;
  return Object.entries(value).some(([key, nested]) => FORBIDDEN.test(key) || containsForbidden(nested));
}
