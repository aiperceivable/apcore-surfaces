"""Tests for ApCoreAgentExecutor."""

from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock

import pytest
from a2a.server.context import ServerCallContext
from a2a.server.events.event_queue import EventQueueLegacy as EventQueue
from a2a.server.events.in_memory_queue_manager import InMemoryQueueManager
from a2a.types import Message, Part, Role, Task, TaskArtifactUpdateEvent, TaskState, TaskStatusUpdateEvent
from apcore.errors import ErrorCodes, ModuleError

from apcore_a2a.adapters.errors import ErrorMapper
from apcore_a2a.adapters.parts import PartConverter
from apcore_a2a.adapters.schema import SchemaConverter
from apcore_a2a.server.context import IdentityUser
from apcore_a2a.server.executor import ApCoreAgentExecutor

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_context(skill_id: str = "image.resize", text: str = "hello", task_id: str = "task-1"):
    ctx = MagicMock()
    ctx.task_id = task_id
    ctx.context_id = "ctx-1"
    msg = Message(
        role=Role.ROLE_USER,
        parts=[Part(text=text)],
        message_id="msg-1",
    )
    msg.metadata.update({"skillId": skill_id})
    ctx.message = msg
    return ctx


async def _drain_queue(event_queue: EventQueue) -> list:
    # T2: use 0.5s timeout to avoid flakiness on slow CI runners
    events = []
    while True:
        try:
            event = await asyncio.wait_for(event_queue.dequeue_event(), timeout=0.5)
            if event is None:
                break
            events.append(event)
        except TimeoutError:
            break
    return events


async def _make_queue() -> EventQueue:
    mgr = InMemoryQueueManager()
    await mgr.create_or_tap("task-1")
    return await mgr.get("task-1")


@pytest.mark.parametrize("partial", [False, True])
async def test_stream_timeout_finishes_before_producer_cleanup(partial, caplog):
    cleanup_started = asyncio.Event()
    release_cleanup = asyncio.Event()
    producer_closed = asyncio.Event()
    cancellation_seen = []

    class SlowExecutor:
        async def stream(self, module_id, inputs, context):
            try:
                if partial:
                    yield {"value": "partial"}
                try:
                    await asyncio.Future()
                except asyncio.CancelledError:
                    cancellation_seen.append(context.cancel_token.is_cancelled)
                    cleanup_started.set()
                    await release_cleanup.wait()
                    yield {"value": "late"}
            finally:
                producer_closed.set()
                raise RuntimeError("generator cleanup failed")

    agent = ApCoreAgentExecutor(
        SlowExecutor(),
        PartConverter(SchemaConverter()),
        ErrorMapper(),
        execution_timeout=0.03,
    )
    queue = await _make_queue()
    running = asyncio.create_task(agent.execute(_make_context(), queue))
    try:
        await asyncio.wait_for(cleanup_started.wait(), timeout=1)
        done, _ = await asyncio.wait({running}, timeout=0.5)
        assert running in done, "the task terminal must not wait for generator cleanup"
        await running
        assert not producer_closed.is_set()
    finally:
        release_cleanup.set()
        await asyncio.wait_for(running, timeout=1)
        await asyncio.wait_for(producer_closed.wait(), timeout=1)

    events = await _drain_queue(queue)
    updates = [event for event in events if isinstance(event, TaskStatusUpdateEvent)]
    assert [event.status.state for event in updates] == [TaskState.TASK_STATE_FAILED]
    assert updates[0].status.message.parts[0].text == "Execution timed out"
    artifacts = [event for event in events if isinstance(event, TaskArtifactUpdateEvent)]
    assert len(artifacts) == int(partial)
    assert all(not event.last_chunk for event in artifacts)
    assert cancellation_seen == [True]
    assert "Stream cleanup failed for task task-1" in caplog.text


