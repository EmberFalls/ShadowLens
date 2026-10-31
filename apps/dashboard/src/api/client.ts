import type { ApprovalStatus, DataClient, DomainSummaryV2, EventPageV2, MetadataExport, NewDeviceCredential, OwnerPolicy, PolicyDraft, PolicyKeyInfo, RetentionSettings, RiskEventV2, SiteId, SummaryV2, TimeseriesV2, DeviceListV2 } from "./types.js";

export type ApiErrorCode = "UNAUTHORIZED" | "FORBIDDEN" | "TOO_MANY_REQUESTS" | "UNAVAILABLE" | "INVALID_RESPONSE" | "REQUEST_FAILED";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: ApiErrorCode, message: string, readonly requestId?: string, readonly retryAfterSeconds?: number) {
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
const COUNTS = ["siteVisitsObserved", "distinctAiSitesObserved", "guardedAttempts", "bestEffortAttempts", "policyBlocks", "failedSafe", "redactionsPlanned", "redactionsPageAttested", "warningsIssued", "pageAttestedReleases", "observedDevices", "freshDevices", "staleDevices"] as const;
const CATEGORIES = new Set(["PII_EMAIL", "PII_PHONE", "PII_PAYMENT_CARD", "PII_AADHAAR", "PII_INDIA_PAN", "PII_GSTIN", "PII_IFSC", "PII_UPI", "SECRET_TOKEN", "SECRET_PRIVATE_KEY", "CONFIDENTIAL_MARKER", "SOURCE_CODE_CONTEXT", "CUSTOM_PROTECTED_TERM", "BULK_CONTACT_LIST"]);
const REASONS = new Set(["DETECTED_PII", "DETECTED_SECRET", "DETECTED_CONFIDENTIAL", "DETECTED_SOURCE_CODE", "DETECTED_BULK", "DETECTED_CUSTOM_TERM", "POLICY_ALLOW", "POLICY_WARN", "POLICY_REDACT", "POLICY_BLOCK", "POLICY_FALLBACK_WARN", "USER_CANCELLED", "USER_ACKNOWLEDGED", "USER_APPROVED_REDACTION", "REDACTION_RESIDUAL", "RELEASE_WRITE_MISMATCH", "EDITOR_CHANGED", "SCANNER_TIMEOUT", "INPUT_TOO_LONG", "INVALID_POLICY", "ENGINE_FAILURE", "BACKEND_OFFLINE", "UNSUPPORTED_AI_SITE_SEEN", "UPLOAD_UNINSPECTED", "PAGE_ACK_RECEIVED", "PAGE_ACK_TIMEOUT"]);

export function createApiClient(options: ClientOptions = {}): LiveDataClient {
  const baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  async function request<T>(path: string, validate: (value: unknown) => value is T, body?: unknown, method?: "POST" | "PUT" | "DELETE"): Promise<T> {
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
    if (response.status === 429) {
      const retryHeader = Number(response.headers.get("Retry-After"));
      const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? Math.ceil(retryHeader) : undefined;
      throw new ApiError(429, "TOO_MANY_REQUESTS", "Too many requests. Try again later.", response.headers.get("X-Request-ID") ?? undefined, retryAfter);
    }
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
    async enrollDevice(label) {
      const normalized = label.trim();
      if (!normalized || normalized.length > 100 || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new ApiError(400, "REQUEST_FAILED", "Enter a device label from 1 to 100 printable characters.");
      const enrolled = await request("/devices/enroll", isEnrollment, { label: normalized }, "POST");
      return enrolled;
    },
    getPolicy() { return request("/policy", isPolicy); },
    setPolicy(policy: PolicyDraft) { return request("/policy", isPolicy, policy, "PUT"); },
    getPolicyKey() { return request("/policy/key", isPolicyKey); },
    async revokeDevice(deviceId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) throw new ApiError(400, "REQUEST_FAILED", "The selected device is invalid.");
      await request(`/devices/${encodeURIComponent(deviceId)}/revoke`, isOk, {}, "POST");
      return request("/devices", isDeviceList);
    },
    getRetentionSettings() { return request("/privacy/retention", isRetentionSettings); },
    setRetentionDays(days) {
      if (!Number.isInteger(days) || days < 1 || days > 3650) throw new ApiError(400, "REQUEST_FAILED", "Retention must be between 1 and 3650 days.");
      return request("/privacy/retention", isRetentionUpdate, { retentionDays: days }, "PUT");
    },
    exportMetadata() { return request("/privacy/export", isMetadataExport); },
    deleteEventHistory() { return request("/privacy/events", isDeleteResult, undefined, "DELETE"); },
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
      && hasKeys(bucket, ["bucketDateLocal", "siteVisitsObserved", "guardedAttempts", "bestEffortAttempts", "policyBlocks", "failedSafe", "redactionsPageAttested"])
      && typeof bucket.bucketDateLocal === "string" && /^\d{4}-\d{2}-\d{2}$/.test(bucket.bucketDateLocal)
      && ["siteVisitsObserved", "guardedAttempts", "bestEffortAttempts", "policyBlocks", "failedSafe", "redactionsPageAttested"].every(key => isCount(bucket[key])));
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
function isEventRecord(value: unknown): boolean { return object(value) && hasKeys(value, ["event", "ingestedAt"]) && isRiskEvent(value.event) && isIso(value.ingestedAt); }
function isEventPage(value: unknown): value is EventPageV2 { return object(value) && hasKeys(value, ["contractVersion", "items", "nextCursor"]) && value.contractVersion === "v2" && Array.isArray(value.items) && value.items.every(isEventRecord) && (value.nextCursor === null || typeof value.nextCursor === "string"); }
function isDomain(value: unknown): value is DomainSummaryV2 {
  return object(value) && hasKeys(value, ["siteId", "approvalStatus", "supportStatus", "siteVisitsObserved", "guardedAttempts", "bestEffortAttempts", "lastVisitAt"]) && SITE_IDS.has(String(value.siteId)) && APPROVAL.has(String(value.approvalStatus)) && SUPPORT.has(String(value.supportStatus))
    && isCount(value.siteVisitsObserved) && isCount(value.guardedAttempts) && isCount(value.bestEffortAttempts) && (value.lastVisitAt === null || isIso(value.lastVisitAt));
}
function isDomains(value: unknown): value is DomainSummaryV2[] { return Array.isArray(value) && value.every(isDomain); }
function isDeviceList(value: unknown): value is DeviceListV2 {
  return object(value) && hasKeys(value, ["contractVersion", "items"]) && value.contractVersion === "v2" && Array.isArray(value.items) && value.items.every(device => object(device)
    && hasKeys(device, ["deviceId", "lastHeartbeatAt", "lastEventAt", "observation", "enrollmentStatus"])
    && typeof device.deviceId === "string" && (device.lastHeartbeatAt === null || isIso(device.lastHeartbeatAt))
    && (device.lastEventAt === null || isIso(device.lastEventAt)) && ["RECENTLY_SEEN", "STALE", "NEVER_SEEN"].includes(String(device.observation))
    && ["ACTIVE", "REVOKED"].includes(String(device.enrollmentStatus)));
}
function isEnrollment(value: unknown): value is NewDeviceCredential {
  return object(value) && hasKeys(value, ["deviceId", "token", "policyKeyId"])
    && typeof value.deviceId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.deviceId)
    && typeof value.token === "string" && /^[A-Za-z0-9_-]{32,512}$/.test(value.token)
    && typeof value.policyKeyId === "string" && /^[0-9a-f]{64}$/.test(value.policyKeyId);
}
function isPolicyKey(value: unknown): value is PolicyKeyInfo {
  return object(value) && hasKeys(value, ["algorithm", "keyId"])
    && value.algorithm === "ECDSA_P256_SHA256" && typeof value.keyId === "string" && /^[0-9a-f]{64}$/.test(value.keyId);
}
function isPolicy(value: unknown): value is OwnerPolicy {
  const hasProtectedTerms = object(value) && Object.hasOwn(value, "protectedTerms");
  if (!object(value) || !hasKeys(value, ["contractVersion", "revision", "defaultFindingAction", "rules", "allowWarnOverride", "updatedAt", ...(hasProtectedTerms ? ["protectedTerms"] : [])])
    || value.contractVersion !== "v2" || !isCount(value.revision) || value.revision < 1 || value.revision > 2_147_483_647
    || !["WARN", "BLOCK"].includes(String(value.defaultFindingAction)) || typeof value.allowWarnOverride !== "boolean"
    || !isIso(value.updatedAt) || !Array.isArray(value.rules) || value.rules.length > 32) return false;
  if (hasProtectedTerms) {
    if (!Array.isArray(value.protectedTerms) || value.protectedTerms.length > 100) return false;
    const seen = new Set<string>();
    for (const term of value.protectedTerms) {
      if (typeof term !== "string" || term !== term.trim().normalize("NFC") || term.length < 3 || term.length > 100 || /[\u0000-\u001f\u007f]/u.test(term)) return false;
      const normalized = term.toLocaleLowerCase("en-US");
      if (seen.has(normalized)) return false;
      seen.add(normalized);
    }
  }
  const categories = new Set(["PII_EMAIL", "PII_PHONE", "PII_PAYMENT_CARD", "PII_AADHAAR", "PII_INDIA_PAN", "PII_GSTIN", "PII_IFSC", "PII_UPI", "SECRET_TOKEN", "SECRET_PRIVATE_KEY", "CONFIDENTIAL_MARKER", "SOURCE_CODE_CONTEXT", "CUSTOM_PROTECTED_TERM", "BULK_CONTACT_LIST", "*"]);
  const ids = new Set<string>();
  let privateKeyRuleCount = 0;
  for (const rule of value.rules) {
    if (!object(rule) || !hasKeys(rule, ["id", "category", "minimumSeverity", "action", "enabled"])
      || typeof rule.id !== "string" || !rule.id || ids.has(rule.id) || !categories.has(String(rule.category))
      || !["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(String(rule.minimumSeverity))
      || !["ALLOW", "WARN", "REDACT", "BLOCK"].includes(String(rule.action)) || typeof rule.enabled !== "boolean") return false;
    ids.add(rule.id);
    if (rule.category === "SECRET_PRIVATE_KEY") {
      privateKeyRuleCount++;
      if (!rule.enabled || rule.action !== "BLOCK" || rule.minimumSeverity !== "LOW") return false;
    }
  }
  return privateKeyRuleCount === 1;
}
function isRetentionSettings(value: unknown): value is RetentionSettings {
  return object(value) && hasKeys(value, ["retentionDays", "updatedAt"]) && isCount(value.retentionDays)
    && value.retentionDays >= 1 && value.retentionDays <= 3650 && (value.updatedAt === null || isIso(value.updatedAt));
}
function isRetentionUpdate(value: unknown): value is { retentionDays: number; previousRetentionDays: number; expiredEventsDeleted: number } {
  return object(value) && hasKeys(value, ["retentionDays", "previousRetentionDays", "expiredEventsDeleted"])
    && [value.retentionDays, value.previousRetentionDays, value.expiredEventsDeleted].every(isCount);
}
function isMetadataExport(value: unknown): value is MetadataExport {
  return object(value) && hasKeys(value, ["contractVersion", "exportedAt", "retentionDays", "events", "devices", "domains", "domainApprovalHistory", "policy", "policyKeyId", "administrativeAudit"])
    && value.contractVersion === "v2" && isIso(value.exportedAt) && isCount(value.retentionDays)
    && value.retentionDays >= 1 && value.retentionDays <= 3650
    && Array.isArray(value.events) && value.events.every(isRiskEvent)
    && Array.isArray(value.devices) && value.devices.every((entry) => object(entry)
      && hasKeys(entry, ["deviceId", "deviceLabel", "createdAt", "revokedAt", "lastHeartbeatAt"])
      && typeof entry.deviceId === "string" && typeof entry.deviceLabel === "string" && entry.deviceLabel.length <= 100
      && isIso(entry.createdAt) && (entry.revokedAt === null || isIso(entry.revokedAt))
      && (entry.lastHeartbeatAt === null || isIso(entry.lastHeartbeatAt)))
    && Array.isArray(value.domains) && value.domains.every((entry) => object(entry)
      && hasKeys(entry, ["siteId", "canonicalHost", "approvalStatus", "updatedAt"])
      && SITE_IDS.has(String(entry.siteId)) && typeof entry.canonicalHost === "string"
      && APPROVAL.has(String(entry.approvalStatus)) && isIso(entry.updatedAt))
    && Array.isArray(value.domainApprovalHistory) && value.domainApprovalHistory.every((entry) => object(entry)
      && hasKeys(entry, ["siteId", "oldStatus", "newStatus", "changedAt"])
      && SITE_IDS.has(String(entry.siteId)) && APPROVAL.has(String(entry.oldStatus))
      && APPROVAL.has(String(entry.newStatus)) && isIso(entry.changedAt))
    && isPolicy(value.policy) && typeof value.policyKeyId === "string" && /^[0-9a-f]{64}$/.test(value.policyKeyId)
    && Array.isArray(value.administrativeAudit) && value.administrativeAudit.every((entry) => object(entry)
      && hasKeys(entry, ["action", "detail", "changedAt"])
      && ["RETENTION_CHANGED", "EVENTS_DELETED", "DEVICE_ENROLLED", "DEVICE_REVOKED", "POLICY_UPDATED"].includes(String(entry.action))
      && object(entry.detail) && Object.values(entry.detail).every((item) => typeof item === "string" || isCount(item))
      && isIso(entry.changedAt));
}
function isDeleteResult(value: unknown): value is { deletedEvents: number } {
  return object(value) && hasKeys(value, ["deletedEvents"]) && isCount(value.deletedEvents);
}
function isSession(value: unknown): value is { authenticated: true } { return object(value) && hasKeys(value, ["authenticated"]) && value.authenticated === true; }
function isOk(value: unknown): value is { ok: true } { return object(value) && hasKeys(value, ["ok"]) && value.ok === true; }
function containsForbidden(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbidden);
  if (!object(value)) return false;
  return Object.entries(value).some(([key, nested]) => FORBIDDEN.test(key) || containsForbidden(nested));
}
