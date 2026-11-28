"""ApCoreAgentExecutor: bridges apcore execution to the a2a-sdk AgentExecutor ABC."""

from __future__ import annotations

import asyncio
import inspect
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, TypeVar
from uuid import uuid4

from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.context import ServerCallContext
from a2a.server.events.event_queue_v2 import EventQueue
from a2a.types import (
    Artifact,
    Message,
    Part,
    Role,
    Task,
    TaskArtifactUpdateEvent,
    TaskState,
    TaskStatus,
    TaskStatusUpdateEvent,
)
from apcore import Identity
from google.protobuf.timestamp_pb2 import Timestamp

# Imported at module level — no circular dependency (middleware.py does not import executor.py)
from apcore_a2a.adapters.errors import GOVERNANCE_REFUSAL_CODES, carries_caller_detail, sanitize_message
from apcore_a2a.artifacts import ArtifactLinkPolicy, _artifact_declaration, _ArtifactDeclaration, _validated_output
from apcore_a2a.auth.middleware import auth_identity_var
from apcore_a2a.server.context import TASK_OWNER_KEY, TASK_SKILL_KEY, identity_of, scoped_owner

logger = logging.getLogger(__name__)
_Result = TypeVar("_Result")
_TaskKey = tuple[str, str, str]
_TERMINAL_STATES = {
    TaskState.TASK_STATE_COMPLETED,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
}


@dataclass
class _TaskExecution:
    stopped: asyncio.Event = field(default_factory=asyncio.Event)
    token: Any = None
    work: asyncio.Future[Any] | None = None
    terminal: TaskStatus | None = None
    terminal_offer_finished: asyncio.Event = field(default_factory=asyncio.Event)


def _make_timestamp() -> Timestamp:
    ts = Timestamp()
    ts.FromDatetime(datetime.now(tz=UTC))
    return ts


def _make_status(state: int, message: Message | None = None) -> TaskStatus:
    status = TaskStatus(state=state)
    status.timestamp.CopyFrom(_make_timestamp())
    if message is not None:
        status.message.CopyFrom(message)
    return status


def _text_message(text: str) -> Message:
    return Message(
        role=Role.ROLE_AGENT,
        parts=[Part(text=text)],
        message_id=str(uuid4()),
    )


def _owner(context: ServerCallContext | None) -> str:
    name = getattr(getattr(context, "user", None), "user_name", "")
    return name if isinstance(name, str) else ""


