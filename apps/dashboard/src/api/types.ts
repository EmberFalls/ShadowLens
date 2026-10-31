import type { DomainSummaryV2 as ContractDomainSummaryV2, DeviceListV2 } from "../../../../packages/contracts/src/generated/domain.js";
import type { EventPage, Summary, Timeseries, RiskEventV2 } from "../../../../packages/contracts/src/generated/analytics.js";

// Aliases retain the requested dashboard names while using SH-001's generated wire DTOs.
export type SummaryV2 = Summary;
export type DomainSummaryV2 = ContractDomainSummaryV2;
export type TimeseriesV2 = Timeseries;
export type EventPageV2 = EventPage;
export type { DeviceListV2, RiskEventV2 };
export interface RetentionSettings { retentionDays: number; updatedAt: string | null; }
export interface MetadataExport {
  contractVersion: "v2";
  exportedAt: string;
  retentionDays: number;
  events: RiskEventV2[];
  devices: Array<{ deviceId: string; deviceLabel: string; createdAt: string; revokedAt: string | null; lastHeartbeatAt: string | null }>;
  domains: Array<{ siteId: SiteId; canonicalHost: string; approvalStatus: ApprovalStatus; updatedAt: string }>;
  domainApprovalHistory: Array<{ siteId: SiteId; oldStatus: ApprovalStatus; newStatus: ApprovalStatus; changedAt: string }>;
  policy: OwnerPolicy;
  policyKeyId: string;
  administrativeAudit: Array<{ action: "RETENTION_CHANGED" | "EVENTS_DELETED" | "DEVICE_ENROLLED" | "DEVICE_REVOKED" | "POLICY_UPDATED"; detail: Record<string, string | number>; changedAt: string }>;
}
export interface NewDeviceCredential { deviceId: string; token: string; policyKeyId: string; }
export type PolicyAction = "ALLOW" | "WARN" | "REDACT" | "BLOCK";
export type PolicyCategory = "PII_EMAIL" | "PII_PHONE" | "PII_PAYMENT_CARD" | "PII_AADHAAR" | "PII_INDIA_PAN" | "PII_GSTIN" | "PII_IFSC" | "PII_UPI" | "SECRET_TOKEN" | "SECRET_PRIVATE_KEY" | "CONFIDENTIAL_MARKER" | "SOURCE_CODE_CONTEXT" | "CUSTOM_PROTECTED_TERM" | "BULK_CONTACT_LIST";
export interface PolicyRule { id: string; category: PolicyCategory | "*"; minimumSeverity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; action: PolicyAction; enabled: boolean; }
export interface OwnerPolicy { contractVersion: "v2"; revision: number; defaultFindingAction: "WARN" | "BLOCK"; rules: PolicyRule[]; allowWarnOverride: boolean; updatedAt: string; protectedTerms?: string[]; }
export type PolicyDraft = Pick<OwnerPolicy, "defaultFindingAction" | "rules" | "allowWarnOverride"> & { protectedTerms: string[] };
export interface PolicyKeyInfo { algorithm: "ECDSA_P256_SHA256"; keyId: string; }
export type SiteId = DomainSummaryV2["siteId"];
export type ApprovalStatus = DomainSummaryV2["approvalStatus"];

export interface DataClient {
  getSummary(days: number): Promise<SummaryV2>;
  getTimeseries(days: number, timezone: "UTC" | "Asia/Kolkata"): Promise<TimeseriesV2>;
  getEvents(limit: number, cursor?: string): Promise<EventPageV2>;
  getDomains(): Promise<DomainSummaryV2[]>;
  setApproval(siteId: SiteId, status: ApprovalStatus): Promise<DomainSummaryV2>;
  getDevices(): Promise<DeviceListV2>;
  enrollDevice(label: string): Promise<NewDeviceCredential>;
  revokeDevice(deviceId: string): Promise<DeviceListV2>;
  getRetentionSettings(): Promise<RetentionSettings>;
  setRetentionDays(days: number): Promise<{ retentionDays: number; previousRetentionDays: number; expiredEventsDeleted: number }>;
  exportMetadata(): Promise<MetadataExport>;
  deleteEventHistory(): Promise<{ deletedEvents: number }>;
  getPolicy(): Promise<OwnerPolicy>;
  setPolicy(policy: PolicyDraft): Promise<OwnerPolicy>;
  getPolicyKey(): Promise<PolicyKeyInfo>;
}
