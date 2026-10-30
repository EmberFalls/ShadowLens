import type { DomainSummaryV2 as ContractDomainSummaryV2, DeviceListV2 } from "../../../../packages/contracts/src/generated/domain.js";
import type { EventPage, Summary, Timeseries, RiskEventV2 } from "../../../../packages/contracts/src/generated/analytics.js";

// Aliases retain the requested dashboard names while using SH-001's generated wire DTOs.
export type SummaryV2 = Summary;
export type DomainSummaryV2 = ContractDomainSummaryV2;
export type TimeseriesV2 = Timeseries;
export type EventPageV2 = EventPage;
export type { DeviceListV2, RiskEventV2 };
export type SiteId = DomainSummaryV2["siteId"];
export type ApprovalStatus = DomainSummaryV2["approvalStatus"];

export interface DataClient {
  getSummary(days: number): Promise<SummaryV2>;
  getTimeseries(days: number, timezone: "UTC" | "Asia/Kolkata"): Promise<TimeseriesV2>;
  getEvents(limit: number, cursor?: string): Promise<EventPageV2>;
  getDomains(): Promise<DomainSummaryV2[]>;
  setApproval(siteId: SiteId, status: ApprovalStatus): Promise<DomainSummaryV2>;
  getDevices(): Promise<DeviceListV2>;
}
