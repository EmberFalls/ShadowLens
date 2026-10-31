"""Strict v2 event parsing and atomic SQLite batch ingestion."""

from __future__ import annotations

from datetime import datetime
import json
import re
import sqlite3
from typing import Annotated, Literal, TypeAlias
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from ..db.database import normalize_utc_timestamp, record_device_runtime_metadata, transaction

MAX_BATCH_ITEMS = 25
MAX_BATCH_BYTES = 32 * 1024

SiteId: TypeAlias = Literal["SANDBOX", "CHATGPT", "GEMINI", "CLAUDE", "COPILOT", "PERPLEXITY"]
Category: TypeAlias = Literal[
    "PII_EMAIL", "PII_PHONE", "PII_PAYMENT_CARD", "PII_AADHAAR", "PII_INDIA_PAN", "PII_GSTIN",
    "PII_IFSC", "PII_UPI", "SECRET_TOKEN", "SECRET_PRIVATE_KEY", "CONFIDENTIAL_MARKER",
    "SOURCE_CODE_CONTEXT", "CUSTOM_PROTECTED_TERM", "BULK_CONTACT_LIST",
]
ReasonCode: TypeAlias = Literal[
    "DETECTED_PII", "DETECTED_SECRET", "DETECTED_CONFIDENTIAL", "DETECTED_SOURCE_CODE", "DETECTED_BULK",
    "DETECTED_CUSTOM_TERM", "POLICY_ALLOW", "POLICY_WARN", "POLICY_REDACT", "POLICY_BLOCK",
    "POLICY_FALLBACK_WARN", "USER_CANCELLED", "USER_ACKNOWLEDGED", "USER_APPROVED_REDACTION",
    "REDACTION_RESIDUAL", "RELEASE_WRITE_MISMATCH", "EDITOR_CHANGED", "SCANNER_TIMEOUT", "INPUT_TOO_LONG",
    "INVALID_POLICY", "ENGINE_FAILURE", "BACKEND_OFFLINE", "UNSUPPORTED_AI_SITE_SEEN", "UPLOAD_UNINSPECTED",
    "PAGE_ACK_RECEIVED", "PAGE_ACK_TIMEOUT",
]
DecisionAction: TypeAlias = Literal["ALLOW", "WARN", "REDACT", "BLOCK"]
FindingTier: TypeAlias = Literal["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"]
CoverageMode: TypeAlias = Literal["SANDBOX_GUARDED", "THIRD_PARTY_BEST_EFFORT", "UNSUPPORTED"]
_UTC_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Submission(StrictModel):
    contractVersion: Literal["v2"]
    eventId: UUID
    clientObservedAt: str
    deviceId: UUID
    kind: Literal["SUBMISSION"]
    siteId: SiteId
    coverageMode: CoverageMode
    decisionAction: DecisionAction | None
    disposition: Literal["CANCELLED", "BLOCKED", "FAILED_SAFE", "RELEASED_UNVERIFIED", "PAGE_ATTESTED"]
    aggregateTier: FindingTier | Literal["NOT_EVALUATED"]
    scoreBand: Literal["ZERO", "LOW", "MEDIUM", "HIGH", "CRITICAL", "NOT_EVALUATED"]
    categoryCounts: dict[Category, Annotated[int, Field(ge=0, strict=True)]]
    policyRevision: Annotated[int, Field(ge=1, strict=True)]
    engineVersion: Annotated[str, Field(min_length=1)]
    lengthBand: Literal["EMPTY", "1_99", "100_999", "1000_PLUS"]
    reasonCodes: Annotated[list[ReasonCode], Field(max_length=8)]

    @field_validator("clientObservedAt")
    @classmethod
    def utc_observation_timestamp(cls, value: str) -> str:
        if not _UTC_PATTERN.fullmatch(value):
            raise ValueError("timestamp must be UTC")
        normalize_utc_timestamp(value)
        return value

    @model_validator(mode="after")
    def validate_disposition_fields(self) -> "Submission":
        reasons = self.reasonCodes
        if self.disposition == "FAILED_SAFE":
            if self.decisionAction is not None or self.aggregateTier != "NOT_EVALUATED" or self.scoreBand != "NOT_EVALUATED":
                raise ValueError("invalid failed-safe score state")
            return self
        if self.decisionAction is None or self.aggregateTier == "NOT_EVALUATED" or self.scoreBand == "NOT_EVALUATED":
            raise ValueError("completed submission requires an evaluated score")
        if self.disposition == "BLOCKED" and self.decisionAction != "BLOCK":
            raise ValueError("blocked disposition requires BLOCK decision")
        if self.disposition == "PAGE_ATTESTED":
            if self.siteId != "SANDBOX" or self.coverageMode != "SANDBOX_GUARDED":
                raise ValueError("page-attested disposition requires guarded sandbox")
            if self.decisionAction not in {"ALLOW", "WARN", "REDACT"} or "PAGE_ACK_RECEIVED" not in reasons:
                raise ValueError("page-attested disposition requires acknowledgment")
        if self.disposition == "RELEASED_UNVERIFIED":
            if self.decisionAction not in {"ALLOW", "WARN", "REDACT"} or "PAGE_ACK_RECEIVED" in reasons:
                raise ValueError("invalid unverified-release disposition")
        return self