class ApCoreAgentExecutor(AgentExecutor):
    """Bridges apcore executor to a2a-sdk's AgentExecutor interface."""

    def __init__(
        self,
        executor: Any,
        part_converter: Any,
        error_mapper: Any,
        registry: Any = None,
        execution_timeout: int = 300,
        on_state_change: Callable[[str, str], None] | None = None,
        *,
        artifact_links: ArtifactLinkPolicy | None = None,
        track_terminal_status: bool = False,
        load_task: Callable[[str, Any], Awaitable[Task | None]] | None = None,
    ) -> None:
        self._executor = executor
        self._part_converter = part_converter
        self._error_mapper = error_mapper
        self._registry = registry
        self._execution_timeout = execution_timeout
        self._on_state_change = on_state_change
        self._artifact_links = artifact_links
        # Cache inspect.signature results keyed by stable method qualified name
        self._context_accepts_cache: dict[str, bool] = {}
        self._running: dict[_TaskKey, _TaskExecution] = {}
        self._track_terminal_status = track_terminal_status
        self._load_task = load_task
        self._pending_terminal: dict[_TaskKey, TaskStatus] = {}
        self._cleaning_up: set[asyncio.Future[Any]] = set()

    def _notify(self, old_state: str, new_state: str) -> None:
        if self._on_state_change is not None:
            try:
                self._on_state_change(old_state, new_state)
            except Exception:
                logger.debug("on_state_change callback raised", exc_info=True)

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        key = self._task_key(context)
        run = _TaskExecution()
        self._running[key] = run
        try:
            await self._execute(context, event_queue, run)
            if run.terminal is not None:
                # The SDK closes the transport queue when execute() returns.
                # A concurrent cancel must finish offering its winning status
                # before that closure can discard it.
                await run.terminal_offer_finished.wait()
        finally:
            if self._running.get(key) is run:
                self._running.pop(key)

    @staticmethod
    def _task_key(context: RequestContext) -> _TaskKey:
        return context.task_id, context.context_id or context.task_id, _owner(context.call_context)

    def project_terminal_status(self, task: Task, context: ServerCallContext | None = None) -> Task:
        """Report a claimed terminal while the transport drains its event queue."""
        status = self._pending_terminal.get((task.id, task.context_id, _owner(context)))
        if (
            status is None
            or status.state == TaskState.TASK_STATE_COMPLETED
            or task.status.state in _TERMINAL_STATES
        ):
            return task
        projected = Task()
        projected.CopyFrom(task)
        projected.status.CopyFrom(status)
        return projected

    def observe_task_saved(self, task: Task, context: ServerCallContext | None = None) -> None:
        """Retire the projection only when the SDK has persisted that status."""
        key = (task.id, task.context_id, _owner(context))
        if task.status == self._pending_terminal.get(key):
            self._pending_terminal.pop(key)

    def observe_task_save_failed(self, task: Task, context: ServerCallContext) -> None:
        """Release this execution's unacknowledged terminal after SDK persistence stops."""
        key = (task.id, task.context_id, _owner(context))
        status = self._pending_terminal.get(key)
        run = self._running.get(key)
        writer = asyncio.current_task()
        if writer is None or (status is None and run is None):
            return

        def retire_unacknowledged_status(_: asyncio.Task[Any]) -> None:
            abandoned = status
            if abandoned is None and run is not None:
                abandoned = run.terminal
            if abandoned is not None and self._pending_terminal.get(key) is abandoned:
                self._pending_terminal.pop(key)

        # The SDK consumes each task's events in a background task. Its
        # retries run there too, so a failed write alone does not end the claim.
        writer.add_done_callback(retire_unacknowledged_status)

    async def _execute(self, context: RequestContext, event_queue: EventQueue, run: _TaskExecution) -> None:
        # a2a-sdk 1.0: Establish the Task in the store before any TaskStatusUpdateEvent
        context_id = context.context_id or context.task_id
        request_identity = identity_of(getattr(context, "call_context", None))
        identity = request_identity if isinstance(request_identity, Identity) else auth_identity_var.get()
        raw_metadata = context.message.metadata if context.message else None
        metadata: dict = dict(raw_metadata) if raw_metadata else {}
        skill_id = metadata.get("skillId")
        owner = scoped_owner(identity)
        initial_task = Task(
            id=context.task_id,
            context_id=context_id,
            status=_make_status(TaskState.TASK_STATE_SUBMITTED),
        )
        if owner is not None:
            initial_task.metadata.update({TASK_OWNER_KEY: owner})
            if isinstance(skill_id, str):
                initial_task.metadata.update({TASK_SKILL_KEY: skill_id})
        await event_queue.enqueue_event(initial_task)
        if run.stopped.is_set():
            return

        # 1. Get skill_id from message metadata
        # metadata is a protobuf Struct; convert to dict for .get() access
        if not skill_id:
            self._notify("submitted", "failed")
            await self._fail(context, event_queue, "Missing required parameter: metadata.skillId")
            return

        # 2. Validate skill exists in registry (fail closed).
        # Spec: validate skill_id is a known module → error if not. Matching the
        # Rust SDK, we fail closed: if the registry is unavailable (list() raises)
        # OR the skill_id is not a known module, the task fails with "Skill not
        # found" rather than proceeding optimistically.
        if self._registry is not None:
            try:
                known = self._registry.list()
            except Exception:
                logger.warning("Registry unavailable while validating skill %s", skill_id)
                self._notify("submitted", "failed")
                await self._fail(context, event_queue, f"Skill not found: {skill_id}")
                return
            if skill_id not in known:
                self._notify("submitted", "failed")
                await self._fail(context, event_queue, f"Skill not found: {skill_id}")
                return

        # 3. Parse Parts → apcore input
        parts = list(context.message.parts) if context.message else []
        descriptor = None
        if self._registry is not None:
            try:
                descriptor = self._registry.get_definition(skill_id)
            except Exception:
                logger.warning("Failed to get descriptor for %s", skill_id)

        try:
            inputs = self._part_converter.parts_to_input(parts, descriptor)
        except Exception as e:
            self._notify("submitted", "failed")
            await self._fail(context, event_queue, str(e))
            return

        # 4. Build apcore Identity context with CancelToken (P0-B)
        apcore_ctx = None
        token = None
        try:
            from apcore import CancelToken, Context  # type: ignore[import]

            token = CancelToken()
            run.token = token
            # Map the A2A execution_timeout onto apcore's first-class
            # global_deadline (0.22.0). apcore enforces it cooperatively at
            # pipeline Step 8 AND between streaming chunks (executor.stream),
            # which is the only timeout the streaming path would otherwise have.
            #
            # Epoch seconds, per apcore >= 0.31.0 / D-99 (PROTOCOL_SPEC): the
            # documented `Context.create` contract was always `time.time() +
            # budget`, but apcore-python's own enforcement compared it against
            # `time.monotonic()` until 0.31.0 — against that bug, an
            # epoch-seconds deadline is ~1.8e9 versus a ~1e5 monotonic clock, so
            # it never fires (silent, fail-open). This code used to work around
            # that bug by passing a monotonic value instead of the documented
            # one; apcore 0.31.0 fixes its own comparison to match the
            # documented contract, so passing a monotonic value now reads as
            # already-expired against `time.time()` and fails every call
            # immediately. Must be `time.time()`, not `time.monotonic()`.
            global_deadline = time.time() + self._execution_timeout
            apcore_ctx = Context.create(
                identity=identity,
                cancel_token=token,
                global_deadline=global_deadline,
            )
        except Exception:
            pass

        # 5. Execute — streaming if available, single otherwise (P0-A)
        self._notify("submitted", "working")
        stopped = run.stopped
        try:
            stream_fn = getattr(self._executor, "stream", None)
            # Stream selection is based on the executor's stream method alone,
            # matching TS's canStream (AsyncGeneratorFunction check). The apcore
            # context is NOT required: _execute_streaming tolerates a None ctx,
            # so streaming is still chosen in the degraded no-apcore-binding state.
            _can_stream = (
                stream_fn is not None
                and callable(stream_fn)
                and (inspect.isasyncgenfunction(stream_fn) or inspect.iscoroutinefunction(stream_fn))
            )

            declaration = None
            if self._artifact_links is not None and isinstance(identity, Identity) and apcore_ctx is not None:
                declaration = _artifact_declaration(self._registry, self._executor, skill_id, identity)
            if _can_stream and declaration is None:
                await self._run_with_timeout(
                    self._execute_streaming(context, event_queue, skill_id, inputs, apcore_ctx, context_id, stopped),
                    context.task_id,
                    run,
                )
            else:
                await self._run_with_timeout(
                    self._send_single(
                        context,
                        event_queue,
                        skill_id,
                        inputs,
                        apcore_ctx,
                        stopped,
                        declaration=declaration,
                    ),
                    context.task_id,
                    run,
                )
            if run.terminal is not None:
                return
            await self._publish_status(context, event_queue, TaskState.TASK_STATE_COMPLETED)
            self._notify("working", "completed")
        except asyncio.CancelledError:
            if run.terminal is not None and run.terminal.state == TaskState.TASK_STATE_CANCELED:
                return
            raise  # let a2a-sdk handle asyncio cancellation
        except TimeoutError:
            if run.terminal is not None:
                return
            if token is not None:
                token.cancel()
            self._notify("working", "failed")
            await self._fail(context, event_queue, "Execution timed out")
        except Exception as exc:
            if run.terminal is not None:
                return
            code = getattr(exc, "code", None)
            if code == "MODULE_TIMEOUT":
                # apcore enforced global_deadline (streaming or cooperative step)
                if token is not None:
                    token.cancel()
                self._notify("working", "failed")
                await self._fail(context, event_queue, "Execution timed out")
            elif code == "EXECUTION_CANCELLED":
                # P0-C: cooperative cancellation via CancelToken
                self._notify("working", "canceled")
                await self._emit_canceled(context, event_queue, "Execution cancelled")
            elif code == "APPROVAL_PENDING":
                # A resumable pause, not a refusal: the message carries the
                # approval_id the caller resumes with (srs FR-EXE-002). Must not
                # be swept in with the governance codes below — `rejected` is
                # terminal, so re-coding it would end the conversation.
                self._notify("working", "input_required")
                await self._input_required(context, event_queue, str(exc))
            elif code in GOVERNANCE_REFUSAL_CODES:
                # A2A 1.0 defines `rejected` as terminal, and a policy refusal is
                # what it describes (srs FR-ERR-012). `failed` said only
                # "something broke", which for a refusal is both wrong and an
                # invitation to retry. This is the surface that matters on
                # message/send, where the response is a JSON-RPC `result` and the
                # error code never reaches the caller at all.
                self._notify("working", "rejected")
                await self._reject(context, event_queue, self._failure_text(exc))
            else:
                logger.exception("Execution failed for task %s skill %s", context.task_id, skill_id)
                self._notify("working", "failed")
                await self._fail(context, event_queue, self._failure_text(exc))

    async def _execute_streaming(
        self,
        context: RequestContext,
        event_queue: EventQueue,
        skill_id: str,
        inputs: Any,
        apcore_ctx: Any,
        context_id: str,
        stopped: asyncio.Event,
    ) -> None:
        """Stream artifacts. The task owner publishes the terminal status."""
        artifact_id = f"art-{context.task_id or str(uuid4())}"
        chunk_index = 0
        # Mirror TS's `apcoreCtx ? ...with ctx : ...without ctx`: only pass the
        # apcore context when present, so the degraded no-binding state still
        # streams instead of erroring on a None positional argument.
        stream = (
            self._executor.stream(skill_id, inputs, apcore_ctx)
            if apcore_ctx is not None
            else self._executor.stream(skill_id, inputs)
        )
        if inspect.isawaitable(stream):
            stream = await stream
        iterator = stream.__aiter__()
        token = getattr(apcore_ctx, "cancel_token", None)

        def stopping() -> bool:
            return stopped.is_set() or (token is not None and token.is_cancelled)

        exhausted = False
        try:
            async for chunk in iterator:
                # A producer may catch CancelledError and yield another chunk.
                if stopping():
                    return
                parts = self._part_converter.output_to_parts(chunk, context.task_id).parts
                await event_queue.enqueue_event(
                    TaskArtifactUpdateEvent(
                        task_id=context.task_id,
                        context_id=context_id,
                        artifact=Artifact(artifact_id=artifact_id, parts=parts),
                        append=(chunk_index > 0),
                        last_chunk=False,
                    )
                )
                chunk_index += 1
            exhausted = True
        finally:
            if not exhausted and (close := getattr(iterator, "aclose", None)) is not None:
                try:
                    await close()
                except Exception:
                    logger.warning("Stream cleanup failed for task %s", context.task_id, exc_info=True)

        if stopping():
            return
        # Emit last_chunk=True to signal stream end
        await event_queue.enqueue_event(
            TaskArtifactUpdateEvent(
                task_id=context.task_id,
                context_id=context_id,
                artifact=Artifact(artifact_id=artifact_id),
                append=True,
                last_chunk=True,
            )
        )

    async def _run_with_timeout(
        self,
        operation: Awaitable[_Result],
        task_id: str,
        run: _TaskExecution,
    ) -> _Result:
        """Bound the whole operation. Its cancellation cleanup runs separately."""
        work = run.work = asyncio.ensure_future(operation)
        try:
            done, _ = await asyncio.wait({work}, timeout=self._execution_timeout)
        except asyncio.CancelledError:
            run.stopped.set()
            self._stop_work(work, run.token, task_id)
            raise
        if work not in done:
            run.stopped.set()
            self._stop_work(work, run.token, task_id)
            raise TimeoutError
        return work.result()

    def _stop_work(self, work: asyncio.Future[Any], token: Any, task_id: str) -> None:
        if work in self._cleaning_up:
            return
        if token is not None:
            token.cancel()
        self._cleaning_up.add(work)

        def finished(task: asyncio.Future[Any]) -> None:
            self._cleaning_up.discard(task)
            if not task.cancelled() and (error := task.exception()) is not None:
                logger.warning("Execution cleanup failed for task %s", task_id, exc_info=error)

        work.add_done_callback(finished)
        work.cancel()

    async def _execute_single(self, skill_id: str, inputs: Any, apcore_ctx: Any) -> Any:
        """Single call_async() execution."""
        call_async = self._executor.call_async
        cache_key = getattr(call_async, "__qualname__", repr(call_async))
        accepts_ctx = self._context_accepts_cache.get(cache_key)
        if accepts_ctx is None:
            accepts_ctx = "context" in inspect.signature(call_async).parameters
            self._context_accepts_cache[cache_key] = accepts_ctx
        coro = (
            call_async(skill_id, inputs, apcore_ctx)
            if (apcore_ctx is not None and accepts_ctx)
            else call_async(skill_id, inputs)
        )
        return await coro

    async def _send_single(
        self,
        context: RequestContext,
        event_queue: EventQueue,
        skill_id: str,
        inputs: Any,
        apcore_ctx: Any,
        stopped: asyncio.Event,
        *,
        declaration: _ArtifactDeclaration | None = None,
    ) -> None:
        trace = None
        if declaration is not None:
            output, trace = await self._executor.call_async_with_trace(skill_id, inputs, apcore_ctx)
        else:
            output = await self._execute_single(skill_id, inputs, apcore_ctx)
        if stopped.is_set():
            return
        artifact = self._part_converter.output_to_parts(output, context.task_id)
        if (
            declaration is not None
            and self._artifact_links is not None
            and trace is not None
            and _validated_output(trace)
        ):
            await self._part_converter.add_artifact_links(artifact, output, declaration, self._artifact_links)
        if stopped.is_set():
            return
        await event_queue.enqueue_event(
            TaskArtifactUpdateEvent(
                task_id=context.task_id,
                context_id=context.context_id or context.task_id,
                artifact=artifact,
                last_chunk=True,
            )
        )

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        # The SDK may have read a nonterminal snapshot before the status was
        # persisted and our in-process claim retired. Recheck the authorized
        # store for those late cancellations.
        key = self._task_key(context)
        if key not in self._running and self._load_task is not None:
            current = await self._load_task(context.task_id, context.call_context)
            if current is not None and current.status.state in _TERMINAL_STATES:
                return
        if not await self._publish_status(
            context, event_queue, TaskState.TASK_STATE_CANCELED, "Canceled by client", stop_work=True
        ):
            # The SDK treats executor.cancel() exceptions as agent failures.
            # Let it consume the already-claimed outcome and classify the
            # cancellation at the RPC boundary instead.
            run = self._running.get(key)
            if run is not None and run.terminal is not None:
                await run.terminal_offer_finished.wait()
            return
        self._notify("working", "canceled")

    async def _emit_canceled(self, context: RequestContext, event_queue: EventQueue, message: str) -> None:
        """Emit CANCELED status (for cooperative cancellation via CancelToken)."""
        await self._publish_status(context, event_queue, TaskState.TASK_STATE_CANCELED, message)

    async def _publish_status(
        self,
        context: RequestContext,
        event_queue: EventQueue,
        state: int,
        message: str | None = None,
        *,
        stop_work: bool = False,
    ) -> bool:
        key = self._task_key(context)
        run = self._running.get(key)
        if key in self._pending_terminal or (run is not None and run.terminal is not None):
            return False
        status = _make_status(state, _text_message(message) if message is not None else None)
        if state in _TERMINAL_STATES:
            if self._track_terminal_status:
                self._pending_terminal[key] = status
            if run is not None:
                run.terminal = status
        if stop_work and run is not None:
            run.stopped.set()
            if run.work is not None and not run.work.done():
                self._stop_work(run.work, run.token, context.task_id)
            elif run.token is not None:
                run.token.cancel()
        event = TaskStatusUpdateEvent(task_id=key[0], context_id=key[1], status=status)
        if run is None or run.terminal is not status:
            await event_queue.enqueue_event(event)
            return True
        # A transport may cancel the producer first. Once this attempt has
        # claimed the outcome, preserve its terminal event through teardown.
        offer = asyncio.create_task(event_queue.enqueue_event(event))
        try:
            await asyncio.shield(offer)
        except asyncio.CancelledError:
            await offer
            raise
        finally:
            run.terminal_offer_finished.set()
        return True

    def _failure_text(self, error: Exception) -> str:
        """Caller-facing text for a FAILED task status.

        Delegates to the injected ``ErrorMapper``, this package's single
        error-redaction policy, so the task-status surface classifies exactly
        like the JSON-RPC surface instead of collapsing every code to one
        string:

        - internal / unrecognized errors keep the fixed ``"Internal server
          error"`` (srs FR-ERR-004 / FR-ERR-008, locked by the shared
          ``error_mapping.json`` and ``streaming_events.json`` fixtures);
        - ``ACL_DENIED`` carries the fixed ``"Access denied"`` message (srs FR-ERR-003);
        - caller-fixable classes (schema validation, invalid input, unknown
          module) carry their sanitized detail, which srs FR-ERR-002 requires
          precisely so a caller "can correct their input without guessing".

        For those detail-carrying classes the error's ``ai_guidance`` is
        appended when apcore supplied one: it exists to tell an agent what to do
        next, and an A2A caller sees only this status message. It is withheld
        for every other class, where the message is a fixed per-class string
        that must stay fixed.

        The gate is :func:`~apcore_a2a.adapters.errors.carries_caller_detail` —
        the same partition ``ErrorMapper`` itself branches on. Gating on
        ``error.user_fixable`` instead would be a different partition: six
        apcore codes are ``user_fixable=True`` yet fall into the mapper's
        catch-all, so e.g. a ``DEPENDENCY_NOT_FOUND`` failure would send the
        caller ``"Internal server error (module 'x' requires 'y' >= 2.1; ...)"``
        — the deliberately-opaque string extended with dependency-graph detail
        that :func:`~apcore_a2a.adapters.errors.sanitize_message` does not strip
        (it removes only paths and traceback-shaped lines, not module ids,
        versions, env-var names or hostnames). ``user_fixable`` is settable
        per-error by the module author, so any module could widen the fixed
        string further.
        """
        message = str(self._error_mapper.to_jsonrpc_error(error).get("message", ""))
        guidance = getattr(error, "ai_guidance", None)
        disclose = getattr(self._error_mapper, "disclose_refusal_reason", False)
        if carries_caller_detail(error, disclose) and isinstance(guidance, str) and guidance.strip():
            return f"{message} ({sanitize_message(guidance)})"
        return message

    async def _fail(self, context: RequestContext, event_queue: EventQueue, message: str) -> None:
        await self._publish_status(context, event_queue, TaskState.TASK_STATE_FAILED, message)

    async def _reject(self, context: RequestContext, event_queue: EventQueue, message: str) -> None:
        """Emit REJECTED status for a governance refusal (srs FR-ERR-012)."""
        await self._publish_status(context, event_queue, TaskState.TASK_STATE_REJECTED, message)

    async def _input_required(self, context: RequestContext, event_queue: EventQueue, message: str) -> None:
        await self._publish_status(context, event_queue, TaskState.TASK_STATE_INPUT_REQUIRED, message)
