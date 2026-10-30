"""Read-only display projection of the bundled v2 policy."""

from __future__ import annotations

from copy import deepcopy
from typing import Annotated

from fastapi import APIRouter, Depends

from ..security import require_owner

router = APIRouter()

# This endpoint is informational. The extension continues to enforce its own
# bundled policy and never treats this response as an authoritative override.
_BUNDLED_POLICY = {
    "contractVersion": "v2",
    "revision": 1,
    "defaultFindingAction": "WARN",
    "rules": [{
        "id": "POLICY.PRIVATE_KEY",
        "category": "SECRET_PRIVATE_KEY",
        "minimumSeverity": "LOW",
        "action": "BLOCK",
        "enabled": True,
    }],
    "allowWarnOverride": True,
    "updatedAt": "2026-10-30T00:00:00Z",
}


@router.get("/policy")
def get_policy(_owner: Annotated[str, Depends(require_owner)]):
    return deepcopy(_BUNDLED_POLICY)

