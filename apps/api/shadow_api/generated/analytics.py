"""Generated from JSON Schema; do not edit by hand."""
from __future__ import annotations
from typing import Any, Literal, NotRequired, Required, TypeAlias, TypedDict, Union
from .event import RiskEventV2

Count: TypeAlias = int

Category: TypeAlias = Literal["PII_EMAIL", "PII_PHONE", "PII_PAYMENT_CARD", "PII_AADHAAR", "PII_INDIA_PAN", "PII_GSTIN", "PII_IFSC", "PII_UPI", "SECRET_TOKEN", "SECRET_PRIVATE_KEY", "CONFIDENTIAL_MARKER", "SOURCE_CODE_CONTEXT", "CUSTOM_PROTECTED_TERM", "BULK_CONTACT_LIST"]

Summary = TypedDict("Summary", {
    "contractVersion": Required[Literal["v2"]],
    "windowDays": Required[int],
    "timezone": Required[Literal["UTC", "Asia/Kolkata"]],
    "siteVisitsObserved": Required["Count"],
    "distinctAiSitesObserved": Required["Count"],
    "guardedAttempts": Required["Count"],
    "policyBlocks": Required["Count"],
    "failedSafe": Required["Count"],
    "redactionsPlanned": Required["Count"],
    "redactionsPageAttested": Required["Count"],
    "warningsIssued": Required["Count"],
    "pageAttestedReleases": Required["Count"],
    "observedDevices": Required["Count"],
    "freshDevices": Required["Count"],
    "staleDevices": Required["Count"],
    "categories": Required[dict["Category", "Count"]],
    "fromUtc": Required[str],
    "toUtc": Required[str],
    "coverageNote": Required[str],
}, total=False)

Timeseries = TypedDict("Timeseries", {
    "contractVersion": Required[Literal["v2"]],
    "timezone": Required[Literal["UTC", "Asia/Kolkata"]],
    "windowDays": Required[int],
    "buckets": Required[list["TimeseriesBucketsItem"]],
}, total=False)

EventPage = TypedDict("EventPage", {
    "contractVersion": Required[Literal["v2"]],
    "items": Required[list["RiskEventV2"]],
    "nextCursor": Required[Union[str, None]],
}, total=False)

AnalyticsResponseV2: TypeAlias = Union[Summary, Timeseries, EventPage]

TimeseriesBucketsItem = TypedDict("TimeseriesBucketsItem", {
    "bucketDateLocal": Required[str],
    "siteVisitsObserved": Required["Count"],
    "guardedAttempts": Required["Count"],
    "policyBlocks": Required["Count"],
    "failedSafe": Required["Count"],
    "redactionsPageAttested": Required["Count"],
}, total=False)
