"""A2A artifact link pilot through the actual factory and Core execution."""

from __future__ import annotations

import time
from dataclasses import replace
from typing import Annotated

import pytest
from apcore import APCore, Identity, Middleware, ModuleAnnotations
from pydantic import BaseModel, Field
from starlette.testclient import TestClient

from apcore_a2a import A2AServerFactory, ArtifactLinkPolicy, HostedArtifact

_SKILL = "artifact.download"
_ALLOWED_URL = "https://downloads.example.test/signed?id=token"


class _Result(BaseModel):
    artifact: Annotated[str, Field(json_schema_extra={"x-a2a-artifact": True})]
    sensitive: Annotated[str, Field(json_schema_extra={"x-a2a-artifact": True, "x-sensitive": True})]


class _Authenticator:
    def authenticate(self, headers: dict[str, str]) -> Identity | None:
        token = headers.get("authorization", "").removeprefix("Bearer ")
        return Identity(id=token, attrs={"authenticated": True}) if token else None

    def security_schemes(self) -> dict:
        return {"bearer": {"type": "http", "scheme": "bearer"}}


def _call(app: TestClient, principal: str = "alice") -> list[dict]:
    response = app.post(
        "/",
        headers={"Authorization": f"Bearer {principal}", "A2A-Version": "1.0"},
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "SendMessage",
            "params": {
                "message": {
                    "messageId": "request",
                    "role": "ROLE_USER",
                    "parts": [{"text": "{}"}],
                    "metadata": {"skillId": _SKILL},
                },
            },
        },
    ).json()
    assert "result" in response, response
    return response["result"]["task"]["artifacts"][0]["parts"]


@pytest.mark.parametrize("enabled", [False, True])
def test_link_uses_governed_final_output_and_current_identity(enabled: bool) -> None:
    core = APCore()
    observed: list[tuple[str, str]] = []

    @core.module(_SKILL, tags=["artifact"])
    def download() -> _Result:
        return _Result(artifact="initial", sensitive="private")

    class FinalOutput(Middleware):
        def after(self, module_id, inputs, output, context):
            context.identity.attrs["authenticated"] = False
            return {**output, "artifact": "final"}

    core.use(FinalOutput())

    async def resolve(artifact_id: str, identity: Identity) -> HostedArtifact | None:
        assert identity.attrs["authenticated"] is True
        observed.append((artifact_id, identity.id))
        if identity.id == "alice":
            return HostedArtifact(_ALLOWED_URL, "report.txt", "text/plain", 4, time.time() + 30)
        return None

    policy = ArtifactLinkPolicy(resolve, {"downloads.example.test"}) if enabled else None
    app, _ = A2AServerFactory().create(
        core.registry,
        core.executor,
        name="Test",
        description="d",
        version="1",
        url="https://agent.example.test",
        auth=_Authenticator(),
        artifact_links=policy,
    )

    with TestClient(app) as client:
        data = {"data": {"artifact": "final", "sensitive": "private"}}
        expected = [{"url": _ALLOWED_URL, "filename": "report.txt", "mediaType": "text/plain"}] if enabled else []
        assert _call(client) == [data, *expected]
        assert _call(client, "bob") == [data]
    assert observed == ([("final", "alice"), ("final", "bob")] if enabled else [])


@pytest.mark.parametrize(
    "override",
    [
        {"url": "file:///tmp/report.txt"},
        {"url": "https://downloads.example.test.evil.test/report"},
        {"url": "https://user@downloads.example.test/report"},
        {"expires_at": 0},
        {"size_bytes": 9},
    ],
)
def test_unsafe_or_expired_download_is_omitted(override: dict) -> None:
    core = APCore()

    @core.module(_SKILL, tags=["artifact"])
    def download() -> _Result:
        return _Result(artifact="download_1", sensitive="private")

    async def resolve(opaque_id: str, identity: Identity) -> HostedArtifact | None:
        assert opaque_id == "download_1"
        metadata = HostedArtifact(_ALLOWED_URL, "report.txt", "text/plain", 4, time.time() + 30)
        return replace(metadata, **override)

    app, _ = A2AServerFactory().create(
        core.registry,
        core.executor,
        name="Test",
        description="d",
        version="1",
        url="https://agent.example.test",
        auth=_Authenticator(),
        artifact_links=ArtifactLinkPolicy(resolve, {"downloads.example.test"}, max_bytes=8),
    )
    with TestClient(app) as client:
        assert _call(client) == [{"data": {"artifact": "download_1", "sensitive": "private"}}]


def test_recovered_output_does_not_publish_a_link() -> None:
    core = APCore()
    observed: list[str] = []

    @core.module(_SKILL, tags=["artifact"])
    def download() -> _Result:
        raise ValueError("no result")

    class Recover(Middleware):
        def on_error(self, module_id, inputs, error, context):
            return {"artifact": "recovered"}

    core.use(Recover())

    async def resolve(artifact_id: str, identity: Identity) -> HostedArtifact | None:
        observed.append(artifact_id)
        return HostedArtifact(_ALLOWED_URL, "report.txt", "text/plain", 4, time.time() + 30)

    app, _ = A2AServerFactory().create(
        core.registry,
        core.executor,
        name="Test",
        description="d",
        version="1",
        url="https://agent.example.test",
        auth=_Authenticator(),
        artifact_links=ArtifactLinkPolicy(resolve, {"downloads.example.test"}),
    )
    with TestClient(app) as client:
        assert _call(client) == [{"data": {"artifact": "recovered"}}]
    assert observed == []


def test_native_stream_chunks_remain_data_parts_only() -> None:
    core = APCore()

    class Stream:
        description = "Stream short data fragments"
        tags = ["artifact"]
        input_schema = {"type": "object"}
        output_schema = _Result
        annotations = ModuleAnnotations(streaming=True)

        async def execute(self, inputs, context):
            raise AssertionError("The pilot must retain native streaming")

        async def stream(self, inputs, context):
            yield {"artifact": "stream_one", "sensitive": "private"}

    core.register(_SKILL, Stream())

    async def resolve(artifact_id: str, identity: Identity) -> HostedArtifact | None:
        pytest.fail("The pilot must never request a URL for a stream chunk")

    app, _ = A2AServerFactory().create(
        core.registry,
        core.executor,
        name="Test",
        description="d",
        version="1",
        url="https://agent.example.test",
        auth=_Authenticator(),
        artifact_links=ArtifactLinkPolicy(resolve, {"downloads.example.test"}),
    )
    with TestClient(app) as client:
        assert _call(client) == [{"data": {"artifact": "stream_one", "sensitive": "private"}}]