async def test_client_cancel_wins_over_late_stream_completion():
    started = asyncio.Event()
    resume = asyncio.Event()

    class SlowExecutor:
        async def stream(self, module_id, inputs, context):
            started.set()
            await resume.wait()
            yield {"value": "late"}

    agent = ApCoreAgentExecutor(SlowExecutor(), PartConverter(SchemaConverter()), ErrorMapper())
    queue = await _make_queue()
    ctx = _make_context()
    running = asyncio.create_task(agent.execute(ctx, queue))
    try:
        await asyncio.wait_for(started.wait(), timeout=1)
        await agent.cancel(ctx, queue)
    finally:
        resume.set()
        await asyncio.wait_for(running, timeout=1)

    events = await _drain_queue(queue)
    updates = [event.status.state for event in events if isinstance(event, TaskStatusUpdateEvent)]
    assert updates == [TaskState.TASK_STATE_CANCELED]
    assert all(not isinstance(event, TaskArtifactUpdateEvent) for event in events)


async def _read_event(queue):
    event = await asyncio.wait_for(queue.dequeue_event(), 1)
    queue.task_done()
    return event


async def test_timeout_is_queryable_while_artifacts_block_the_sdk_queue(monkeypatch):
    timed_out = asyncio.Event()
    queue = EventQueue(max_queue_size=1)
    enqueue = queue.enqueue_event

    async def observe_enqueue(event):
        if isinstance(event, TaskStatusUpdateEvent):
            timed_out.set()
        await enqueue(event)

    monkeypatch.setattr(queue, "enqueue_event", observe_enqueue)

    class Producer:
        async def stream(self, module_id, inputs, context):
            for value in range(20):
                yield {"value": value}

    agent = ApCoreAgentExecutor(
        Producer(), PartConverter(SchemaConverter()), ErrorMapper(), execution_timeout=0.05, track_terminal_status=True
    )
    context = _make_context()
    owner = ServerCallContext(user=IdentityUser(MagicMock(id="owner")))
    other = ServerCallContext(user=IdentityUser(MagicMock(id="other")))
    context.call_context = owner
    running = asyncio.create_task(agent.execute(context, queue))
    submitted = await _read_event(queue)
    try:
        await asyncio.wait_for(timed_out.wait(), 1)
        assert queue.queue.full()
        projected = agent.project_terminal_status(submitted, owner)
        assert projected.status.state == TaskState.TASK_STATE_FAILED
        assert submitted.status.state == TaskState.TASK_STATE_SUBMITTED
        assert agent.project_terminal_status(submitted, other) is submitted
        await _read_event(queue)
        terminal = await _read_event(queue)
        assert terminal.status.state == TaskState.TASK_STATE_FAILED
        await asyncio.wait_for(running, 1)
        persisted = Task(id=submitted.id, context_id=submitted.context_id, status=terminal.status)
        agent.observe_task_saved(persisted, other)
        assert agent.project_terminal_status(submitted, owner).status == persisted.status
        agent.observe_task_saved(persisted, owner)
        assert agent.project_terminal_status(submitted, owner) is submitted
    finally:
        running.cancel()
        await asyncio.gather(running, return_exceptions=True)
        await queue.close(immediate=True)


async def test_cancel_cannot_replace_completed_status_waiting_to_be_enqueued(monkeypatch):
    completed = asyncio.Event()
    queue = EventQueue(max_queue_size=1)
    enqueue = queue.enqueue_event

    async def observe_enqueue(event):
        if isinstance(event, TaskStatusUpdateEvent) and event.status.state == TaskState.TASK_STATE_COMPLETED:
            completed.set()
        await enqueue(event)

    monkeypatch.setattr(queue, "enqueue_event", observe_enqueue)

    class Producer:
        async def stream(self, module_id, inputs, context):
            yield {"value": 1}

    agent = ApCoreAgentExecutor(Producer(), PartConverter(SchemaConverter()), ErrorMapper())
    context = _make_context()
    running = asyncio.create_task(agent.execute(context, queue))
    cancel = None
    try:
        await _read_event(queue)
        await _read_event(queue)
        await asyncio.wait_for(completed.wait(), 1)
        cancel = asyncio.create_task(agent.cancel(context, queue))
        await _read_event(queue)
        await asyncio.wait_for(cancel, 1)
        terminal = await _read_event(queue)
        assert terminal.status.state == TaskState.TASK_STATE_COMPLETED
        await asyncio.wait_for(running, 1)
        assert queue.queue.empty()
    finally:
        running.cancel()
        if cancel is not None:
            cancel.cancel()
        await asyncio.gather(running, *([cancel] if cancel is not None else []), return_exceptions=True)
        await queue.close(immediate=True)


