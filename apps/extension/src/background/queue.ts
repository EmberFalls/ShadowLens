import type { RiskEventV2 } from "../../../../packages/contracts/src/generated/event.js";

export const QUEUE_STORAGE_KEY = "shadowshieldSanitizedEventQueue";
export const QUARANTINE_STORAGE_KEY = "shadowshieldEventQuarantine";
export const RETRY_STORAGE_KEY = "shadowshieldQueueRetryState";
export const MAX_QUEUE_EVENTS = 500;
export const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_BATCH_EVENTS = 25;

export type QueuedEvent = { event: RiskEventV2; queuedAt: number };
export type QuarantinedEvent = { eventId: string; quarantinedAt: number; status: number };
export type StorageArea = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SITE_IDS = ["SANDBOX", "CHATGPT", "GEMINI", "CLAUDE", "COPILOT", "PERPLEXITY"];
const CATEGORIES = ["PII_EMAIL", "PII_PHONE", "PII_PAYMENT_CARD", "PII_AADHAAR", "PII_INDIA_PAN", "PII_GSTIN", "PII_IFSC", "PII_UPI", "SECRET_TOKEN", "SECRET_PRIVATE_KEY", "CONFIDENTIAL_MARKER", "SOURCE_CODE_CONTEXT", "CUSTOM_PROTECTED_TERM", "BULK_CONTACT_LIST"];
const REASONS = ["DETECTED_PII", "DETECTED_SECRET", "DETECTED_CONFIDENTIAL", "DETECTED_SOURCE_CODE", "DETECTED_BULK", "DETECTED_CUSTOM_TERM", "POLICY_ALLOW", "POLICY_WARN", "POLICY_REDACT", "POLICY_BLOCK", "POLICY_FALLBACK_WARN", "USER_CANCELLED", "USER_ACKNOWLEDGED", "USER_APPROVED_REDACTION", "REDACTION_RESIDUAL", "RELEASE_WRITE_MISMATCH", "EDITOR_CHANGED", "SCANNER_TIMEOUT", "INPUT_TOO_LONG", "INVALID_POLICY", "ENGINE_FAILURE", "BACKEND_OFFLINE", "UNSUPPORTED_AI_SITE_SEEN", "UPLOAD_UNINSPECTED", "PAGE_ACK_RECEIVED", "PAGE_ACK_TIMEOUT"];
const SUBMISSION_FIELDS = ["contractVersion", "eventId", "clientObservedAt", "deviceId", "kind", "siteId", "coverageMode", "decisionAction", "disposition", "aggregateTier", "scoreBand", "categoryCounts", "policyRevision", "engineVersion", "lengthBand", "reasonCodes"];
const VISIT_FIELDS = ["contractVersion", "eventId", "clientObservedAt", "deviceId", "kind", "siteId", "supportStatus", "reasonCodes"];
const HEARTBEAT_FIELDS = ["contractVersion", "eventId", "clientObservedAt", "deviceId", "kind", "extensionVersion"];

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function validUtc(value: unknown): value is string {
  if (typeof value !== "string" || !UTC.test(value)) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  return parsed.getUTCFullYear() === Number(year) && parsed.getUTCMonth() + 1 === Number(month)
    && parsed.getUTCDate() === Number(day) && parsed.getUTCHours() === Number(hour)
    && parsed.getUTCMinutes() === Number(minute) && parsed.getUTCSeconds() === Number(second);
}

function validCommon(event: Record<string, unknown>, deviceId: string): boolean {
  return event.contractVersion === "v2" && typeof event.eventId === "string" && UUID.test(event.eventId)
    && event.deviceId === deviceId && typeof event.deviceId === "string" && UUID.test(event.deviceId)
    && validUtc(event.clientObservedAt);
}

