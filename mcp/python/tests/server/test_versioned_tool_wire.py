"""MCP discovery and requested version selection through a real client session."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import anyio
import pytest
from apcore import Executor, Registry
from mcp import ClientSession, types

from apcore_mcp import APCoreMCP
from apcore_mcp.server.router import ExecutionRouter
from apcore_mcp.server.transport import TransportManager

_MODULE = "fixture.versioned"


class Report:
    description = "Return a synthetic count"
    input_schema = {"type": "object"}

    def __init__(self, field: str, value: int) -> None:
        self.field = field
        self.value = value
        self.calls = 0
        self.output_schema = {
            "type": "object",
            "properties": {field: {"type": "integer"}},
            "required": [field],
        }

    async def execute(self, inputs, context) -> dict[str, int]:
        self.calls += 1
        return {self.field: self.value}


@asynccontextmanager
async def connected_client(registry: Registry, **options) -> AsyncIterator[ClientSession]:
    server, _, _, init, _ = APCoreMCP(registry, **options)._build_server_components()
    send_client, read_server = anyio.create_memory_object_stream(10)
    send_server, read_client = anyio.create_memory_object_stream(10)
    with anyio.fail_after(5):
        async with anyio.create_task_group() as group:
            group.start_soon(TransportManager()._run_scoped, server, read_server, send_server, init, "test")
            async with ClientSession(read_client, send_client) as session:
                await session.initialize()
                yield session
            group.cancel_scope.cancel()


@pytest.mark.parametrize("redact_output", [True, False])
async def test_version_with_different_public_output_is_rejected_before_execution(redact_output: bool) -> None:
    registry = Registry()
    older = Report("older_count", 1)
    current = Report("count", 2)
    registry.register(_MODULE, older, version="1.0.0")
    registry.register(_MODULE, current, version="2.0.0")

    async with connected_client(registry, redact_output=redact_output) as session:
        tools = await session.list_tools()
        assert tools.tools[0].outputSchema["required"] == ["count"]
        hinted = await session.call_tool(_MODULE, {}, meta={"apcore": {"version": "^1.0"}})
        assert older.calls == 0
        assert hinted.isError
        assert "does not match the advertised tool contract" in hinted.content[0].text
        default = await session.call_tool(_MODULE, {})

    assert not default.isError
    assert default.structuredContent == {"count": 2}
    assert current.calls == 1


@pytest.mark.parametrize(("legacy", "validate_inputs"), [(True, False), (False, False), (False, True)])
async def test_compatible_version_hint_uses_requested_version(legacy: bool, validate_inputs: bool, monkeypatch) -> None:
    registry = Registry()
    older = Report("count", 1)
    current = Report("count", 2)
    registry.register(_MODULE, older, version="1.0.0")
    registry.register(_MODULE, current, version="2.0.0")
    if legacy:
        monkeypatch.setattr(types, "LATEST_PROTOCOL_VERSION", "2025-03-26")

    async with connected_client(registry, redact_output=False, validate_inputs=validate_inputs) as session:
        tools = await session.list_tools()
        assert (tools.tools[0].outputSchema is None) is legacy
        result = await session.call_tool(_MODULE, {}, meta={"apcore": {"version": "^1.0"}})
        default = await session.call_tool(_MODULE, {}, meta={"apcore": {"version": "^2.0"}})
    assert not default.isError
    assert json.loads(default.content[0].text) == {"count": 2}
    assert current.calls == 1
    if registry.get_definition(_MODULE, "^1.0").version == "1.0.0":
        assert not result.isError
        assert json.loads(result.content[0].text) == {"count": 1}
        assert result.structuredContent == (None if legacy else {"count": 1})
        assert older.calls == 1
    else:
        assert result.isError
        assert "cannot confirm the requested tool registration" in result.content[0].text
        assert older.calls == 0


async def test_compatible_client_input_does_not_hide_a_different_advertised_input_contract() -> None:
    registry = Registry()
    older = Report("count", 1)
    older.input_schema = {"type": "object", "properties": {"scale": {"type": "integer"}}}
    registry.register(_MODULE, older, version="1.0.0")
    registry.register(_MODULE, Report("count", 2), version="2.0.0")

    async with connected_client(registry) as session:
        hinted = await session.call_tool(_MODULE, {}, meta={"apcore": {"version": "^1.0"}})

    assert hinted.isError
    assert "does not match the advertised tool contract" in hinted.content[0].text
    assert older.calls == 0


async def test_configured_default_uses_its_advertised_contract() -> None:
    registry = Registry()
    older = Report("older_count", 1)
    current = Report("count", 2)
    registry.register(_MODULE, older, version="1.0.0")
    registry.register(_MODULE, current, version="2.0.0", metadata={"version_hint": "^1.0"})

    async with connected_client(registry) as session:
        tools = await session.list_tools()
        default = await session.call_tool(_MODULE, {})
    if registry.get_definition(_MODULE, "^1.0").version == "1.0.0":
        assert tools.tools[0].outputSchema["required"] == ["older_count"]
        assert not default.isError
        assert default.structuredContent == {"older_count": 1}
        assert (older.calls, current.calls) == (1, 0)
    else:
        assert tools.tools[0].outputSchema["required"] == ["count"]
        assert default.isError
        assert (older.calls, current.calls) == (0, 0)


async def test_background_hint_reports_unavailable_before_submission() -> None:
    registry = Registry()
    report = Report("count", 2)
    registry.register(_MODULE, report, version="2.0.0", metadata={"async": True})

    async with connected_client(registry, async_tasks=True) as session:
        hinted = await session.call_tool(_MODULE, {}, meta={"apcore": {"version": "^2.0"}})
        assert hinted.isError
        assert "Version hints are unavailable for background tool execution" in hinted.content[0].text
        assert report.calls == 0
        ordinary = await session.call_tool(_MODULE, {})

    assert not ordinary.isError
    assert json.loads(ordinary.content[0].text)["task_id"]


async def test_direct_router_keeps_version_hint_without_a_published_contract() -> None:
    registry = Registry()
    older = Report("older_count", 1)
    current = Report("count", 2)
    registry.register(_MODULE, older, version="1.0.0")
    registry.register(_MODULE, current, version="2.0.0")

    router = ExecutionRouter(Executor(registry))
    output, is_error, _ = await router.handle_call(_MODULE, {}, extra={"version_hint": "^1.0"})

    assert not is_error
    assert json.loads(output[0]["text"]) == {"older_count": 1}
    assert (older.calls, current.calls) == (1, 0)
