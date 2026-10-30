import type { DataClient, DomainSummaryV2, EventPageV2, SiteId, ApprovalStatus, SummaryV2, TimeseriesV2, DeviceListV2 } from "./types.js";

const summary: SummaryV2 = {
  contractVersion: "v2", windowDays: 7, timezone: "UTC", siteVisitsObserved: 18,
  distinctAiSitesObserved: 4, guardedAttempts: 9, policyBlocks: 1, failedSafe: 1,
  redactionsPlanned: 3, redactionsPageAttested: 2, warningsIssued: 2,
  pageAttestedReleases: 7, observedDevices: 3, freshDevices: 2, staleDevices: 1,
  categories: { PII_EMAIL: 2, SECRET_TOKEN: 1 }, fromUtc: "2026-10-23T00:00:00Z",
  toUtc: "2026-10-30T00:00:00Z", coverageNote: "Partial coverage: only registered devices report; unsupported domains are not protected.",
};
const domains: DomainSummaryV2[] = [
  { siteId: "SANDBOX", approvalStatus: "APPROVED", supportStatus: "GUARDED", siteVisitsObserved: 5, guardedAttempts: 9, lastVisitAt: "2026-10-30T08:01:00Z" },
  { siteId: "CHATGPT", approvalStatus: "UNREVIEWED", supportStatus: "UNSUPPORTED", siteVisitsObserved: 8, guardedAttempts: 0, lastVisitAt: "2026-10-30T07:45:00Z" },
  { siteId: "GEMINI", approvalStatus: "UNAPPROVED", supportStatus: "BEST_EFFORT", siteVisitsObserved: 3, guardedAttempts: 0, lastVisitAt: "2026-10-29T13:20:00Z" },
  { siteId: "CLAUDE", approvalStatus: "UNREVIEWED", supportStatus: "UNSUPPORTED", siteVisitsObserved: 2, guardedAttempts: 0, lastVisitAt: null },
];
const events: EventPageV2 = {
  contractVersion: "v2", nextCursor: null, items: [
    { contractVersion: "v2", eventId: "c10165b4-7471-4ea0-a00d-72aeaa0c4e84", clientObservedAt: "2026-10-30T08:02:00Z", deviceId: "6bde3d14-92bb-461b-89f9-7bacb7fb846c", kind: "SUBMISSION", siteId: "SANDBOX", coverageMode: "SANDBOX_GUARDED", decisionAction: "REDACT", disposition: "PAGE_ATTESTED", aggregateTier: "HIGH", scoreBand: "HIGH", categoryCounts: { PII_EMAIL: 1 }, policyRevision: 1, engineVersion: "0.1.0", lengthBand: "1_99", reasonCodes: ["DETECTED_PII", "POLICY_REDACT", "PAGE_ACK_RECEIVED"] },
    { contractVersion: "v2", eventId: "4c59e6c1-1bc3-49bb-877a-84b69d8d6018", clientObservedAt: "2026-10-30T07:45:00Z", deviceId: "6bde3d14-92bb-461b-89f9-7bacb7fb846c", kind: "SITE_VISIT", siteId: "CHATGPT", supportStatus: "UNSUPPORTED", reasonCodes: ["UNSUPPORTED_AI_SITE_SEEN"] },
    { contractVersion: "v2", eventId: "07e98716-9789-4373-9f22-df1a55f7e40b", clientObservedAt: "2026-10-30T07:20:00Z", deviceId: "9bde3d14-92bb-461b-89f9-7bacb7fb846c", kind: "SUBMISSION", siteId: "SANDBOX", coverageMode: "SANDBOX_GUARDED", decisionAction: null, disposition: "FAILED_SAFE", aggregateTier: "NOT_EVALUATED", scoreBand: "NOT_EVALUATED", categoryCounts: {}, policyRevision: 1, engineVersion: "0.1.0", lengthBand: "1000_PLUS", reasonCodes: ["INPUT_TOO_LONG"] },
  ],
};
const devices: DeviceListV2 = { contractVersion: "v2", items: [
  { deviceId: "6bde3d14-92bb-461b-89f9-7bacb7fb846c", lastHeartbeatAt: "2026-10-30T08:02:00Z", lastEventAt: "2026-10-30T08:02:00Z", observation: "RECENTLY_SEEN" },
  { deviceId: "9bde3d14-92bb-461b-89f9-7bacb7fb846c", lastHeartbeatAt: "2026-10-30T07:20:00Z", lastEventAt: "2026-10-30T07:20:00Z", observation: "RECENTLY_SEEN" },
  { deviceId: "abde3d14-92bb-461b-89f9-7bacb7fb846c", lastHeartbeatAt: "2026-10-29T06:00:00Z", lastEventAt: null, observation: "STALE" },
] };

export const mockClient: DataClient = {
  async getSummary(days) { return { ...summary, windowDays: days }; },
  async getTimeseries(days, timezone): Promise<TimeseriesV2> {
    const end = new Date("2026-10-30T12:00:00Z");
    const buckets = Array.from({ length: days }, (_, index) => {
      const date = new Date(end);
      date.setUTCDate(end.getUTCDate() - (days - index - 1));
      const bucketDateLocal = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
      return { bucketDateLocal, siteVisitsObserved: [2, 3, 1, 4, 2, 3, 3][index % 7], guardedAttempts: [1, 1, 1, 2, 1, 2, 1][index % 7], policyBlocks: index % 7 === 3 ? 1 : 0, failedSafe: index % 7 === 4 ? 1 : 0, redactionsPageAttested: index % 7 === 2 || index % 7 === 5 ? 1 : 0 };
    });
    return { contractVersion: "v2", timezone, windowDays: days, buckets };
  },
  async getEvents(limit, cursor) { return { ...events, items: cursor ? [] : events.items.slice(0, limit) }; },
  async getDomains() { return domains.map((domain) => ({ ...domain })); },
  async setApproval(siteId: SiteId, status: ApprovalStatus) {
    const index = domains.findIndex((domain) => domain.siteId === siteId);
    if (index < 0) throw new Error("Unknown API error");
    // Mock request lifecycle is visible to the UI; this does not change enforcement.
    await Promise.resolve();
    domains[index] = { ...domains[index], approvalStatus: status };
    return { ...domains[index] };
  },
  async getDevices() { return { ...devices, items: devices.items.map((device) => ({ ...device })) }; },
};