async def test_stale_cancel_cannot_replace_a_terminal_status_already_saved():
    context = _make_context()
    load_task = AsyncMock(
        return_value=Task(
            id=context.task_id,
            context_id=context.context_id,
            status={"state": TaskState.TASK_STATE_COMPLETED},
        )
    )
    agent = ApCoreAgentExecutor(
        MagicMock(), PartConverter(SchemaConverter()), ErrorMapper(), load_task=load_task
    )
    queue = EventQueue(max_queue_size=1)
    try:
        await agent.cancel(context, queue)
        load_task.assert_awaited_once_with(context.task_id, context.call_context)
        assert queue.queue.empty()
    finally:
        await queue.close(immediate=True)


async def test_cancel_event_survives_queue_shutdown_when_artifacts_block_the_queue(monkeypatch):
    parked, cancel_offered, closing = asyncio.Event(), asyncio.Event(), asyncio.Event()
    queue = EventQueue(max_queue_size=1)
    enqueue = queue.enqueue_event

    async def observe_enqueue(event):
        if isinstance(event, TaskStatusUpdateEvent) and event.status.state == TaskState.TASK_STATE_CANCELED:
            cancel_offered.set()
        await enqueue(event)

    monkeypatch.setattr(queue, "enqueue_event", observe_enqueue)

    class Producer:
        async def stream(self, module_id, inputs, context):
            yield {"value": 1}
            parked.set()
            await asyncio.Future()

    agent = ApCoreAgentExecutor(Producer(), PartConverter(SchemaConverter()), ErrorMapper())
    context = _make_context()

    async def run_until_closed():
        await agent.execute(context, queue)
        closing.set()
        await queue.close()

    running = asyncio.create_task(run_until_closed())
    cancel = None
    try:
        await _read_event(queue)
        await asyncio.wait_for(parked.wait(), 1)
        assert queue.queue.full()
        cancel = asyncio.create_task(agent.cancel(context, queue))
        await asyncio.wait_for(cancel_offered.wait(), 1)
        # The SDK must not begin shutting down the queue while cancel is
        # blocked on offering the one terminal event.
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(closing.wait(), 0.05)
        assert isinstance(await _read_event(queue), TaskArtifactUpdateEvent)
        await asyncio.wait_for(cancel, 1)
        terminal = await _read_event(queue)
        assert terminal.status.state == TaskState.TASK_STATE_CANCELED
        await asyncio.wait_for(running, 1)
    finally:
        running.cancel()
        if cancel is not None:
            cancel.cancel()
        await asyncio.gather(running, *([cancel] if cancel is not None else []), return_exceptions=True)
        await queue.close(immediate=True)


@pytest.fixture
def mock_registry():
    reg = MagicMock()
    reg.list.return_value = ["image.resize"]
    reg.get_definition.return_value = MagicMock(
        module_id="image.resize",
        description="Resize",
        input_schema={"type": "object"},
        output_schema={"type": "object"},
    )
    return reg


@pytest.fixture
def mock_executor():
    ex = MagicMock()
    ex.call_async = AsyncMock(return_value={"width": 800})
    return ex


