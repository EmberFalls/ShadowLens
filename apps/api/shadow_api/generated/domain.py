"""Generated from JSON Schema; do not edit by hand."""
from __future__ import annotations
from typing import Any, Literal, NotRequired, Required, TypeAlias, TypedDict, Union

Site: TypeAlias = Literal["SANDBOX", "CHATGPT", "GEMINI", "CLAUDE", "COPILOT", "PERPLEXITY"]

DomainSummaryV2 = TypedDict("DomainSummaryV2", {
    "siteId": Required["Site"],
    "approvalStatus": Required[Literal["APPROVED", "UNAPPROVED", "UNREVIEWED"]],
    "supportStatus": Required[Literal["GUARDED", "BEST_EFFORT", "UNSUPPORTED"]],
    "siteVisitsObserved": Required[int],
    "guardedAttempts": Required[int],
    "lastVisitAt": Required[Union[str, None]],
}, total=False)

DeviceSummaryV2 = TypedDict("DeviceSummaryV2", {
    "deviceId": Required[str],
    "lastHeartbeatAt": Required[Union[str, None]],
    "lastEventAt": Required[Union[str, None]],
    "lastMetadataSyncAt": Required[Union[str, None]],
    "extensionVersion": Required[Union[str, None]],
    "policyRevision": Required[Union[int, None]],
    "engineVersion": Required[Union[str, None]],
    "lastScannerResult": Required[Literal["NOT_REPORTED", "SCAN_REPORTED", "FAILED_SAFE"]],
    "observation": Required[Literal["RECENTLY_SEEN", "STALE", "NEVER_SEEN"]],
    "enrollmentStatus": Required[Literal["ACTIVE", "REVOKED"]],
}, total=False)

DeviceListV2 = TypedDict("DeviceListV2", {
    "contractVersion": Required[Literal["v2"]],
    "items": Required[list["DeviceSummaryV2"]],
}, total=False)

DomainAndDeviceProjectionV2: TypeAlias = Union[DomainSummaryV2, DeviceListV2]
