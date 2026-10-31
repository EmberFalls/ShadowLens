"""Persistent owner policy validation and revision management."""

from __future__ import annotations

import json
import sqlite3
from typing import Literal
import unicodedata

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..db.database import normalize_utc_timestamp, transaction

Category = Literal[
    "PII_EMAIL", "PII_PHONE", "PII_PAYMENT_CARD", "PII_AADHAAR", "PII_INDIA_PAN", "PII_GSTIN",
    "PII_IFSC", "PII_UPI", "SECRET_TOKEN", "SECRET_PRIVATE_KEY", "CONFIDENTIAL_MARKER",
    "SOURCE_CODE_CONTEXT", "CUSTOM_PROTECTED_TERM", "BULK_CONTACT_LIST", "*",
]

DEFAULT_POLICY: dict[str, object] = {
    "contractVersion": "v2",
    "revision": 1,
    "defaultFindingAction": "WARN",
    "allowWarnOverride": True,
    "updatedAt": "2026-10-30T00:00:00Z",
    "protectedTerms": [],
    "rules": [
        {"id": "POLICY.PRIVATE_KEY", "category": "SECRET_PRIVATE_KEY", "minimumSeverity": "LOW", "action": "BLOCK", "enabled": True},
        {"id": "POLICY.TOKEN", "category": "SECRET_TOKEN", "minimumSeverity": "HIGH", "action": "REDACT", "enabled": True},
        {"id": "POLICY.CARD", "category": "PII_PAYMENT_CARD", "minimumSeverity": "HIGH", "action": "REDACT", "enabled": True},
        {"id": "POLICY.AADHAAR", "category": "PII_AADHAAR", "minimumSeverity": "HIGH", "action": "REDACT", "enabled": True},
        {"id": "POLICY.INDIA_PAN", "category": "PII_INDIA_PAN", "minimumSeverity": "HIGH", "action": "REDACT", "enabled": True},
        {"id": "POLICY.EMAIL", "category": "PII_EMAIL", "minimumSeverity": "MEDIUM", "action": "REDACT", "enabled": True},
        {"id": "POLICY.PHONE", "category": "PII_PHONE", "minimumSeverity": "MEDIUM", "action": "REDACT", "enabled": True},
        {"id": "POLICY.MARKER", "category": "CONFIDENTIAL_MARKER", "minimumSeverity": "HIGH", "action": "WARN", "enabled": True},
        {"id": "POLICY.CODE", "category": "SOURCE_CODE_CONTEXT", "minimumSeverity": "MEDIUM", "action": "WARN", "enabled": True},
        {"id": "POLICY.BULK", "category": "BULK_CONTACT_LIST", "minimumSeverity": "HIGH", "action": "WARN", "enabled": True},
    ],
}


class PolicyRule(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")
    category: Category
    minimumSeverity: Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]
    action: Literal["ALLOW", "WARN", "REDACT", "BLOCK"]
    enabled: bool


class PolicyUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    defaultFindingAction: Literal["WARN", "BLOCK"]
    rules: list[PolicyRule] = Field(max_length=32)
    allowWarnOverride: bool
    protectedTerms: list[str] = Field(default_factory=list, max_length=100)

    @field_validator("protectedTerms")
    @classmethod
    def validate_protected_terms(cls, terms: list[str]) -> list[str]:
        normalized_terms: list[str] = []
        seen: set[str] = set()
        for raw in terms:
            term = unicodedata.normalize("NFC", raw.strip())
            utf16_length = len(term.encode("utf-16-le")) // 2
            if utf16_length < 3 or utf16_length > 100 or any(ord(char) < 32 or ord(char) == 127 for char in term):
                raise ValueError("protected terms must contain 3 to 100 printable characters")
            key = term.casefold()
            if key in seen:
                raise ValueError("protected terms must be unique, ignoring case")
            seen.add(key)
            normalized_terms.append(term)
        return normalized_terms


def _validate_rule_invariants(update: PolicyUpdate) -> None:
    rules = [rule.model_dump(mode="json") for rule in update.rules]
    ids = [rule["id"] for rule in rules]
    if len(ids) != len(set(ids)):
        raise ValueError("policy rule IDs must be unique")
    private_key_rules = [rule for rule in rules if rule["category"] == "SECRET_PRIVATE_KEY"]
    if len(private_key_rules) != 1 or private_key_rules[0]["minimumSeverity"] != "LOW" \
        or private_key_rules[0]["action"] != "BLOCK" or private_key_rules[0]["enabled"] is not True:
        raise ValueError("private key policy must remain enabled and blocking")


def read_policy(connection: sqlite3.Connection) -> dict[str, object]:
    row = connection.execute(
        "SELECT setting_value FROM app_settings WHERE setting_key='owner_policy_json'"
    ).fetchone()
    if row is None:
        return json.loads(json.dumps(DEFAULT_POLICY))
    try:
        stored = json.loads(str(row["setting_value"]))
        contract_version = stored.pop("contractVersion")
        revision = stored.pop("revision")
        updated_at = stored.pop("updatedAt")
        if contract_version != "v2":
            raise ValueError("stored contract version is invalid")
        update = PolicyUpdate.model_validate(stored)
        if type(revision) is not int or not 1 <= revision <= 2_147_483_647:
            raise ValueError("stored revision is invalid")
        if not isinstance(updated_at, str) or not updated_at.endswith("Z"):
            raise ValueError("stored timestamp is invalid")
        normalize_utc_timestamp(updated_at)
        _validate_rule_invariants(update)
        return {
            "contractVersion": "v2",
            "revision": revision,
            **update.model_dump(mode="json"),
            "updatedAt": updated_at,
        }
    except (ValueError, TypeError, KeyError) as exc:
        raise sqlite3.DatabaseError("stored owner policy is invalid") from exc


def save_policy(connection: sqlite3.Connection, update: PolicyUpdate) -> dict[str, object]:
    _validate_rule_invariants(update)

    timestamp = normalize_utc_timestamp()
    with transaction(connection):
        previous = read_policy(connection)
        if int(previous["revision"]) >= 2_147_483_647:
            raise ValueError("policy revision limit reached")
        policy: dict[str, object] = {
            "contractVersion": "v2",
            "revision": int(previous["revision"]) + 1,
            **update.model_dump(mode="json"),
            "updatedAt": timestamp,
        }
        serialized = json.dumps(policy, separators=(",", ":"), ensure_ascii=False)
        connection.execute(
            "INSERT INTO app_settings(setting_key, setting_value, updated_at) VALUES ('owner_policy_json', ?, ?) "
            "ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value, updated_at=excluded.updated_at",
            (serialized, timestamp),
        )
        connection.execute(
            "INSERT INTO owner_audit(action, detail_json, changed_at) VALUES ('POLICY_UPDATED', ?, ?)",
            (json.dumps({"revision": policy["revision"]}, separators=(",", ":")), timestamp),
        )
    return policy
