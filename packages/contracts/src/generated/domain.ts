/* Generated from schemas/domain.schema.json; do not edit. */

export type DomainAndDeviceProjectionV2 = DomainSummaryV2 | DeviceListV2;
export type Site = 'SANDBOX' | 'CHATGPT' | 'GEMINI' | 'CLAUDE' | 'COPILOT' | 'PERPLEXITY';

export interface DomainSummaryV2 {
  siteId: Site;
  approvalStatus: 'APPROVED' | 'UNAPPROVED' | 'UNREVIEWED';
  supportStatus: 'GUARDED' | 'BEST_EFFORT' | 'UNSUPPORTED';
  siteVisitsObserved: number;
  guardedAttempts: number;
  lastVisitAt: string | null;
  bestEffortAttempts: number;
}
export interface DeviceListV2 {
  contractVersion: 'v2';
  items: DeviceSummaryV2[];
}
export interface DeviceSummaryV2 {
  deviceId: string;
  lastHeartbeatAt: string | null;
  lastEventAt: string | null;
  observation: 'RECENTLY_SEEN' | 'STALE' | 'NEVER_SEEN';
  enrollmentStatus: 'ACTIVE' | 'REVOKED';
}
