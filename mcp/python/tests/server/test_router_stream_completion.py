"""Real Executor acceptance for the MCP stream result boundary."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import closing
from typing import Any

import anyio
import pytest
from apcore import REDACTED_VALUE, APCore, Config, Context, Executor, ModuleAnnotations, ModuleExecuteError, Registry
from apcore.builtin_steps import BuiltinOutputValidation
from apcore.middleware import Middleware
from mcp import ClientSession
from pydantic import BaseModel

from apcore_mcp import APCoreMCP
from apcore_mcp.server.factory import MCPServerFactory
from apcore_mcp.server.router import ExecutionRouter
from apcore_mcp.server.transport import TransportManager

_HAS_COMPLETION = callable(getattr(Executor, "stream_with_completion", None))


class _Inputs(BaseModel):
    pass


class _Output(BaseModel):
    value: int
    nested: dict[str, Any]
    parts: list[int]
    secret: str


class _StreamingTool:
    annotations = ModuleAnnotations(streaming=True)
    description = "Return two partial objects"
    input_schema = _Inputs
    output_schema = _Output

    def __init__(self, *, invalid: bool = False) -> None:
        self.invalid = invalid
        self.stream_calls = 0
        self.execute_calls = 0

    async def execute(self, inputs: dict[str, Any], context: Context) -> dict[str, Any]:
        self.execute_calls += 1
        return {"value": 100, "nested": {}, "parts": [], "secret": "hidden"}

    async def stream(self, inputs: dict[str, Any], context: Context) -> AsyncIterator[dict[str, Any]]:
        self.stream_calls += 1
        yield {"nested": {"level": {"left": True}}, "parts": [1], "secret": "hidden"}
        yield {"nested": {"level": {"right": True}}, "parts": [2], "value": "invalid" if self.invalid else 2}


def _setup(
    tool: _StreamingTool, executor_type: type[Executor] = Executor
) -> tuple[Registry, Executor, ExecutionRouter]:
    registry = Registry()
    registry.register("test.stream", tool)
    executor = executor_type(registry, config=Config({"stream": {"max_merge_depth": 1}}))
    router = ExecutionRouter(
        executor, output_schema_map={"test.stream": {"properties": {"secret": {"x-sensitive": True}}}}
    )
    return registry, executor, router


@pytest.mark.parametrize(("send_progress", "annotated"), [(True, True), (False, True), (False, False)])
@pytest.mark.skipif(not _HAS_COMPLETION, reason="run with the A2 wheel for the completion path")
async def test_real_mcp_final_result_uses_core_snapshot(send_progress: bool, annotated: bool) -> None:
    tool = _StreamingTool()
    if not annotated:
        tool.annotations = ModuleAnnotations()
    registry, _, router = _setup(tool)
    factory = MCPServerFactory()
    server = factory.create_server()
    factory.register_handlers(server, factory.build_tools(registry), router)
    init = factory.build_init_options(server, "test", "1")
    send_client, read_server = anyio.create_memory_object_stream(10)
    send_server, read_client = anyio.create_memory_object_stream(10)
    messages: list[dict[str, Any]] = []

    async def progress(_count: float, _total: float | None, text: str | None) -> None:
        assert text is not None
        messages.append(json.loads(text))

    with anyio.fail_after(5):
        async with anyio.create_task_group() as group:
            group.start_soon(TransportManager()._run_scoped, server, read_server, send_server, init, "test")
            async with ClientSession(read_client, send_client) as session:
                await session.initialize()
                result = await session.call_tool(
                    "test.stream", {}, progress_callback=progress if send_progress else None
                )
            group.cancel_scope.cancel()

    assert not result.isError
    assert json.loads(result.content[0].text) == {
        "value": 2,
        "nested": {"level": {"right": True}},
        "parts": [2],
        "secret": REDACTED_VALUE,
    }
    assert len(messages) == (2 if send_progress else 0)
    if send_progress:
        assert messages[0]["secret"] == REDACTED_VALUE
    assert (tool.stream_calls, tool.execute_calls) == (1, 0)


@pytest.mark.parametrize("ignored", [False, True])
@pytest.mark.skipif(not _HAS_COMPLETION, reason="run with the A2 wheel for the completion path")
async def test_late_validation_failure_is_a_tool_error_even_if_ignored(ignored: bool) -> None:
    tool = _StreamingTool(invalid=True)
    _, executor, router = _setup(tool)
    if ignored:
        validation = BuiltinOutputValidation()
        validation.ignore_errors = True
        executor.current_strategy.configure_step("output_validation", validation)

    content, is_error, _ = await router.handle_call("test.stream", {})
    assert is_error
    assert "validation" in content[0]["text"].lower()
    assert "hidden" not in content[0]["text"]
    assert (tool.stream_calls, tool.execute_calls) == (1, 0)


@pytest.mark.skipif(not _HAS_COMPLETION, reason="run with the A2 wheel for the completion path")
async def test_failed_after_hook_prevents_mcp_success() -> None:
    class FailedAfter(Middleware):
        def after(self, module_id: str, inputs: dict[str, Any], output: dict[str, Any], context: Context) -> None:
            raise ModuleExecuteError(module_id, "private diagnostic")

    tool = _StreamingTool()
    _, executor, router = _setup(tool)
    executor.use(FailedAfter())
    content, is_error, _ = await router.handle_call("test.stream", {})
    assert is_error
    assert "private diagnostic" not in content[0]["text"]
    assert (tool.stream_calls, tool.execute_calls) == (1, 0)


async def test_old_core_selects_atomic_call_before_streaming() -> None:
    class LegacyExecutor(Executor):
        stream_with_completion = None  # type: ignore[assignment]

    tool = _StreamingTool()
    _, _, router = _setup(tool, LegacyExecutor)

    async def send_notification(_notification: dict[str, Any]) -> None:
        pytest.fail("ordinary execution must not emit a chunk notification")

    content, is_error, _ = await router.handle_call(
        "test.stream", {}, {"progress_token": 0, "send_notification": send_notification}
    )
    assert not is_error
    assert json.loads(content[0]["text"])["value"] == 100
    assert (tool.stream_calls, tool.execute_calls) == (0, 1)


async def test_core_facade_routes_streams_by_completion_capability() -> None:
    tool = _StreamingTool()
    tool.annotations = ModuleAnnotations()
    registry = Registry()
    registry.register("test.stream", tool)
    with closing(APCore(registry=registry)) as client:
        router = ExecutionRouter(client)
        if _HAS_COMPLETION:
            content, failed, _ = await router.handle_call("test.stream", {})
            assert not failed
            assert json.loads(content[0]["text"])["value"] == 2
            assert (tool.stream_calls, tool.execute_calls) == (1, 0)
        else:
            async def unexpected_progress(notification: dict[str, Any]) -> None:
                pytest.fail("ordinary execution cannot publish native chunks")

            content, failed, _ = await router.handle_call(
                "test.stream", {}, {"progress_token": 0, "send_notification": unexpected_progress}
            )
            assert not failed
            assert json.loads(content[0]["text"])["value"] == 100
            assert (tool.stream_calls, tool.execute_calls) == (0, 1)


@pytest.mark.parametrize(("progress", "trace"), [(False, False), (True, False), (False, True)])
async def test_registered_version_controls_output_projection(progress: bool, trace: bool) -> None:
    class Versioned:
        description = "Return a synthetic field with version-dependent visibility"
        input_schema = {"type": "object"}

        def __init__(self, sensitive: bool) -> None:
            self.output_schema = {
                "type": "object",
                "properties": {"label": {"type": "string", "x-sensitive": sensitive}},
            }

        async def execute(self, inputs: dict[str, Any], context: Context) -> dict[str, Any]:
            return {"label": "synthetic"}

        async def stream(self, inputs: dict[str, Any], context: Context) -> AsyncIterator[dict[str, Any]]:
            yield {"label": "synthetic"}

    registry = Registry()
    registry.register("fixture.versioned", Versioned(True), version="1.0.0")
    registry.register("fixture.versioned", Versioned(False), version="2.0.0")
    if trace:
        class UnaryExecutor(Executor):
            stream_with_completion = None  # type: ignore[assignment]

        router = ExecutionRouter(UnaryExecutor(registry), redact_output=True, trace=True)
    else:
        _, router, _, _, _ = APCoreMCP(registry, redact_output=True)._build_server_components()
    messages: list[dict[str, Any]] = []

    async def notify(notification: dict[str, Any]) -> None:
        messages.append(json.loads(notification["params"]["message"]))

    extra: dict[str, Any] = {"_meta": {"apcore": {"version": "^1.0.0"}}}
    if progress:
        extra.update(progress_token=0, send_notification=notify)
    content, failed, _ = await router.handle_call("fixture.versioned", {}, extra)
    assert not failed
    assert json.loads(content[0]["text"]) == {"label": REDACTED_VALUE}
    assert messages == ([{"label": REDACTED_VALUE}] if progress and _HAS_COMPLETION else [])
    if trace:
        assert json.loads(content[-1]["text"])["strategy_name"] == "standard"
