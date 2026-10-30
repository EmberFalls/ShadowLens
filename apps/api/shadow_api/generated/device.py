"""Generated from JSON Schema; do not edit by hand."""
from __future__ import annotations
from typing import Any, Literal, NotRequired, Required, TypeAlias, TypedDict, Union

DeviceHeartbeatV2 = TypedDict("DeviceHeartbeatV2", {
    "contractVersion": Required[Literal["v2"]],
    "eventId": Required[str],
    "clientObservedAt": Required[str],
    "deviceId": Required[str],
    "kind": Required[Literal["DEVICE_HEARTBEAT"]],
    "extensionVersion": Required[str],
}, total=False)
