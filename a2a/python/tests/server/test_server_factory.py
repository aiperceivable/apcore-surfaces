"""Tests for A2AServerFactory."""

import asyncio
import contextlib
import json
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from a2a.server.context import ServerCallContext
from a2a.server.events.event_queue_v2 import EventQueueSource
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.types import (
    AgentCard,
    CancelTaskRequest,
    GetTaskRequest,
    SendMessageRequest,
    Task,
    TaskState,
    TaskStatusUpdateEvent,
)
from a2a.utils.errors import TaskNotCancelableError
from apcore import Executor, Registry
from pydantic import BaseModel
from starlette.applications import Starlette
from starlette.testclient import TestClient

from apcore_a2a.adapters.errors import ErrorMapper
from apcore_a2a.adapters.parts import PartConverter
from apcore_a2a.adapters.schema import SchemaConverter
from apcore_a2a.server.executor import ApCoreAgentExecutor
from apcore_a2a.server.factory import (
    A2AServerFactory,
    A2ATaskStore,
    _ObservedTaskStore,
    _ObservedVersionedTaskStore,
    _TerminalAwareRequestHandler,
)


@pytest.fixture
def mock_registry(simple_descriptor):
    reg = MagicMock()
    reg.list.return_value = ["image.resize"]
    reg.get_definition.return_value = simple_descriptor
    return reg


@pytest.fixture
def mock_executor(mock_registry):
    executor = MagicMock()
    executor.call_async = AsyncMock(return_value={"result": "ok"})
    executor.registry = mock_registry
    # No ACL configured — the common single-tenant case. Spelled out because a
    # bare MagicMock answers `hasattr(executor, "acl")` with a mock that also
    # answers `check`/`check_access`, so `card_visibility.executor_acl` would
    # take it for a real ACL and (correctly) fail closed on its unreadable
    # verdict, emptying every card in this file.
    executor.acl = None
    executor._acl = None
    return executor


def test_create_returns_starlette_and_agent_card(mock_registry, mock_executor):
    factory = A2AServerFactory()
    app, card = factory.create(
        mock_registry,
        mock_executor,
        name="Test Agent",
        description="desc",
        version="1.0.0",
        url="http://localhost:8000",
    )
    assert isinstance(app, Starlette)
    assert isinstance(card, AgentCard)
    assert card.name == "Test Agent"


def test_app_has_well_known_route(mock_registry, mock_executor):
    factory = A2AServerFactory()
    app, _ = factory.create(
        mock_registry,
        mock_executor,
        name="Agent",
        description="d",
        version="1",
        url="http://x",
    )
    client = TestClient(app)
    # SDK serves both old and new agent card paths
    resp = client.get("/.well-known/agent.json")
    assert resp.status_code == 200


def test_app_has_health_route(mock_registry, mock_executor):
    factory = A2AServerFactory()
    app, _ = factory.create(
        mock_registry,
        mock_executor,
        name="Agent",
        description="d",
        version="1",
        url="http://x",
    )
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200