@pytest.fixture
def apcore_executor(mock_executor, mock_registry):
    return ApCoreAgentExecutor(
        mock_executor,
        PartConverter(SchemaConverter()),
        ErrorMapper(),
        mock_registry,
        execution_timeout=5,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_execute_happy_path_enqueues_artifact_and_completed(apcore_executor):
    """Happy path: execute() enqueues artifact then completed event."""
    ctx = _make_context(skill_id="image.resize", text='{"width": 800}')
    queue = await _make_queue()

    await apcore_executor.execute(ctx, queue)

    events = await _drain_queue(queue)
    kinds = [type(e).__name__ for e in events]
    assert "TaskArtifactUpdateEvent" in kinds
    assert "TaskStatusUpdateEvent" in kinds

    status_events = [e for e in events if hasattr(e, "status")]
    assert any(e.status.state == TaskState.TASK_STATE_COMPLETED for e in status_events)


async def test_execute_missing_skill_id_enqueues_failed(apcore_executor):
    """Missing skillId in metadata → failed event."""
    ctx = MagicMock()
    ctx.task_id = "task-1"
    ctx.context_id = "ctx-1"
    msg = Message(
        role=Role.ROLE_USER,
        parts=[Part(text="hi")],
        message_id="msg-1",
    )
    ctx.message = msg
    queue = await _make_queue()

    await apcore_executor.execute(ctx, queue)

    events = await _drain_queue(queue)
    status_events = [e for e in events if hasattr(e, "status")]
    assert any(e.status.state == TaskState.TASK_STATE_FAILED for e in status_events)
    # Find the specific failed event (first event is now initial Task with SUBMITTED state)
    failed_events = [e for e in status_events if e.status.state == TaskState.TASK_STATE_FAILED]
    msg_text = failed_events[0].status.message.parts[0].text
    assert "skillId" in msg_text


async def test_execute_unknown_skill_enqueues_failed(apcore_executor):
    """Unknown skill → failed event."""
    ctx = _make_context(skill_id="unknown.skill")
    queue = await _make_queue()

    await apcore_executor.execute(ctx, queue)

    events = await _drain_queue(queue)
    status_events = [e for e in events if hasattr(e, "status")]
    assert any(e.status.state == TaskState.TASK_STATE_FAILED for e in status_events)


async def test_execute_timeout_enqueues_failed(apcore_executor, mock_executor):
    """asyncio.TimeoutError → failed event."""
    mock_executor.call_async = AsyncMock(side_effect=TimeoutError())
    ctx = _make_context(skill_id="image.resize", text='{"width": 800}')
    queue = await _make_queue()

    await apcore_executor.execute(ctx, queue)

    events = await _drain_queue(queue)
    status_events = [e for e in events if hasattr(e, "status")]
    assert any(e.status.state == TaskState.TASK_STATE_FAILED for e in status_events)


async def test_execute_approval_pending_enqueues_input_required(apcore_executor, mock_executor):
    """APPROVAL_PENDING code → input_required event."""

    class ApprovalError(Exception):
        code = "APPROVAL_PENDING"

    mock_executor.call_async = AsyncMock(side_effect=ApprovalError("needs approval"))
    ctx = _make_context(skill_id="image.resize", text='{"width": 800}')
    queue = await _make_queue()

    await apcore_executor.execute(ctx, queue)

    events = await _drain_queue(queue)
    status_events = [e for e in events if hasattr(e, "status")]
    assert any(e.status.state == TaskState.TASK_STATE_INPUT_REQUIRED for e in status_events)


async def test_execute_generic_exception_enqueues_failed(apcore_executor, mock_executor):
    """Generic exception → failed event (no internal details leaked)."""
    mock_executor.call_async = AsyncMock(side_effect=RuntimeError("internal secret"))
    ctx = _make_context(skill_id="image.resize", text='{"width": 800}')
    queue = await _make_queue()

    await apcore_executor.execute(ctx, queue)

    events = await _drain_queue(queue)
    status_events = [e for e in events if hasattr(e, "status")]
    assert any(e.status.state == TaskState.TASK_STATE_FAILED for e in status_events)
    # Error message must not leak internal details
    # Find the specific failed event (first event is now initial Task with SUBMITTED state)
    failed_events = [e for e in status_events if e.status.state == TaskState.TASK_STATE_FAILED]
    msg_text = failed_events[0].status.message.parts[0].text
    assert "secret" not in msg_text.lower()


async def test_cancel_enqueues_canceled(apcore_executor):
    """cancel() enqueues canceled event."""
    ctx = _make_context()
    queue = await _make_queue()

    await apcore_executor.cancel(ctx, queue)

    events = await _drain_queue(queue)
    status_events = [e for e in events if hasattr(e, "status")]
    assert any(e.status.state == TaskState.TASK_STATE_CANCELED for e in status_events)


# ---------------------------------------------------------------------------
# T1: on_state_change callback tests
# ---------------------------------------------------------------------------


async def test_on_state_change_called_on_success(mock_executor, mock_registry):
    """T1: on_state_change receives (submitted→working) then (working→completed) on success."""
    calls: list[tuple[str, str]] = []
    executor = ApCoreAgentExecutor(
        mock_executor,
        PartConverter(SchemaConverter()),
        ErrorMapper(),
        mock_registry,
        execution_timeout=5,
        on_state_change=lambda old, new: calls.append((old, new)),
    )
    ctx = _make_context(skill_id="image.resize", text='{"width": 800}')
    queue = await _make_queue()

    await executor.execute(ctx, queue)

    assert ("submitted", "working") in calls
    assert ("working", "completed") in calls


async def test_on_state_change_called_on_missing_skill_id(mock_executor, mock_registry):
    """T1: on_state_change receives (submitted→failed) when skillId is missing."""
    calls: list[tuple[str, str]] = []
    executor = ApCoreAgentExecutor(
        mock_executor,
        PartConverter(SchemaConverter()),
        ErrorMapper(),
        mock_registry,
        execution_timeout=5,
        on_state_change=lambda old, new: calls.append((old, new)),
    )
    ctx = MagicMock()
    ctx.task_id = "task-1"
    ctx.context_id = "ctx-1"
    msg = Message(
        role=Role.ROLE_USER,
        parts=[Part(text="hi")],
        message_id="msg-1",
    )
    ctx.message = msg
    queue = await _make_queue()

    await executor.execute(ctx, queue)

    assert ("submitted", "failed") in calls


async def test_on_state_change_called_on_timeout(mock_executor, mock_registry):
    """T1: on_state_change receives (working→failed) on timeout."""
    mock_executor.call_async = AsyncMock(side_effect=TimeoutError())
    calls: list[tuple[str, str]] = []
    executor = ApCoreAgentExecutor(
        mock_executor,
        PartConverter(SchemaConverter()),
        ErrorMapper(),
        mock_registry,
        execution_timeout=5,
        on_state_change=lambda old, new: calls.append((old, new)),
    )
    ctx = _make_context(skill_id="image.resize", text="{}")
    queue = await _make_queue()

    await executor.execute(ctx, queue)

    assert ("working", "failed") in calls


async def test_on_state_change_called_on_approval_pending(mock_executor, mock_registry):
    """T1: on_state_change receives (working→input_required) on APPROVAL_PENDING."""

    class ApprovalError(Exception):
        code = "APPROVAL_PENDING"

    mock_executor.call_async = AsyncMock(side_effect=ApprovalError("needs approval"))
    calls: list[tuple[str, str]] = []
    executor = ApCoreAgentExecutor(
        mock_executor,
        PartConverter(SchemaConverter()),
        ErrorMapper(),
        mock_registry,
        execution_timeout=5,
        on_state_change=lambda old, new: calls.append((old, new)),
    )
    ctx = _make_context(skill_id="image.resize", text="{}")
    queue = await _make_queue()

    await executor.execute(ctx, queue)

    assert ("working", "input_required") in calls


async def test_on_state_change_not_called_when_none(mock_executor, mock_registry):
    """T1: no error when on_state_change is None (default)."""
    executor = ApCoreAgentExecutor(
        mock_executor,
        PartConverter(SchemaConverter()),
        ErrorMapper(),
        mock_registry,
        execution_timeout=5,
        # on_state_change defaults to None
    )
    ctx = _make_context(skill_id="image.resize", text="{}")
    queue = await _make_queue()
    # Must not raise
    await executor.execute(ctx, queue)


async def test_execute_passes_epoch_seconds_global_deadline(apcore_executor, monkeypatch):
    """apcore >= 0.31.0 / D-99: `Context.create`'s `global_deadline` MUST be an
    epoch-seconds value (`time.time() + budget`), not a `time.monotonic()`
    one. apcore-python's own enforcement compared it against `time.monotonic()`
    until 0.31.0, which made an epoch-seconds deadline never fire (silent,
    fail-open); this executor used to pass a monotonic value to work around
    that. Now that apcore compares against `time.time()`, a monotonic value
    reads as already-expired and fails every call immediately — so this pins
    the value against `time.time()`, not `time.monotonic()`.
    """
    import apcore

    captured: dict = {}
    real_create = apcore.Context.create

    def _capture(*args, **kwargs):
        captured.update(kwargs)
        return real_create(*args, **kwargs)

    monkeypatch.setattr(apcore.Context, "create", _capture)

    ctx = _make_context(skill_id="image.resize", text='{"width": 800}')
    queue = await _make_queue()
    before = time.time()

    await apcore_executor.execute(ctx, queue)

    after = time.time()
    assert "global_deadline" in captured
    deadline = captured["global_deadline"]
    # execution_timeout=5 on the apcore_executor fixture; allow generous slack
    # for test scheduling jitter while still rejecting a monotonic-clock value
    # (which would be off by ~time.time()'s epoch, i.e. billions of seconds).
    assert before + 5 - 1 <= deadline <= after + 5 + 5


async def test_execute_streams_even_when_apcore_ctx_is_none(mock_registry, monkeypatch):
    """A-D-016: a streaming executor must be dispatched to the streaming path
    even in the degraded no-apcore-binding state (apcore_ctx is None),
    matching TS canStream (which checks only the stream method) and
    executeStreaming (which tolerates a null ctx).
    """
    # Force apcore_ctx to remain None by making Context.create raise, so the
    # executor's `except: pass` leaves apcore_ctx = None.
    import apcore

    monkeypatch.setattr(apcore.Context, "create", MagicMock(side_effect=RuntimeError("no binding")))

    received_args: list = []

    class _StreamingExecutor:
        async def stream(self, module_id, inputs, ctx=None):
            # Record positional args to assert the ctx was NOT passed.
            received_args.append((module_id, inputs, ctx))
            yield {"chunk": 1}
            yield {"chunk": 2}

    executor = ApCoreAgentExecutor(
        _StreamingExecutor(),
        PartConverter(SchemaConverter()),
        ErrorMapper(),
        mock_registry,
        execution_timeout=5,
    )
    ctx = _make_context(skill_id="image.resize", text="{}")
    queue = await _make_queue()

    await executor.execute(ctx, queue)

    # Streaming path was taken: stream() was invoked without the apcore ctx.
    assert len(received_args) == 1
    assert received_args[0][2] is None

    events = await _drain_queue(queue)
    artifact_events = [e for e in events if type(e).__name__ == "TaskArtifactUpdateEvent"]
    # Two chunk artifacts + a final last_chunk artifact.
    assert len(artifact_events) >= 2
    status_events = [e for e in events if hasattr(e, "status")]
    assert any(e.status.state == TaskState.TASK_STATE_COMPLETED for e in status_events)


# ---------------------------------------------------------------------------
# Failed-task error classification (apexe #33)
# ---------------------------------------------------------------------------


async def _terminal_status(apcore_executor, mock_executor, error: Exception, state) -> str:
    """Run one failing execution and return the terminal status message text."""
    mock_executor.call_async = AsyncMock(side_effect=error)
    ctx = _make_context(skill_id="image.resize", text='{"width": 800}')
    queue = await _make_queue()
    await apcore_executor.execute(ctx, queue)
    events = await _drain_queue(queue)
    matching = [e for e in events if hasattr(e, "status") and e.status.state == state]
    assert matching, f"expected a {state} status event, got {[getattr(e, 'status', None) for e in events]}"
    return matching[0].status.message.parts[0].text


async def _failed_text(apcore_executor, mock_executor, error: Exception) -> str:
    """Run one failing execution and return the FAILED status message text."""
    return await _terminal_status(apcore_executor, mock_executor, error, TaskState.TASK_STATE_FAILED)


async def _rejected_text(apcore_executor, mock_executor, error: Exception) -> str:
    """Run one refused execution and return the REJECTED status message text."""
    return await _terminal_status(apcore_executor, mock_executor, error, TaskState.TASK_STATE_REJECTED)


async def test_execute_invalid_input_error_reaches_the_caller(apcore_executor, mock_executor):
    """srs FR-ERR-002/FR-ERR-006: a caller-fixable failure must carry detail.

    Collapsing it to the generic string leaves an agent unable to tell a bad
    argument from a crash, which is the whole point of the transport.
    """
    err = ModuleError(
        code=ErrorCodes.GENERAL_INVALID_INPUT,
        message="Parameters '1' and 'l' cannot be used together",
    )
    text = await _failed_text(apcore_executor, mock_executor, err)
    assert "'1' and 'l' cannot be used together" in text


async def test_execute_canonical_schema_diagnostics_preserve_pointer(apcore_executor, mock_executor):
    err = ModuleError(
        code=ErrorCodes.SCHEMA_VALIDATION_ERROR,
        message="Input validation failed",
        details={"errors": [{"path": "/items/0/width", "keyword": "type", "message": "must be integer"}]},
    )
    text = await _failed_text(apcore_executor, mock_executor, err)
    assert "/items/0/width [type]: must be integer" in text


async def test_execute_schema_validation_error_names_the_field(apcore_executor, mock_executor):
    err = ModuleError(code=ErrorCodes.SCHEMA_VALIDATION_ERROR, message="width: must be integer")
    text = await _failed_text(apcore_executor, mock_executor, err)
    assert "width" in text


async def test_execute_acl_denial_is_rejected_and_says_access_denied(apcore_executor, mock_executor):
    """srs FR-ERR-003 / FR-ERR-012: the class of refusal reaches the caller, the detail does not.

    This is the surface that matters on ``message/send``, where the response is
    a JSON-RPC ``result`` and the error code never reaches the caller at all —
    the state and this message are the whole payload it receives.
    """
    err = ModuleError(code=ErrorCodes.ACL_DENIED, message="caller alice denied module admin.wipe")
    text = await _rejected_text(apcore_executor, mock_executor, err)
    assert text == "Access denied"
    # "Task not found" sent an agent back to retry the one thing that was fine.
    assert text != "Task not found"
    assert "alice" not in text
    assert "admin.wipe" not in text


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        (ErrorCodes.APPROVAL_DENIED, "Approval denied"),
        (ErrorCodes.APPROVAL_TIMEOUT, "Approval timed out"),
    ],
)
async def test_execute_approval_refusals_are_rejected_not_failed(apcore_executor, mock_executor, code, expected):
    """srs FR-ERR-009 / FR-ERR-010. These used to reach the caller as -32603
    "Internal server error" — the canonical *retryable* failure, for a call a
    human had explicitly refused."""
    err = ModuleError(code=code, message="approval 7f3c1e for alice@example.com")
    text = await _rejected_text(apcore_executor, mock_executor, err)
    assert text == expected
    assert text != "Internal server error"
    assert "alice@example.com" not in text
    assert "7f3c1e" not in text


