"""Generated from JSON Schema; do not edit by hand."""
from __future__ import annotations
from typing import Any, Literal, NotRequired, Required, TypeAlias, TypedDict, Union

Finding = TypedDict("Finding", {
    "id": Required[str],
    "ruleId": Required[Literal["PII.EMAIL", "PII.INDIA_MOBILE", "PII.PAYMENT_CARD", "PII.AADHAAR", "PII.INDIA_PAN", "PII.GSTIN", "PII.IFSC", "PII.UPI", "SECRET.TOKEN", "SECRET.PEM_PRIVATE_KEY", "CONFIDENTIAL.MARKER", "CODE.STRUCTURE", "CONFIDENTIAL.CUSTOM_TERM", "PII.BULK_CONTACT_LIST"]],
    "category": Required["Category"],
    "severity": Required["Severity"],
    "start": Required[int],
    "end": Required[int],
    "confidenceHint": Required[Literal["LOW", "MEDIUM", "HIGH"]],
    "replaceable": Required[bool],
    "explanationCode": Required[Literal["EXPLAIN_CONTACT_EMAIL", "EXPLAIN_CONTACT_PHONE", "EXPLAIN_PAYMENT_CARD", "EXPLAIN_AADHAAR", "EXPLAIN_INDIA_PAN", "EXPLAIN_GSTIN", "EXPLAIN_IFSC", "EXPLAIN_UPI", "EXPLAIN_PROVIDER_TOKEN", "EXPLAIN_PRIVATE_KEY", "EXPLAIN_CONFIDENTIAL_MARKER", "EXPLAIN_SOURCE_CODE", "EXPLAIN_BULK_CONTACT_LIST", "EXPLAIN_CUSTOM_PROTECTED_TERM"]],
}, total=False)

Category: TypeAlias = Literal["PII_EMAIL", "PII_PHONE", "PII_PAYMENT_CARD", "PII_AADHAAR", "PII_INDIA_PAN", "PII_GSTIN", "PII_IFSC", "PII_UPI", "SECRET_TOKEN", "SECRET_PRIVATE_KEY", "CONFIDENTIAL_MARKER", "SOURCE_CODE_CONTEXT", "CUSTOM_PROTECTED_TERM", "BULK_CONTACT_LIST"]

Severity: TypeAlias = Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]

LocalAnalysisOutputV2 = TypedDict("LocalAnalysisOutputV2", {
    "contractVersion": Required[Literal["v2"]],
    "engineVersion": Required[str],
    "inputLength": Required[int],
    "findings": Required[list["Finding"]],
    "categoryCounts": Required[dict["Category", int]],
    "highestFindingSeverity": Required[Literal["LOW", "MEDIUM", "HIGH", "CRITICAL", None]],
    "aggregateScore": Required[int],
    "aggregateTier": Required[Literal["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"]],
    "scanCompleteness": Required[Literal["FULL"]],
}, total=False)
