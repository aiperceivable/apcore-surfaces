"""Verify Core callbacks through MCP, with legacy versions kept importable."""

from typing import Any

import anyio
import pytest
from apcore import Context, Executor, Registry
from mcp import ClientSession, types
from pydantic import BaseModel

from apcore_mcp.server.async_task_bridge import AsyncTaskBridge
from apcore_mcp.server.factory import MCPServerFactory
from apcore_mcp.server.router import ExecutionRouter
from apcore_mcp.server.transport import TransportManager

pytestmark = pytest.mark.skipif(
    not hasattr(Context, "with_progress_reporter") or not hasattr(Context, "with_elicitation_handler"),
    reason="Installed Core has no native interaction callbacks",
)


class _Inputs(BaseModel):
    pass


@pytest.mark.asyncio
@pytest.mark.parametrize("supports_elicitation", [True, False])
async def test_core_progress_and_elicitation_on_mcp_wire(supports_elicitation: bool) -> None:
    schema = {"type": "object", "properties": {"confirmed": {"type": "boolean"}}}
    observed: list[tuple[float, float | None, str | None]] = []

    class Tool:
        description = "Report progress and request optional confirmation"
        input_schema = _Inputs
        output_schema = {"type": "object"}

        async def execute(self, inputs: dict[str, Any], context: Context) -> dict[str, Any]:
            await context.report_progress(1, 2, "Preparing")
            answer = await context.elicit("Confirm?", schema)
            confirmed = answer is not None and answer.action == "accept" and answer.content == {"confirmed": True}
            return {"confirmed": confirmed}

    async def elicit(context: Any, request: types.ElicitRequestParams) -> types.ElicitResult:
        assert isinstance(request, types.ElicitRequestFormParams)
        assert request.message == "Confirm?"
        assert request.requestedSchema == schema
        return types.ElicitResult(action="accept", content={"confirmed": True})

    async def progress(count: float, total: float | None, message: str | None) -> None:
        observed.append((count, total, message))

    registry = Registry()
    registry.register("test.interaction", Tool())
    router = ExecutionRouter(Executor(registry))
    factory = MCPServerFactory()
    server = factory.create_server()
    factory.register_handlers(server, factory.build_tools(registry), router)
    init = factory.build_init_options(server, "core-interaction", "1")
    send_client, read_server = anyio.create_memory_object_stream(10)
    send_server, read_client = anyio.create_memory_object_stream(10)

    with anyio.fail_after(5):
        async with anyio.create_task_group() as group:
            group.start_soon(TransportManager()._run_scoped, server, read_server, send_server, init, "test")
            callback = elicit if supports_elicitation else None
            async with ClientSession(read_client, send_client, elicitation_callback=callback) as session:
                await session.initialize()
                result = await session.call_tool("test.interaction", {}, progress_callback=progress)
            group.cancel_scope.cancel()

    assert result.isError is False
    assert result.structuredContent == {"confirmed": supports_elicitation}
    assert observed == [(1, 2, "Preparing")]


@pytest.mark.asyncio
async def test_async_bridge_attaches_core_and_legacy_progress() -> None:
    class TaskManager:
        async def submit(self, module_id: str, arguments: dict[str, Any], context: Context) -> str:
            await context.report_progress(1, 2, "core")
            await context.data["_mcp_progress"](2, 2, "legacy")
            return "task-id"

    received: list[dict[str, Any]] = []

    async def send(notification: dict[str, Any]) -> None:
        received.append(notification)

    bridge = AsyncTaskBridge(TaskManager())  # type: ignore[arg-type]
    submitted = await bridge.submit("test.action", {}, Context.create(), progress_token="token", send_notification=send)
    assert submitted == {"task_id": "task-id", "status": "pending"}
    assert [(notice["params"]["progress"], notice["params"]["message"]) for notice in received] == [
        (1, "core"),
        (2, "legacy"),
    ]
