"""Generated from JSON Schema; do not edit by hand."""
from __future__ import annotations
from typing import Any, Literal, NotRequired, Required, TypeAlias, TypedDict, Union

Submission = TypedDict("Submission", {
    "contractVersion": Required[Literal["v2"]],
    "eventId": Required[str],
    "clientObservedAt": Required[str],
    "deviceId": Required[str],
    "kind": Required[Literal["SUBMISSION"]],
    "siteId": Required[Literal["SANDBOX", "CHATGPT", "GEMINI", "CLAUDE", "COPILOT", "PERPLEXITY"]],
    "coverageMode": Required[Literal["SANDBOX_GUARDED", "THIRD_PARTY_BEST_EFFORT", "UNSUPPORTED"]],
    "decisionAction": Required[Literal["ALLOW", "WARN", "REDACT", "BLOCK", None]],
    "disposition": Required[Literal["CANCELLED", "BLOCKED", "FAILED_SAFE", "RELEASED_UNVERIFIED", "PAGE_ATTESTED"]],
    "aggregateTier": Required[Literal["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL", "NOT_EVALUATED"]],
    "scoreBand": Required[Literal["ZERO", "LOW", "MEDIUM", "HIGH", "CRITICAL", "NOT_EVALUATED"]],
    "categoryCounts": Required[dict[Literal["PII_EMAIL", "PII_PHONE", "PII_PAYMENT_CARD", "PII_AADHAAR", "PII_INDIA_PAN", "PII_GSTIN", "PII_IFSC", "PII_UPI", "SECRET_TOKEN", "SECRET_PRIVATE_KEY", "CONFIDENTIAL_MARKER", "SOURCE_CODE_CONTEXT", "CUSTOM_PROTECTED_TERM", "BULK_CONTACT_LIST"], int]],
    "policyRevision": Required[int],
    "engineVersion": Required[str],
    "lengthBand": Required[Literal["EMPTY", "1_99", "100_999", "1000_PLUS"]],
    "reasonCodes": Required[list[Literal["DETECTED_PII", "DETECTED_SECRET", "DETECTED_CONFIDENTIAL", "DETECTED_SOURCE_CODE", "DETECTED_BULK", "DETECTED_CUSTOM_TERM", "POLICY_ALLOW", "POLICY_WARN", "POLICY_REDACT", "POLICY_BLOCK", "POLICY_FALLBACK_WARN", "USER_CANCELLED", "USER_ACKNOWLEDGED", "USER_APPROVED_REDACTION", "REDACTION_RESIDUAL", "RELEASE_WRITE_MISMATCH", "EDITOR_CHANGED", "SCANNER_TIMEOUT", "INPUT_TOO_LONG", "INVALID_POLICY", "ENGINE_FAILURE", "BACKEND_OFFLINE", "UNSUPPORTED_AI_SITE_SEEN", "UPLOAD_UNINSPECTED", "PAGE_ACK_RECEIVED", "PAGE_ACK_TIMEOUT"]]],
}, total=False)

SiteVisit = TypedDict("SiteVisit", {
    "contractVersion": Required[Literal["v2"]],
    "eventId": Required[str],
    "clientObservedAt": Required[str],
    "deviceId": Required[str],
    "kind": Required[Literal["SITE_VISIT"]],
    "siteId": Required[Literal["SANDBOX", "CHATGPT", "GEMINI", "CLAUDE", "COPILOT", "PERPLEXITY"]],
    "supportStatus": Required[Literal["GUARDED", "BEST_EFFORT", "UNSUPPORTED"]],
    "reasonCodes": Required[list[Literal["UNSUPPORTED_AI_SITE_SEEN"]]],
}, total=False)

Heartbeat = TypedDict("Heartbeat", {
    "contractVersion": Required[Literal["v2"]],
    "eventId": Required[str],
    "clientObservedAt": Required[str],
    "deviceId": Required[str],
    "kind": Required[Literal["DEVICE_HEARTBEAT"]],
    "extensionVersion": Required[str],
}, total=False)

RiskEventV2: TypeAlias = Union[Submission, SiteVisit, Heartbeat]