def test_app_has_jsonrpc_route(mock_registry, mock_executor):
    factory = A2AServerFactory()
    app, _ = factory.create(
        mock_registry,
        mock_executor,
        name="Agent",
        description="d",
        version="1",
        url="http://x",
    )
    client = TestClient(app)
    # `ListTasks` is the A2A 1.0 name, and needs the version header: a request
    # without it is treated as v0.3 (spec 3.6.2), which has no listing method.
    # Asserting the result, not just HTTP 200 — a JSON-RPC error is also a 200,
    # so the old assertion passed even while the method was unroutable.
    body = json.dumps({"jsonrpc": "2.0", "id": "1", "method": "ListTasks", "params": {}})
    response = client.post(
        "/",
        content=body,
        headers={"Content-Type": "application/json", "A2A-Version": "1.0"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert "error" not in payload, payload
    assert isinstance(payload["result"]["tasks"], list)


async def test_stream_timeout_is_queryable_through_the_actual_a2a_routes():
    class Input(BaseModel):
        pass

    class Output(BaseModel):
        value: str

    class Stall:
        description = "Emit a partial artifact, then stall"
        input_schema = Input
        output_schema = Output

        async def execute(self, inputs, context):
            raise AssertionError("the native stream must run")

        async def stream(self, inputs, context):
            yield {"value": "partial"}
            await asyncio.Future()

    registry = Registry()
    registry.register("test.stall", Stall())
    app, _ = A2AServerFactory().create(
        registry, Executor(registry), name="agent", description="d", version="1",
        url="http://test", execution_timeout=0.1,
    )
    request = {
        "jsonrpc": "2.0", "id": 1, "method": "SendStreamingMessage",
        "params": {"message": {
            "messageId": "stall", "role": "ROLE_USER", "parts": [{"data": {}}],
            "metadata": {"skillId": "test.stall"},
        }},
    }
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers={"A2A-Version": "1.0"},
    ) as client:
        response = await asyncio.wait_for(client.post("/", json=request), timeout=2)
        assert response.status_code == 200
        frames = [json.loads(line[5:])["result"] for line in response.text.splitlines() if line.startswith("data:")]
        artifacts = [event["artifactUpdate"] for event in frames if "artifactUpdate" in event]
        assert len(artifacts) == 1 and not artifacts[0].get("lastChunk", False)
        statuses = [event["statusUpdate"] for event in frames if "statusUpdate" in event]
        assert [update["status"]["state"] for update in statuses] == ["TASK_STATE_FAILED"]
        terminal = statuses[0]
        assert terminal["status"]["message"]["parts"][0]["text"] == "Execution timed out"
        result = await client.post("/", json={
            "jsonrpc": "2.0", "id": 2, "method": "GetTask", "params": {"id": terminal["taskId"]},
        })
    assert result.json()["result"]["status"] == terminal["status"]


@pytest.mark.parametrize("versioned_store", [False, True])
async def test_get_task_reports_the_terminal_before_a_slow_sse_reader_drains(versioned_store, monkeypatch, caplog):
    first_task, allow_send, stopped = asyncio.Event(), asyncio.Event(), asyncio.Event()
    terminal_offered = asyncio.Event()
    uses_evictable_sink = False
    tap = EventQueueSource.tap
    enqueue = EventQueueSource.enqueue_event

    async def observe_terminal(source, event):
        if isinstance(event, TaskStatusUpdateEvent) and event.status.state == TaskState.TASK_STATE_FAILED:
            terminal_offered.set()
        await enqueue(source, event)

    async def small_subscriber_buffer(source, *args, **kwargs):
        nonlocal uses_evictable_sink
        if kwargs.get("evict_on_full"):
            uses_evictable_sink = True
            kwargs["max_queue_size"] = 2
        return await tap(source, *args, **kwargs)

    monkeypatch.setattr(EventQueueSource, "tap", small_subscriber_buffer)
    monkeypatch.setattr(EventQueueSource, "enqueue_event", observe_terminal)
    task_id = ""

    class FastProducer:
        description = "Fill the artifact queue while a client pauses its SSE read"
        input_schema = {"type": "object"}
        output_schema = {"type": "object"}

        async def execute(self, inputs, context):
            raise AssertionError("the native stream must run")

        async def stream(self, inputs, context):
            try:
                await first_task.wait()
                for index in range(10_000):
                    yield {"index": index}
            finally:
                stopped.set()

    registry = Registry()
    registry.register("test.backpressure", FastProducer())
    store = None
    if versioned_store:
        cluster = pytest.importorskip("a2a.server.cluster.task_store")
        store = cluster.LegacyTaskStoreAdapter(A2ATaskStore())
    app, _ = A2AServerFactory().create(
        registry,
        Executor(registry),
        name="agent",
        description="description",
        version="1",
        url="http://test",
        task_store=store,
        execution_timeout=0.25,
    )

    async def hold_first_sse_event(scope, receive, send):
        async def slow_send(event):
            nonlocal task_id
            body = event.get("body", b"")
            if not task_id and event["type"] == "http.response.body" and body.startswith(b"data:"):
                task_id = json.loads(body.splitlines()[0][5:])["result"]["task"]["id"]
                first_task.set()
                await allow_send.wait()
            await send(event)

        await app(scope, receive, slow_send)

    headers = {"A2A-Version": "1.0"}
    async with (
        httpx.AsyncClient(transport=httpx.ASGITransport(app=hold_first_sse_event), base_url="http://test") as stream,
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as status,
    ):
        streaming = asyncio.create_task(
            stream.post(
                "/",
                headers=headers,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "SendStreamingMessage",
                    "params": {
                        "message": {
                            "messageId": "blocked-reader",
                            "role": "ROLE_USER",
                            "parts": [{"data": {}}],
                            "metadata": {"skillId": "test.backpressure"},
                        }
                    },
                },
            )
        )
        try:
            await asyncio.wait_for(first_task.wait(), 2)
            await asyncio.wait_for(stopped.wait(), 2)
            await asyncio.wait_for(terminal_offered.wait(), 2)
            query = {"jsonrpc": "2.0", "id": 2, "method": "GetTask", "params": {"id": task_id}}
            result = await status.post("/", headers=headers, json=query)
            assert result.json()["result"]["status"]["state"] == "TASK_STATE_FAILED"
            assert not streaming.done()
        finally:
            allow_send.set()
            response = await asyncio.wait_for(streaming, 3)
        frames = [json.loads(line[5:])["result"] for line in response.text.splitlines() if line.startswith("data:")]
        statuses = [event["statusUpdate"]["status"] for event in frames if "statusUpdate" in event]
        if uses_evictable_sink:
            assert "Evicting event queue sink" in caplog.text
        assert [item["state"] for item in statuses] == ["TASK_STATE_FAILED"]
        persisted = await status.post("/", headers=headers, json=query)
        assert persisted.json()["result"]["status"] == statuses[0]


