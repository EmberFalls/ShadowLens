"""Generated from JSON Schema; do not edit by hand."""
from __future__ import annotations
from typing import Any, Literal, NotRequired, Required, TypeAlias, TypedDict, Union
from .event import RiskEventV2

EventBatchV2 = TypedDict("EventBatchV2", {
    "contractVersion": Required[Literal["v2"]],
    "events": Required[list["RiskEventV2"]],
}, total=False)