async def test_execute_approval_pending_stays_a_resumable_pause(apcore_executor, mock_executor):
    """The one approval code that must NOT move (srs FR-EXE-002).

    It carries the ``approval_id`` the caller resumes with, and ``rejected`` is
    terminal — re-coding it would end the conversation.
    """
    err = ModuleError(code=ErrorCodes.APPROVAL_PENDING, message="Approval required: approval_id=7f3c1e")
    text = await _terminal_status(apcore_executor, mock_executor, err, TaskState.TASK_STATE_INPUT_REQUIRED)
    assert "approval_id=7f3c1e" in text, "the message must reach the caller verbatim"


async def test_execute_internal_error_yields_fixed_message(apcore_executor, mock_executor):
    """srs FR-ERR-004 / FR-ERR-008: internal and unrecognized errors stay fixed."""
    err = ModuleError(
        code=ErrorCodes.GENERAL_INTERNAL_ERROR,
        message="super secret internal detail leaking through",
    )
    text = await _failed_text(apcore_executor, mock_executor, err)
    assert text == "Internal server error"


async def test_execute_ai_guidance_is_appended_for_caller_fixable_errors(apcore_executor, mock_executor):
    """ai_guidance exists to tell an agent what to do next; the caller sees only this."""
    err = ModuleError(
        code=ErrorCodes.GENERAL_INVALID_INPUT,
        message="bad flag combination",
        ai_guidance="send either -1 or -l, not both",
    )
    text = await _failed_text(apcore_executor, mock_executor, err)
    assert "send either -1 or -l, not both" in text