async def test_closed_subscriber_does_not_report_a_working_task_as_a_terminal(monkeypatch):
    context = ServerCallContext()
    submitted = Task(id="task", context_id="conversation", status={"state": TaskState.TASK_STATE_SUBMITTED})

    async def closed_subscriber(self, params, call_context):
        assert call_context is context
        yield submitted

    monkeypatch.setattr(DefaultRequestHandler, "on_message_send_stream", closed_subscriber)
    store = A2ATaskStore()
    working = Task(id=submitted.id, context_id=submitted.context_id, status={"state": TaskState.TASK_STATE_WORKING})
    await store.save(working, context)
    handler = _TerminalAwareRequestHandler(
        agent_executor=ApCoreAgentExecutor(MagicMock(), MagicMock(), MagicMock()),
        task_store=store,
        agent_card=AgentCard(name="test", capabilities={"streaming": True}),
    )

    result = [event async for event in handler.on_message_send_stream(SendMessageRequest(), context)]

    assert result == [submitted]


async def test_disconnected_stream_persists_the_terminal_and_retires_the_projection():
    class Producer:
        async def stream(self, module_id, inputs, context):
            yield {"value": "partial"}
            await asyncio.Future()

    class ObservedStore(A2ATaskStore):
        def __init__(self):
            super().__init__()
            self.terminal_saved = asyncio.Event()

        async def save(self, task, context):
            await super().save(task, context)
            if task.status.state == TaskState.TASK_STATE_FAILED:
                self.terminal_saved.set()

    store = ObservedStore()
    agent = ApCoreAgentExecutor(
        Producer(),
        PartConverter(SchemaConverter()),
        ErrorMapper(),
        execution_timeout=0.05,
        track_terminal_status=True,
    )
    handler = _TerminalAwareRequestHandler(
        agent_executor=agent,
        task_store=_ObservedTaskStore(store, agent),
        agent_card=AgentCard(name="test", capabilities={"streaming": True}),
    )
    context = ServerCallContext()
    request = SendMessageRequest(
        message={
            "message_id": "disconnect",
            "role": "ROLE_USER",
            "parts": [{"text": "test"}],
            "metadata": {"skillId": "test.disconnect"},
        },
    )
    stream = handler.on_message_send_stream(request, context)
    try:
        submitted = await asyncio.wait_for(anext(stream), 1)
        assert isinstance(submitted, Task)
        assert submitted.status.state == TaskState.TASK_STATE_SUBMITTED
    finally:
        await stream.aclose()
    await asyncio.wait_for(store.terminal_saved.wait(), 2)
    persisted = await store.get(submitted.id, context)
    assert persisted.status.state == TaskState.TASK_STATE_FAILED
    assert agent.project_terminal_status(submitted, context) is submitted


