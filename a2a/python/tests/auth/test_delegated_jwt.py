"""Verified JWT scope and delegation are explicitly opt-in."""

from __future__ import annotations

import inspect
import time
from typing import Any

import jwt
import pytest
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from apcore_a2a import DelegatedClaims, JWTAuthenticator
from apcore_a2a.auth import AuthMiddleware

_KEY = "scope-enabled-test-verifier-32-bytes"
_ISSUER = "https://issuer.example"
_AUDIENCE = "audience.example"


def _auth() -> JWTAuthenticator:
    return JWTAuthenticator(
        _KEY,
        issuer=_ISSUER,
        audience=_AUDIENCE,
        delegated_claims=DelegatedClaims(scp_claim="scp", actor_roles_claim="roles"),
    )


def _token(**claims: Any) -> str:
    return jwt.encode(
        {"iss": _ISSUER, "sub": "subject", "aud": _AUDIENCE, "exp": time.time() + 120, **claims},
        _KEY,
        algorithm="HS256",
    )


async def _authenticate(token: str):
    identity = _auth().authenticate({"authorization": f"Bearer {token}"})
    return await identity if inspect.isawaitable(identity) else identity


@pytest.mark.asyncio
async def test_verified_scope_has_one_active_edge_and_uses_only_outer_actor_roles() -> None:
    actor = {"sub": "current", "roles": ["operator"], "act": {"sub": "past", "roles": ["admin"]}}
    first = await _authenticate(_token(scope="read write", scp=["write", "read"], roles=["owner"], act=actor))
    actor["act"] = {"sub": "different-past", "roles": ["superuser"]}
    refreshed = await _authenticate(_token(scope="write read", roles=["owner"], act=actor))
    assert first is not None and refreshed is not None
    assert first.delegation_depth == 1
    assert first.id == "current" and first.roles == ("operator",)
    assert first.root_subject.id == "subject" and first.root_subject.roles == ("owner",)
    assert first.scopes == ("read", "write")
    assert first.issuer == first.root_subject.issuer == _ISSUER
    assert first.authority_key() == refreshed.authority_key()
    assert first.owner_key() == refreshed.owner_key()
    explicit_empty = await _authenticate(_token(scp=[]))
    assert explicit_empty is not None and explicit_empty.scopes == ()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "claims",
    [
        {},
        {"scope": ""},
        {"scope": "read  write"},
        {"scope": "read\twrite"},
        {"scope": "read", "scp": ["write"]},
        {"scope": "read", "iss": "other"},
        {"scope": "read", "aud": "other"},
        {"scope": "read", "sub": None},
        {"scope": "read", "exp": 1},
        {"scope": "read", "iat": "1"},
        {"scope": "read", "nbf": 9e9},
        {"scope": "read", "act": {"sub": "actor", "act": None}},
        {"scope": "read", "act": {"sub": "actor", "iss": False}},
        {"scope": "read", "act": {"sub": "actor", "roles": ["operator", 1]}},
    ],
)
async def test_projection_rejects_invalid_verified_claims(claims: dict[str, Any]) -> None:
    assert await _authenticate(_token(**claims)) is None


def test_permissive_middleware_refuses_a_bad_credential_but_allows_no_credential() -> None:
    async def endpoint(_request):
        return JSONResponse({"ok": True})

    app = Starlette(
        routes=[Route("/", endpoint)],
        middleware=[Middleware(AuthMiddleware, authenticator=_auth(), require_auth=False)],
    )
    with TestClient(app) as client:
        assert client.get("/").status_code == 200
        assert client.get("/", headers={"Authorization": "Bearer invalid"}).status_code == 401
        assert client.get("/", headers={"Authorization": f"Bearer {_token(scope='read')}"}).status_code == 200