async def test_execute_ai_guidance_is_withheld_for_internal_errors(apcore_executor, mock_executor):
    """The fixed per-class strings must stay fixed.

    ``DEPENDENCY_NOT_FOUND`` is the case that discriminates: apcore marks it
    ``user_fixable=True`` while the mapper sends it through the catch-all to
    "Internal server error", so a ``user_fixable``-based gate would append the
    guidance verbatim — internal dependency-graph detail (module ids, versions,
    env-var names, hostnames), none of which ``sanitize_message`` strips.
    """
    err = ModuleError(
        code=ErrorCodes.DEPENDENCY_NOT_FOUND,
        message="boom",
        ai_guidance="module 'billing.charge' requires 'vault.secrets' >= 2.1; set VAULT_ADDR",
    )
    assert err.user_fixable is True, "precondition for this test"
    text = await _failed_text(apcore_executor, mock_executor, err)
    assert text == "Internal server error"

    internal = ModuleError(
        code=ErrorCodes.GENERAL_INTERNAL_ERROR,
        message="boom",
        ai_guidance="inspect /var/log/secret.log",
    )
    assert await _failed_text(apcore_executor, mock_executor, internal) == "Internal server error"


async def test_execute_ai_guidance_is_withheld_when_a_module_declares_a_masked_error_user_fixable(
    apcore_executor, mock_executor
):
    """``user_fixable`` is author-settable, so gating on it let any module widen a fixed string."""
    err = ModuleError(
        code=ErrorCodes.ACL_DENIED,
        message="caller alice denied admin.wipe",
        user_fixable=True,
        ai_guidance="ask an admin to grant you the 'admin.wipe' role",
    )
    text = await _rejected_text(apcore_executor, mock_executor, err)
    assert text == "Access denied"


async def test_execute_failure_text_does_not_leak_paths_or_tracebacks(apcore_executor, mock_executor):
    """The redaction that the fixed string used to provide must survive the fix."""
    err = ModuleError(
        code=ErrorCodes.GENERAL_INVALID_INPUT,
        message='bad input at /home/deploy/app/secret.py\nTraceback (most recent call last):\nFile "x.py", line 42',
        ai_guidance="see /var/log/apcore/internal.log on db-prod-07",
    )
    text = await _failed_text(apcore_executor, mock_executor, err)
    assert "/home/deploy" not in text
    assert "/var/log" not in text
    assert "Traceback" not in text
    assert "line 42" not in text