@pytest.mark.parametrize("versioned_store", [False, True])
async def test_failed_terminal_write_does_not_block_a_recovered_task(versioned_store):
    class Producer:
        calls = 0

        async def call_async(self, module_id, inputs, context):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("synthetic execution failure")
            return {"value": "recovered"}

    class RecoveringStore(A2ATaskStore):
        def __init__(self):
            super().__init__()
            self.first_write_started = asyncio.Event()
            self.allow_first_write = asyncio.Event()
            self.backup_write_started = asyncio.Event()
            self.allow_backup_write = asyncio.Event()
            self.failed_writer = None
            self.failed_writes = 0
            self.completed_writes = 0

        async def save(self, task, context):
            if task.status.state == TaskState.TASK_STATE_FAILED:
                self.failed_writes += 1
                if self.failed_writes == 1:
                    self.failed_writer = asyncio.current_task()
                    self.first_write_started.set()
                    await self.allow_first_write.wait()
                else:
                    self.backup_write_started.set()
                    await self.allow_backup_write.wait()
                raise OSError("synthetic terminal write failure")
            await super().save(task, context)
            if task.status.state == TaskState.TASK_STATE_COMPLETED:
                self.completed_writes += 1

    store = RecoveringStore()
    producer = Producer()
    agent = ApCoreAgentExecutor(
        producer, PartConverter(SchemaConverter()), ErrorMapper(), track_terminal_status=True,
    )
    if versioned_store:
        cluster = pytest.importorskip("a2a.server.cluster.task_store")
        observed_store = _ObservedVersionedTaskStore(cluster.LegacyTaskStoreAdapter(store), agent)
    else:
        observed_store = _ObservedTaskStore(store, agent)
    handler = _TerminalAwareRequestHandler(
        agent_executor=agent,
        task_store=observed_store,
        agent_card=AgentCard(name="test", capabilities={"streaming": True}),
    )
    context = ServerCallContext()
    request = SendMessageRequest(
        message={
            "message_id": "terminal-write-fails",
            "role": "ROLE_USER",
            "parts": [{"text": "test"}],
            "metadata": {"skillId": "test.recovering-store"},
        },
    )
    async with asyncio.timeout(2), contextlib.aclosing(handler.on_message_send_stream(request, context)) as stream:
        submitted = await anext(stream)
        assert isinstance(submitted, Task)
        query = GetTaskRequest(id=submitted.id)
        async def drain_stream():
            async for _ in stream:
                pass

        subscriber = asyncio.create_task(drain_stream())
        backup_write = asyncio.create_task(store.backup_write_started.wait())
        try:
            try:
                await store.first_write_started.wait()
                assert (await handler.on_get_task(query, context)).status.state == TaskState.TASK_STATE_FAILED
                assert (await store.get(submitted.id, context)).status.state == TaskState.TASK_STATE_SUBMITTED
                store.allow_first_write.set()
                done, _ = await asyncio.wait(
                    (store.failed_writer, backup_write, subscriber), return_when=asyncio.FIRST_COMPLETED,
                )
                if backup_write in done:
                    assert (await handler.on_get_task(query, context)).status.state == TaskState.TASK_STATE_FAILED
            finally:
                store.allow_first_write.set()
                store.allow_backup_write.set()
            with pytest.raises(OSError, match="synthetic terminal write failure"):
                await subscriber
            await asyncio.gather(store.failed_writer, return_exceptions=True)
        finally:
            backup_write.cancel()
            subscriber.cancel()
            await asyncio.gather(backup_write, subscriber, return_exceptions=True)
        assert (await handler.on_get_task(query, context)).status.state == TaskState.TASK_STATE_SUBMITTED
        request.message.message_id = "retry-after-store-recovery"
        request.message.task_id = submitted.id
        request.message.context_id = submitted.context_id
        retry = [event async for event in handler.on_message_send_stream(request, context)]
        assert [
            event.status.state for event in retry if isinstance(event, TaskStatusUpdateEvent)
        ] == [TaskState.TASK_STATE_COMPLETED]
        assert (await store.get(submitted.id, context)).status.state == TaskState.TASK_STATE_COMPLETED
        assert producer.calls == 2
        assert store.completed_writes == 1