/** Strictly validate and copy a content/observer event, binding it to enrollment identity. */
export function serializeRiskEvent(input: unknown, deviceId: string): RiskEventV2 {
  if (!UUID.test(deviceId) || !input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("event is invalid");
  const source = input as Record<string, unknown>;
  const event: Record<string, any> = { ...source, deviceId };
  if (source.deviceId !== undefined && source.deviceId !== deviceId) throw new TypeError("event identity is invalid");
  if (!validCommon(event, deviceId)) throw new TypeError("event is invalid");

  if (event.kind === "SITE_VISIT") {
    if (!exactKeys(event, VISIT_FIELDS) || !SITE_IDS.includes(String(event.siteId))
      || !["GUARDED", "BEST_EFFORT", "UNSUPPORTED"].includes(String(event.supportStatus))
      || !Array.isArray(event.reasonCodes)
      || event.reasonCodes.some((reason) => reason !== "UNSUPPORTED_AI_SITE_SEEN")) throw new TypeError("event is invalid");
  } else if (event.kind === "DEVICE_HEARTBEAT") {
    if (!exactKeys(event, HEARTBEAT_FIELDS) || typeof event.extensionVersion !== "string"
      || !/^[A-Za-z0-9.+_-]{1,32}$/.test(event.extensionVersion)) throw new TypeError("event is invalid");
  } else if (event.kind === "SUBMISSION") {
    const actions = ["ALLOW", "WARN", "REDACT", "BLOCK"];
    const dispositions = ["CANCELLED", "BLOCKED", "FAILED_SAFE", "RELEASED_UNVERIFIED", "PAGE_ATTESTED"];
    const tiers = ["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
    const scoreBands = ["ZERO", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
    if (!exactKeys(event, SUBMISSION_FIELDS) || !SITE_IDS.includes(String(event.siteId))
      || !["SANDBOX_GUARDED", "THIRD_PARTY_BEST_EFFORT", "UNSUPPORTED"].includes(String(event.coverageMode))
      || !(event.decisionAction === null || actions.includes(String(event.decisionAction)))
      || !dispositions.includes(String(event.disposition))
      || !(tiers.includes(String(event.aggregateTier)) || event.aggregateTier === "NOT_EVALUATED")
      || !(scoreBands.includes(String(event.scoreBand)) || event.scoreBand === "NOT_EVALUATED")
      || !["EMPTY", "1_99", "100_999", "1000_PLUS"].includes(String(event.lengthBand))
      || typeof event.policyRevision !== "number" || !Number.isSafeInteger(event.policyRevision) || event.policyRevision < 1
      || typeof event.engineVersion !== "string" || !/^[A-Za-z0-9.+_-]{1,32}$/.test(event.engineVersion)
      || !Array.isArray(event.reasonCodes) || event.reasonCodes.length > 8
      || event.reasonCodes.some((reason) => !REASONS.includes(String(reason)))
      || !event.categoryCounts || typeof event.categoryCounts !== "object" || Array.isArray(event.categoryCounts)) throw new TypeError("event is invalid");
    for (const [category, count] of Object.entries(event.categoryCounts as Record<string, unknown>)) {
      if (!CATEGORIES.includes(category) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new TypeError("event is invalid");
    }
    if (event.disposition === "FAILED_SAFE") {
      if (event.decisionAction !== null || event.aggregateTier !== "NOT_EVALUATED" || event.scoreBand !== "NOT_EVALUATED") throw new TypeError("event is invalid");
    } else if (event.decisionAction === null || event.aggregateTier === "NOT_EVALUATED" || event.scoreBand === "NOT_EVALUATED") throw new TypeError("event is invalid");
    if (event.disposition === "BLOCKED" && event.decisionAction !== "BLOCK") throw new TypeError("event is invalid");
    if (event.disposition === "PAGE_ATTESTED" && (event.siteId !== "SANDBOX" || event.coverageMode !== "SANDBOX_GUARDED"
      || !["ALLOW", "WARN", "REDACT"].includes(String(event.decisionAction)) || !event.reasonCodes.includes("PAGE_ACK_RECEIVED"))) throw new TypeError("event is invalid");
    if (event.disposition === "RELEASED_UNVERIFIED" && event.reasonCodes.includes("PAGE_ACK_RECEIVED")) throw new TypeError("event is invalid");
  } else throw new TypeError("event is invalid");

  // Return a plain structured clone after exact-key validation so no caller-owned
  // object or unexpected reference reaches persistent storage.
  return JSON.parse(JSON.stringify(event)) as RiskEventV2;
}

export class PrivacySafeQueue {
  private operation: Promise<unknown> = Promise.resolve();
  private readonly storage: StorageArea;
  private readonly now: () => number;

  constructor(storage: StorageArea, now: () => number = Date.now) {
    this.storage = storage;
    this.now = now;
  }

  private serialized<T>(callback: () => Promise<T>): Promise<T> {
    const next = this.operation.then(callback, callback);
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }

  private async loadQueue(): Promise<QueuedEvent[]> {
    const values = await this.storage.get([QUEUE_STORAGE_KEY]);
    const raw = values[QUEUE_STORAGE_KEY];
    if (!Array.isArray(raw)) return [];
    const cutoff = this.now() - MAX_QUEUE_AGE_MS;
    const valid: QueuedEvent[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const candidate = item as QueuedEvent;
      if (!Number.isFinite(candidate.queuedAt) || candidate.queuedAt < cutoff || !candidate.event || typeof candidate.event.deviceId !== "string") continue;
      try { valid.push({ event: serializeRiskEvent(candidate.event, candidate.event.deviceId), queuedAt: candidate.queuedAt }); } catch { /* Invalid persisted data is dropped before network use. */ }
    }
    return valid.slice(0, MAX_QUEUE_EVENTS);
  }

  async enqueue(input: unknown, deviceId: string): Promise<{ queued: boolean; reason?: "QUEUE_FULL" | "INVALID_EVENT" }> {
    return this.serialized(async () => {
      let event: RiskEventV2;
      try { event = serializeRiskEvent(input, deviceId); } catch { return { queued: false, reason: "INVALID_EVENT" }; }
      const queue = await this.loadQueue();
      if (queue.some((item) => item.event.eventId === event.eventId)) return { queued: true };
      if (queue.length >= MAX_QUEUE_EVENTS) return { queued: false, reason: "QUEUE_FULL" };
      queue.push({ event, queuedAt: this.now() });
      await this.storage.set({ [QUEUE_STORAGE_KEY]: queue });
      return { queued: true };
    });
  }

  async batch(): Promise<QueuedEvent[]> {
    return this.serialized(async () => {
      const queue = await this.loadQueue();
      await this.storage.set({ [QUEUE_STORAGE_KEY]: queue });
      return queue.slice(0, MAX_BATCH_EVENTS);
    });
  }

  async acknowledge(eventIds: string[]): Promise<void> {
    await this.serialized(async () => {
      const ids = new Set(eventIds);
      const queue = await this.loadQueue();
      await this.storage.set({ [QUEUE_STORAGE_KEY]: queue.filter((item) => !ids.has(item.event.eventId)) });
    });
  }

  async quarantine(eventIds: string[], status: number): Promise<void> {
    await this.serialized(async () => {
      const ids = new Set(eventIds);
      const values = await this.storage.get([QUARANTINE_STORAGE_KEY]);
      const previous = Array.isArray(values[QUARANTINE_STORAGE_KEY])
        ? (values[QUARANTINE_STORAGE_KEY] as unknown[]).filter((item): item is QuarantinedEvent => Boolean(
          item && typeof item === "object"
          && typeof (item as QuarantinedEvent).eventId === "string" && UUID.test((item as QuarantinedEvent).eventId)
          && Number.isFinite((item as QuarantinedEvent).quarantinedAt)
          && Number.isSafeInteger((item as QuarantinedEvent).status),
        ))
        : [];
      const quarantine = [...previous, ...eventIds.map((eventId) => ({ eventId, quarantinedAt: this.now(), status }))].slice(-MAX_QUEUE_EVENTS);
      const queue = await this.loadQueue();
      await this.storage.set({
        [QUEUE_STORAGE_KEY]: queue.filter((item) => !ids.has(item.event.eventId)),
        [QUARANTINE_STORAGE_KEY]: quarantine,
      });
    });
  }

  async size(): Promise<number> {
    return this.serialized(async () => (await this.loadQueue()).length);
  }
}
