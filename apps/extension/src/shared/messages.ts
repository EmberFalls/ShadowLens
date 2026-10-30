namespace ShadowShield.Messages {
  export type SetDeviceCredential = { type: "SET_DEVICE_CREDENTIAL"; token: string; deviceId?: string };
  export type GetConnectionStatus = { type: "GET_CONNECTION_STATUS" };
  export type CommonEvent = { contractVersion: "v2"; eventId: string; clientObservedAt: string; deviceId?: string };
  export type SubmissionEvent = CommonEvent & {
    kind: "SUBMISSION"; siteId: "SANDBOX" | "CHATGPT" | "GEMINI" | "CLAUDE" | "COPILOT" | "PERPLEXITY";
    coverageMode: "SANDBOX_GUARDED" | "THIRD_PARTY_BEST_EFFORT" | "UNSUPPORTED";
    decisionAction: "ALLOW" | "WARN" | "REDACT" | "BLOCK" | null;
    disposition: "CANCELLED" | "BLOCKED" | "FAILED_SAFE" | "RELEASED_UNVERIFIED" | "PAGE_ATTESTED";
    aggregateTier: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "NOT_EVALUATED";
    scoreBand: "ZERO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "NOT_EVALUATED";
    categoryCounts: Record<string, number>; policyRevision: number; engineVersion: string;
    lengthBand: "EMPTY" | "1_99" | "100_999" | "1000_PLUS"; reasonCodes: string[];
  };
  export type SiteVisitEvent = CommonEvent & {
    kind: "SITE_VISIT"; siteId: "SANDBOX" | "CHATGPT" | "GEMINI" | "CLAUDE" | "COPILOT" | "PERPLEXITY";
    supportStatus: "GUARDED" | "BEST_EFFORT" | "UNSUPPORTED"; reasonCodes: string[];
  };
  export type HeartbeatEvent = CommonEvent & { kind: "DEVICE_HEARTBEAT"; extensionVersion: string };
  export type EventDraft = SubmissionEvent | SiteVisitEvent | HeartbeatEvent;
  export type EnqueueEvent = { type: "ENQUEUE_EVENT"; event: EventDraft };
  export type GetCoverage = { type: "GET_COVERAGE" };
  export type RequestAnalysis = { type: "ANALYZE_LOCAL"; text: string };
  export type VerifyRedaction = { type: "VERIFY_REDACTION"; originalText: string; approvedText: string; analysis: ShadowShield.Content.Analysis; warnAcknowledged: boolean };
  export type CoverageUpdate = { type: "COVERAGE_UPDATE"; coverage: CoverageStatus };
  export type Request = SetDeviceCredential | GetConnectionStatus | EnqueueEvent | GetCoverage | RequestAnalysis | VerifyRedaction | CoverageUpdate;
  export type ConnectionStatus = { connected: boolean; reconnectRequired: boolean; message: string };
  export type CoverageStatus = { mode: "SANDBOX_GUARDED" | "UNPROTECTED" | "UNSUPPORTED"; label: string };
}