async def test_cancel_reports_one_matching_terminal_to_both_rpc_and_stream():
    class Producer:
        async def stream(self, module_id, inputs, context):
            yield {"value": "partial"}
            await asyncio.Future()

    store = A2ATaskStore()
    agent = ApCoreAgentExecutor(
        Producer(), PartConverter(SchemaConverter()), ErrorMapper(), track_terminal_status=True,
    )
    handler = _TerminalAwareRequestHandler(
        agent_executor=agent,
        task_store=_ObservedTaskStore(store, agent),
        agent_card=AgentCard(name="test", capabilities={"streaming": True}),
    )
    context = ServerCallContext()
    request = SendMessageRequest(
        message={
            "message_id": "cancel",
            "role": "ROLE_USER",
            "parts": [{"text": "test"}],
            "metadata": {"skillId": "test.cancel"},
        },
    )
    stream = handler.on_message_send_stream(request, context)
    submitted = await asyncio.wait_for(anext(stream), 1)
    assert isinstance(submitted, Task)
    cancel = asyncio.create_task(handler.on_cancel_task(CancelTaskRequest(id=submitted.id), context))
    try:
        async with asyncio.timeout(2):
            statuses = [event.status async for event in stream if isinstance(event, TaskStatusUpdateEvent)]
            canceled = await cancel
        assert [status.state for status in statuses] == [TaskState.TASK_STATE_CANCELED]
        assert statuses[0] == canceled.status
    finally:
        cancel.cancel()
        await asyncio.gather(cancel, return_exceptions=True)
        await stream.aclose()


async def test_sdk_cancel_cannot_rewrite_a_completed_terminal_waiting_on_its_queue(monkeypatch):
    offered, release, cancel_entered = asyncio.Event(), asyncio.Event(), asyncio.Event()
    enqueue = EventQueueSource.enqueue_event

    async def delay_completion(queue, event):
        if isinstance(event, TaskStatusUpdateEvent) and event.status.state == TaskState.TASK_STATE_COMPLETED:
            offered.set()
            await release.wait()
        await enqueue(queue, event)

    monkeypatch.setattr(EventQueueSource, "enqueue_event", delay_completion)

    class Producer:
        async def stream(self, module_id, inputs, context):
            yield {"value": "complete"}

    store = A2ATaskStore()
    agent = ApCoreAgentExecutor(
        Producer(), PartConverter(SchemaConverter()), ErrorMapper(), track_terminal_status=True
    )
    cancel = agent.cancel

    async def observe_cancel(*args):
        cancel_entered.set()
        await cancel(*args)

    monkeypatch.setattr(agent, "cancel", observe_cancel)
    handler = _TerminalAwareRequestHandler(
        agent_executor=agent,
        task_store=_ObservedTaskStore(store, agent),
        agent_card=AgentCard(name="test", capabilities={"streaming": True}),
    )
    context = ServerCallContext()
    request = SendMessageRequest(
        message={
            "message_id": "complete",
            "role": "ROLE_USER",
            "parts": [{"text": "test"}],
            "metadata": {"skillId": "test.complete"},
        },
    )
    stream = handler.on_message_send_stream(request, context)
    submitted = await asyncio.wait_for(anext(stream), 1)
    assert isinstance(submitted, Task)
    await asyncio.wait_for(offered.wait(), 1)
    assert agent.project_terminal_status(submitted, context) is submitted
    response = asyncio.create_task(handler.on_cancel_task(CancelTaskRequest(id=submitted.id), context))
    try:
        await asyncio.wait_for(cancel_entered.wait(), 1)
        release.set()
        async with asyncio.timeout(2):
            statuses = [event.status async for event in stream if isinstance(event, TaskStatusUpdateEvent)]
        with pytest.raises(TaskNotCancelableError):
            await asyncio.wait_for(response, 1)
        assert [status.state for status in statuses] == [TaskState.TASK_STATE_COMPLETED]
        assert (await store.get(submitted.id, context)).status == statuses[0]
    finally:
        release.set()
        response.cancel()
        await asyncio.gather(response, return_exceptions=True)
        await stream.aclose()


