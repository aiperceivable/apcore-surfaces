"""Strict projection of verified RFC 8693 JWT claims."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, replace
from typing import Any

from apcore import Identity

_SCOPE_TOKEN = re.compile(r"[\x21\x23-\x5b\x5d-\x7e]+")


@dataclass(frozen=True)
class DelegatedClaims:
    """Opt in to JWT scopes and optionally select provider and actor-role claims."""

    scp_claim: str | None = None
    actor_roles_claim: str | None = None

    def __post_init__(self) -> None:
        for claim in (self.scp_claim, self.actor_roles_claim):
            if claim is not None and (not isinstance(claim, str) or not claim):
                raise ValueError("JWT claim names must be nonempty strings")


def _scopes(value: Any, *, allow_array: bool = False) -> tuple[str, ...]:
    if isinstance(value, str):
        scopes = value.split(" ")
    elif allow_array and isinstance(value, list):
        scopes = value
    else:
        raise ValueError("Invalid JWT scope representation")
    if not all(isinstance(scope, str) and _SCOPE_TOKEN.fullmatch(scope) for scope in scopes):
        raise ValueError("Invalid JWT scope token")
    return tuple(sorted(set(scopes)))


def _token_scopes(payload: dict[str, Any], mapping: DelegatedClaims) -> tuple[str, ...]:
    standard = _scopes(payload["scope"]) if "scope" in payload else None
    alternate = (
        _scopes(payload[mapping.scp_claim], allow_array=True)
        if mapping.scp_claim is not None and mapping.scp_claim in payload
        else None
    )
    if standard is None and alternate is None:
        raise ValueError("JWT must carry a configured scope claim")
    if standard is not None and alternate is not None and standard != alternate:
        raise ValueError("JWT scope claims disagree")
    return standard if standard is not None else alternate or ()


def _nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value)


def _validate_times(payload: dict[str, Any]) -> None:
    for claim in ("exp", "nbf", "iat"):
        if claim in payload:
            value = payload[claim]
            if type(value) not in (int, float) or not math.isfinite(value):
                raise ValueError("JWT time claim must be numeric")


def _outer_actor(value: Any, mapping: DelegatedClaims, issuer: str) -> Identity:
    node = value
    for _ in range(8):
        if not isinstance(node, dict) or not _nonempty_string(node.get("sub")):
            raise ValueError("JWT act claim must contain a subject")
        if "iss" in node and not _nonempty_string(node["iss"]):
            raise ValueError("JWT actor issuer must be a nonempty string")
        if "act" not in node:
            break
        node = node["act"]
    else:
        raise ValueError("JWT actor history is too deep")

    actor_type = value.get("type", "agent")
    if not _nonempty_string(actor_type):
        raise ValueError("JWT actor type must be a nonempty string")
    roles = value.get(mapping.actor_roles_claim, []) if mapping.actor_roles_claim is not None else []
    if not isinstance(roles, list) or not all(_nonempty_string(role) for role in roles):
        raise ValueError("Mapped JWT actor roles must be an array of strings")
    return Identity(value["sub"], actor_type, tuple(roles), issuer=issuer)


def project_delegated_identity(payload: dict[str, Any], identity: Identity, mapping: DelegatedClaims) -> Identity:
    """Map verified claims to one active link and validate bounded actor history."""
    issuer = payload["iss"]
    subject_id = payload["sub"]
    if not _nonempty_string(issuer) or not _nonempty_string(subject_id):
        raise ValueError("JWT issuer and subject must be nonempty strings")
    _validate_times(payload)
    scopes = _token_scopes(payload, mapping)
    mapped_claims = {"act", "scope", mapping.scp_claim}
    attrs = {key: value for key, value in identity.attrs.items() if key not in mapped_claims}
    subject = replace(identity, id=subject_id, attrs=attrs, issuer=issuer, scopes=scopes)
    if "act" not in payload:
        return subject
    return subject.delegate(_outer_actor(payload["act"], mapping, issuer), scopes)