class SiteVisit(StrictModel):
    contractVersion: Literal["v2"]
    eventId: UUID
    clientObservedAt: str
    deviceId: UUID
    kind: Literal["SITE_VISIT"]
    siteId: SiteId
    supportStatus: Literal["GUARDED", "BEST_EFFORT", "UNSUPPORTED"]
    reasonCodes: list[Literal["UNSUPPORTED_AI_SITE_SEEN"]]

    @field_validator("clientObservedAt")
    @classmethod
    def utc_observation_timestamp(cls, value: str) -> str:
        if not _UTC_PATTERN.fullmatch(value):
            raise ValueError("timestamp must be UTC")
        normalize_utc_timestamp(value)
        return value


class Heartbeat(StrictModel):
    contractVersion: Literal["v2"]
    eventId: UUID
    clientObservedAt: str
    deviceId: UUID
    kind: Literal["DEVICE_HEARTBEAT"]
    extensionVersion: Annotated[str, Field(min_length=1)]

    @field_validator("clientObservedAt")
    @classmethod
    def utc_observation_timestamp(cls, value: str) -> str:
        if not _UTC_PATTERN.fullmatch(value):
            raise ValueError("timestamp must be UTC")
        normalize_utc_timestamp(value)
        return value


RiskEvent: TypeAlias = Annotated[Submission | SiteVisit | Heartbeat, Field(discriminator="kind")]


class EventBatch(StrictModel):
    contractVersion: Literal["v2"]
    events: Annotated[list[RiskEvent], Field(min_length=1, max_length=MAX_BATCH_ITEMS)]


class IngestResponse(BaseModel):
    accepted: int = Field(ge=0)
    duplicates: int = Field(ge=0)
    rejected: Literal[0] = 0


class InvalidEventBatch(Exception):
    """A batch does not conform to the frozen v2 event contract."""


class PayloadTooLarge(Exception):
    """The encoded request body exceeds the 32 KiB contract limit."""


class DatabaseUnavailable(Exception):
    """The batch could not be persisted because SQLite is unavailable."""


def parse_event_batch(raw_body: bytes) -> EventBatch:
    """Parse and validate an entire request without returning input details."""
    if len(raw_body) > MAX_BATCH_BYTES:
        raise PayloadTooLarge
    try:
        return EventBatch.model_validate_json(raw_body)
    except (ValidationError, ValueError, UnicodeDecodeError):
        raise InvalidEventBatch from None


def ingest_event_batch(
    connection: sqlite3.Connection,
    *,
    authenticated_device_id: str,
    batch: EventBatch,
    ingested_at: datetime | str | None = None,
) -> IngestResponse:
    """Insert all new events in one transaction and leave duplicate rows intact."""
    if any(str(event.deviceId) != authenticated_device_id for event in batch.events):
        raise InvalidEventBatch

    server_time = normalize_utc_timestamp(ingested_at)
    accepted = 0
    duplicates = 0
    try:
        with transaction(connection):
            for event in batch.events:
                payload = json.dumps(event.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
                cursor = connection.execute(
                    "INSERT INTO events(event_id, device_id, kind, site_id, payload_json, ingested_at) "
                    "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING",
                    (
                        str(event.eventId),
                        authenticated_device_id,
                        event.kind,
                        None if isinstance(event, Heartbeat) else event.siteId,
                        payload,
                        server_time,
                    ),
                )
                if cursor.rowcount == 0:
                    duplicates += 1
                    continue
                accepted += 1
                record_device_runtime_metadata(
                    connection,
                    event.model_dump(mode="json"),
                    ingested_at=server_time,
                )
    except sqlite3.Error:
        raise DatabaseUnavailable from None
    return IngestResponse(accepted=accepted, duplicates=duplicates)