def test_agent_card_has_skills(mock_registry, mock_executor, simple_descriptor):
    factory = A2AServerFactory()
    _, card = factory.create(
        mock_registry,
        mock_executor,
        name="Agent",
        description="d",
        version="1",
        url="http://x",
    )
    assert len(card.skills) == 1
    assert card.skills[0].id == "image.resize"


def test_auth_security_schemes_raises_on_failure(mock_registry, mock_executor):
    """Auth failure in security_schemes() raises (not swallowed)."""
    auth = MagicMock()
    auth.security_schemes.side_effect = ValueError("bad key")
    factory = A2AServerFactory()
    with pytest.raises(ValueError, match="bad key"):
        factory.create(
            mock_registry,
            mock_executor,
            name="Agent",
            description="d",
            version="1",
            url="http://x",
            auth=auth,
        )


def test_push_notifications_enabled(mock_registry, mock_executor):
    """push_notifications=True enables InMemoryPushNotificationConfigStore."""
    factory = A2AServerFactory()
    app, card = factory.create(
        mock_registry,
        mock_executor,
        name="Agent",
        description="d",
        version="1",
        url="http://x",
        push_notifications=True,
    )
    assert card.capabilities.push_notifications is True


def test_register_module_invalidates_cache(mock_registry, mock_executor):
    """register_module() invalidates the cached card."""
    factory = A2AServerFactory()
    factory.create(
        mock_registry,
        mock_executor,
        name="Agent",
        description="d",
        version="1",
        url="http://x",
    )
    factory._agent_card_builder._cached_card = MagicMock()  # inject stale marker
    factory.register_module("new.skill", MagicMock())
    assert factory._agent_card_builder._cached_card is None


def test_metrics_route_when_enabled(mock_registry, mock_executor):
    """metrics=True → /metrics returns 200."""
    factory = A2AServerFactory()
    app, _ = factory.create(
        mock_registry,
        mock_executor,
        name="Agent",
        description="d",
        version="1",
        url="http://x",
        metrics=True,
    )
    client = TestClient(app)
    resp = client.get("/metrics")
    assert resp.status_code == 200


def test_no_metrics_route_when_disabled(mock_registry, mock_executor):
    """metrics=False (default) → /metrics returns 404."""
    factory = A2AServerFactory()
    app, _ = factory.create(
        mock_registry,
        mock_executor,
        name="Agent",
        description="d",
        version="1",
        url="http://x",
        metrics=False,
    )
    client = TestClient(app)
    resp = client.get("/metrics")
    assert resp.status_code in (404, 405)


def test_create_returns_starlette_when_metrics_enabled(mock_registry, mock_executor):
    """T1: metrics=True → returned app is still a Starlette instance (not a raw ASGI wrapper)."""
    factory = A2AServerFactory()
    app, _ = factory.create(
        mock_registry,
        mock_executor,
        name="Agent",
        description="d",
        version="1",
        url="http://x",
        metrics=True,
    )
    assert isinstance(app, Starlette)
