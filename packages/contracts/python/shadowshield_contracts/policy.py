"""Generated from JSON Schema; do not edit by hand."""
from __future__ import annotations
from typing import Any, Literal, NotRequired, Required, TypeAlias, TypedDict, Union

Severity: TypeAlias = Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]

Category: TypeAlias = Literal["PII_EMAIL", "PII_PHONE", "PII_PAYMENT_CARD", "PII_AADHAAR", "PII_INDIA_PAN", "PII_GSTIN", "PII_IFSC", "PII_UPI", "SECRET_TOKEN", "SECRET_PRIVATE_KEY", "CONFIDENTIAL_MARKER", "SOURCE_CODE_CONTEXT", "CUSTOM_PROTECTED_TERM", "BULK_CONTACT_LIST"]

ReasonCode: TypeAlias = Literal["DETECTED_PII", "DETECTED_SECRET", "DETECTED_CONFIDENTIAL", "DETECTED_SOURCE_CODE", "DETECTED_BULK", "DETECTED_CUSTOM_TERM", "POLICY_ALLOW", "POLICY_WARN", "POLICY_REDACT", "POLICY_BLOCK", "POLICY_FALLBACK_WARN", "REDACTION_RESIDUAL"]

Action: TypeAlias = Literal["ALLOW", "WARN", "REDACT", "BLOCK"]

Config = TypedDict("Config", {
    "contractVersion": Required[Literal["v2"]],
    "revision": Required[int],
    "defaultFindingAction": Required[Literal["WARN", "BLOCK"]],
    "rules": Required[list["ConfigRulesItem"]],
    "allowWarnOverride": Required[bool],
    "updatedAt": Required[str],
    "protectedTerms": NotRequired[list[str]],
}, total=False)

Decision = TypedDict("Decision", {
    "action": Required["Action"],
    "score": Required[int],
    "aggregateTier": Required[Literal["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"]],
    "matchedRuleIds": Required[list[str]],
    "reasonCodes": Required[list["ReasonCode"]],
    "overrideAllowed": Required[bool],
    "requiresWarnAcknowledgement": Required[bool],
    "replacementOperations": Required[list["DecisionReplacementOperationsItem"]],
    "policyRevision": Required[int],
}, total=False)

PolicyConfigAndDecisionV2: TypeAlias = Union[Config, Decision]

ConfigRulesItem = TypedDict("ConfigRulesItem", {
    "id": Required[str],
    "category": Required[Union["Category", Literal["*"]]],
    "minimumSeverity": Required["Severity"],
    "action": Required["Action"],
    "enabled": Required[bool],
}, total=False)

DecisionReplacementOperationsItem = TypedDict("DecisionReplacementOperationsItem", {
    "start": Required[int],
    "end": Required[int],
    "replacement": Required[str],
    "category": Required["Category"],
}, total=False)
