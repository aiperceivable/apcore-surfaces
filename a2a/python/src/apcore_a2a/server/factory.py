"""A2AServerFactory: wires all components into a Starlette ASGI app via a2a-sdk."""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import logging
import re
import secrets
import time
import warnings
from collections.abc import AsyncGenerator, Awaitable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, TypeVar

from a2a.server.context import ServerCallContext
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes, create_rest_routes
from a2a.server.tasks.inmemory_push_notification_config_store import (
    InMemoryPushNotificationConfigStore,
)
from a2a.server.tasks.inmemory_task_store import InMemoryTaskStore as A2ATaskStore
from a2a.types import (
    AgentCapabilities,
    AgentCard,
    CancelTaskRequest,
    GetTaskRequest,
    ListTasksRequest,
    ListTasksResponse,
    SendMessageRequest,
    Task,
    TaskState,
    TaskStatusUpdateEvent,
)
from a2a.utils.constants import DEFAULT_LIST_TASKS_PAGE_SIZE
from a2a.utils.errors import InvalidParamsError, TaskNotCancelableError, TaskNotFoundError
from apcore.error_formatter import ErrorFormatterRegistry
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from apcore_a2a._config import register_a2a_namespace
from apcore_a2a.adapters.agent_card import AgentCardBuilder
from apcore_a2a.adapters.card_visibility import build_extended_card, build_public_card, scoped_skill_callable
from apcore_a2a.adapters.errors import ErrorMapper
from apcore_a2a.adapters.parts import PartConverter
from apcore_a2a.adapters.schema import SchemaConverter
from apcore_a2a.adapters.skill_mapper import SkillMapper
from apcore_a2a.artifacts import ArtifactLinkPolicy
from apcore_a2a.server.context import (
    TASK_OWNER_KEY,
    TASK_SKILL_KEY,
    AuthIdentityServerCallContextBuilder,
    anonymous_context,
    scoped_owner,
)
from apcore_a2a.server.context import (
    identity_of as _identity_of,
)
from apcore_a2a.server.executor import _TERMINAL_STATES, ApCoreAgentExecutor

if TYPE_CHECKING:
    from a2a.server.cluster.task_store import StoredTask
    from a2a.server.cluster.version import TaskVersion
    from a2a.server.events import Event

try:
    from a2a.server.cluster.task_store import VersionedTaskStore as _SDKVersionedTaskStore
except ImportError:

    class _SDKVersionedTaskStore:
        """Placeholder for SDK releases without versioned stores."""


logger = logging.getLogger(__name__)
_SaveResult = TypeVar("_SaveResult")
_SCOPED_PAGE_TOKEN = re.compile(r"v1\.([1-9][0-9]{0,14})\.([0-9a-f]{64})")
_SCOPED_SCAN_PAGE_SIZE = 100


class _ObservedTaskStore:
    """Observe durable acknowledgments while preserving the supplied store's context."""

    def __init__(self, store: Any, executor: ApCoreAgentExecutor) -> None:
        self._store = store
        self._executor = executor
        self._page_token_key = secrets.token_bytes(32)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._store, name)

    def _can_read(self, task: Task, context: ServerCallContext) -> bool:
        identity = _identity_of(context)
        owner = scoped_owner(identity)
        recorded_owner = dict(task.metadata).get(TASK_OWNER_KEY)
        if owner != recorded_owner:
            return False
        if owner is None:
            return True
        skill = dict(task.metadata).get(TASK_SKILL_KEY)
        return isinstance(skill, str) and scoped_skill_callable(self._executor._executor, skill, identity)

    def _visible_page(self, page: ListTasksResponse, context: ServerCallContext) -> ListTasksResponse:
        visible = [task for task in page.tasks if self._can_read(task, context)]
        if len(visible) == len(page.tasks):
            return page
        response = ListTasksResponse()
        response.CopyFrom(page)
        del response.tasks[:]
        response.tasks.extend(visible)
        response.total_size = len(visible)
        if page.tasks and not self._can_read(page.tasks[-1], context):
            response.ClearField("next_page_token")
        return response

    async def get(self, task_id: str, context: ServerCallContext) -> Task | None:
        task = await self._store.get(task_id, context)
        return task if task is not None and self._can_read(task, context) else None

    async def list(self, params: ListTasksRequest, context: ServerCallContext) -> ListTasksResponse:
        identity = _identity_of(context)
        if scoped_owner(identity) is None:
            return self._visible_page(await self._store.list(params, context), context)
        return await self._list_scoped(params, context, identity.authority_key())

    async def _list_scoped(
        self, params: ListTasksRequest, context: ServerCallContext, authority: str
    ) -> ListTasksResponse:
        page_size = params.page_size or DEFAULT_LIST_TASKS_PAGE_SIZE
        if page_size < 1:
            raise InvalidParamsError(message="pageSize must be a positive integer")

        query = ListTasksRequest()
        query.CopyFrom(params)
        query.ClearField("page_token")
        query.ClearField("page_size")
        principal = json.dumps([context.tenant, authority]).encode()
        binding = principal + b"\0" + query.SerializeToString(deterministic=True)
        offset = 0
        if params.page_token:
            cursor = _SCOPED_PAGE_TOKEN.fullmatch(params.page_token)
            if cursor is None or not hmac.compare_digest(cursor[2], self._sign_offset(binding, cursor[1])):
                raise InvalidParamsError(message="Invalid page token")
            offset = int(cursor[1])

        # Page and count the visible results, never expose storage cursors or counts.
        query.page_size = _SCOPED_SCAN_PAGE_SIZE
        tasks = []
        visible_total = 0
        seen_tokens: set[str] = set()
        while True:
            page = await self._store.list(query, context)
            for task in page.tasks:
                if self._can_read(task, context):
                    if offset <= visible_total < offset + page_size:
                        tasks.append(task)
                    visible_total += 1
            if not page.next_page_token:
                break
            if page.next_page_token in seen_tokens:
                raise RuntimeError("TaskStore repeated a pagination token")
            seen_tokens.add(page.next_page_token)
            query.page_token = page.next_page_token

        next_offset = offset + len(tasks)
        next_token = (
            f"v1.{next_offset}.{self._sign_offset(binding, str(next_offset))}" if next_offset < visible_total else ""
        )
        return ListTasksResponse(tasks=tasks, page_size=page_size, total_size=visible_total, next_page_token=next_token)

    def _sign_offset(self, binding: bytes, offset: str) -> str:
        return hmac.digest(self._page_token_key, offset.encode("ascii") + b"\0" + binding, "sha256").hex()

    async def save(self, task: Task, context: ServerCallContext) -> None:
        await self._save(task, context, self._store.save(task, context))

    async def _save(self, task: Task, context: ServerCallContext, save: Awaitable[_SaveResult]) -> _SaveResult:
        try:
            result = await save
        except (Exception, asyncio.CancelledError):
            self._executor.observe_task_save_failed(task, context)
            raise
        self._executor.observe_task_saved(task, context)
        return result


class _ObservedVersionedTaskStore(_ObservedTaskStore, _SDKVersionedTaskStore):
    async def save(
        self,
        task: Task,
        *,
        event: Event | None,
        prev: Task | None,
        prev_version: TaskVersion,
        context: ServerCallContext,
    ) -> TaskVersion:
        return await self._save(
            task, context, self._store.save(task, event=event, prev=prev, prev_version=prev_version, context=context)
        )

    async def get(self, task_id: str, context: ServerCallContext) -> StoredTask | None:
        record = await self._store.get(task_id, context)
        return record if record is not None and self._can_read(record.task, context) else None

    async def delete(self, task_id: str, context: ServerCallContext) -> None:
        await self._store.delete(task_id, context)


class _TerminalAwareRequestHandler(DefaultRequestHandler):
    async def _check_scoped_continuation(self, params: SendMessageRequest, context: ServerCallContext) -> None:
        task_id = params.message.task_id
        if not task_id or scoped_owner(_identity_of(context)) is None:
            return
        stored = await self.task_store.get(task_id, context)
        if stored is None:
            raise TaskNotFoundError
        task = stored.task if not isinstance(stored, Task) else stored
        if dict(task.metadata).get(TASK_SKILL_KEY) != dict(params.message.metadata).get("skillId"):
            raise InvalidParamsError(message="A scoped task continuation must use the original skill")

    async def on_message_send(self, params: SendMessageRequest, context: ServerCallContext) -> Any:
        await self._check_scoped_continuation(params, context)
        return await super().on_message_send(params, context)

    async def on_message_send_stream(
        self, params: SendMessageRequest, context: ServerCallContext
    ) -> AsyncGenerator[Event, None]:
        await self._check_scoped_continuation(params, context)
        task_id: str | None = None
        reported_outcome = False
        async with contextlib.aclosing(super().on_message_send_stream(params, context)) as stream:
            async for event in stream:
                if isinstance(event, Task):
                    task_id = event.id
                if isinstance(event, (Task, TaskStatusUpdateEvent)):
                    reported_outcome |= (
                        event.status.state in _TERMINAL_STATES
                        or event.status.state == TaskState.TASK_STATE_INPUT_REQUIRED
                    )
                yield event

        if task_id is None or reported_outcome:
            return
        # The SDK disconnects slow subscribers when their queue fills. After an
        # otherwise clean EOF, recover an already-settled terminal through the
        # same identity-scoped path as GetTask.
        task = await self.on_get_task(GetTaskRequest(id=task_id), context)
        if task is not None and task.status.state in _TERMINAL_STATES:
            yield TaskStatusUpdateEvent(task_id=task.id, context_id=task.context_id, status=task.status)

    async def on_get_task(self, params: GetTaskRequest, context: ServerCallContext) -> Task | None:
        task = await super().on_get_task(params, context)
        if task is not None:
            task = self.agent_executor.project_terminal_status(task, context)
        return task

    async def on_cancel_task(self, params: CancelTaskRequest, context: ServerCallContext) -> Task | None:
        task = await super().on_cancel_task(params, context)
        if task is not None and task.status.state != TaskState.TASK_STATE_CANCELED:
            raise TaskNotCancelableError(message="Task already has a terminal outcome")
        return task


@dataclass
class _MetricsState:
    """Simple in-process counters for the A2A ``/metrics`` endpoint.

    These count A2A *task-state transitions* (submitted/working/completed/...)
    on the wire protocol, which is a distinct concern from apcore's per-module
    observability metrics (latency, error rates) collected via
    ``ObsLoggingMiddleware`` / ``ErrorHistoryMiddleware``. The two are
    intentionally separate: this surfaces A2A protocol state, apcore surfaces
    module-execution telemetry.
    """

    active_tasks: int = 0
    completed_tasks: int = 0
    failed_tasks: int = 0
    canceled_tasks: int = 0
    input_required_tasks: int = 0
    total_requests: int = 0

    def __post_init__(self) -> None:
        # D1: use __post_init__ so _start_time is not exposed as a dataclass field
        self._start_time: float = time.monotonic()

    def uptime_seconds(self) -> float:
        return time.monotonic() - self._start_time

    def on_state_transition(self, old_state: str, new_state: str) -> None:
        """Update counters on task state change."""
        _active = {"submitted", "working", "input-required", "input_required"}
        _was_active = old_state in _active
        _now_active = new_state in _active

        if not _was_active and _now_active:
            self.active_tasks += 1
        elif _was_active and not _now_active:
            self.active_tasks = max(0, self.active_tasks - 1)

        if new_state == "completed":
            self.completed_tasks += 1
        elif new_state == "failed":
            self.failed_tasks += 1
        elif new_state == "canceled":
            self.canceled_tasks += 1
        elif new_state in ("input_required", "input-required"):
            self.input_required_tasks += 1


def _build_health_handler(task_store: Any, registry: Any, metrics: _MetricsState, version: str) -> Any:
    """Return a Starlette endpoint that serves /health."""

    async def handle_health(request: Request) -> JSONResponse:
        module_count = 0
        if registry is not None:
            with contextlib.suppress(Exception):
                module_count = len(registry.list())

        # Probe the store — a2a-sdk 1.0 requires a ServerCallContext argument.
        # Explicitly the anonymous owner bucket: the probe must not read a
        # principal's tasks, and the id it asks for exists in no bucket anyway.
        ctx = anonymous_context()
        try:
            await task_store.get("__health_probe__", ctx)
        except Exception as e:
            return JSONResponse(
                {
                    "status": "unhealthy",
                    "reason": f"Task store unavailable: {e}",
                    "uptime_seconds": metrics.uptime_seconds(),
                    "module_count": module_count,
                    "version": version,
                },
                status_code=503,
            )

        return JSONResponse(
            {
                "status": "healthy",
                "uptime_seconds": metrics.uptime_seconds(),
                "module_count": module_count,
                "version": version,
            }
        )

    return handle_health


def _build_metrics_handler(metrics: _MetricsState) -> Any:
    """Return a Starlette endpoint that serves /metrics."""

    async def handle_metrics(request: Request) -> JSONResponse:
        return JSONResponse(
            {
                "active_tasks": metrics.active_tasks,
                "completed_tasks": metrics.completed_tasks,
                "failed_tasks": metrics.failed_tasks,
                "canceled_tasks": metrics.canceled_tasks,
                "input_required_tasks": metrics.input_required_tasks,
                "total_requests": metrics.total_requests,
                "uptime_seconds": metrics.uptime_seconds(),
            }
        )

    return handle_metrics


class _RequestCountMiddleware(BaseHTTPMiddleware):
    """Starlette middleware that increments metrics.total_requests on each POST."""

    def __init__(self, app: Any, metrics: _MetricsState, **kwargs: Any) -> None:
        super().__init__(app, **kwargs)
        self._metrics = metrics

    async def dispatch(self, request: Request, call_next: Any) -> Any:
        if request.method == "POST":
            self._metrics.total_requests += 1
        return await call_next(request)


def _warn_on_unprotected_control_surface(executor: Any) -> None:
    """Warn when ``system.control.*`` is served with nothing gating it (srs FR-AGC-007).

    Reads apcore's ``Executor.governance_state()`` (apcore ``PROTOCOL_SPEC``
    §6.6.5), which answers "is a gate *engaging*" rather than "is an ACL
    *attached*" — the ACL and approval gates are pipeline *steps*, and the
    ``internal``, ``testing`` and ``minimal`` strategies remove them, so an
    executor can hold an ACL that no step ever consults. Re-deriving the question
    from the raw ``acl`` / ``approval_handler`` attributes would answer the wrong
    one.

    The public Agent Card omits ``system.*`` (FR-AGC-003 criterion 12).
    Registered controls still have dispatch routes. Core's default approval
    gate fails closed for annotated controls without a handler. Explicit
    non-strict policies or strategies without governance gates can leave
    controls unprotected.
    A failure to read the diagnostic must never stop a server from starting.
    """
    accessor = getattr(executor, "governance_state", None)
    if not callable(accessor):
        return
    try:
        state = accessor()
    except Exception:  # pragma: no cover - a diagnostic must never break startup
        logger.debug("governance_state() raised; skipping the control-surface check", exc_info=True)
        return
    # `is True` and not truthiness: a test double answers every attribute with a
    # truthy stand-in, and a diagnostic that cries wolf in every suite is one
    # nobody reads.
    if getattr(state, "unprotected_control_surface", None) is True:
        logger.warning(
            "apcore system.control.* modules are registered and no built-in governance gate "
            "engages for them (no ACL, no ApprovalHandler, or a strategy without the gates). "
            "They are withheld from the public Agent Card but remain callable. Configure an "
            "acl/ directory, an ApprovalHandler, or ExecutionPolicy(strict=True)."
        )


class A2AServerFactory:
    def __init__(self) -> None:
        self._schema_converter = SchemaConverter()
        self._skill_mapper = SkillMapper(self._schema_converter)
        self._agent_card_builder = AgentCardBuilder(self._skill_mapper)
        # Replaced in create() once `disclose_refusal_reason` is known; kept
        # here so the attribute exists for callers that inspect the factory.
        self._error_mapper = ErrorMapper()
        self._part_converter = PartConverter(self._schema_converter)

        # apcore 0.22.0: register config namespace and error formatter
        register_a2a_namespace()
        try:
            ErrorFormatterRegistry.register("a2a", self._error_mapper)
        except Exception:
            # Already registered (e.g. multiple factory instances in tests)
            logger.debug("Error formatter 'a2a' already registered")

    def create(
        self,
        registry: Any,
        executor: Any,
        *,
        name: str,
        description: str,
        version: str,
        url: str,
        task_store: Any | None = None,
        auth: Any | None = None,
        push_notifications: bool = False,
        cancel_on_disconnect: bool = True,
        execution_timeout: int = 300,
        cors_origins: list[str] | None = None,
        explorer: bool = False,
        explorer_prefix: str = "/explorer",
        metrics: bool = False,
        sys_modules: bool = False,
        disclose_refusal_reason: bool = False,
        artifact_links: ArtifactLinkPolicy | None = None,
    ) -> tuple[Starlette, AgentCard]:
        """Build ASGI app and AgentCard. Returns (app, agent_card).

        Task scoping: every task-addressed method is scoped to the authenticated
        principal by a2a-sdk's owner-resolving stores, driven by the
        ``ServerCallContext`` this factory builds from the authenticated
        ``Identity``. A supplied ``task_store`` therefore participates in
        enforcement, not just storage.

        **A custom ``task_store`` that ignores its ``ServerCallContext``
        argument disables task scoping entirely** — every caller sees every
        caller's tasks, as before this behaviour existed. a2a-sdk's own
        ``InMemoryTaskStore`` and ``DatabaseTaskStore`` both scope by
        ``OwnerResolver``; a third-party store must do the same. Upstream states
        the requirement as a SHOULD on the ``TaskStore`` contract, so it cannot
        be enforced here.

        While the SDK drains a backpressured event queue, authenticated
        ``GetTask`` requests can see a pending unsuccessful outcome in this
        server process. Successful completion becomes visible once the store
        persists it, and ``ListTasks`` reflects persisted results. The SDK
        continues draining after a stream disconnect. A store write failure
        remains an SDK persistence error. Until the store acknowledges the
        terminal write, the pending outcome exists only in this process.
        """
        # C3: cancel_on_disconnect is not used by DefaultRequestHandler; warn when False
        if not cancel_on_disconnect:
            warnings.warn(
                "cancel_on_disconnect=False has no effect; DefaultRequestHandler does not "
                "support disabling cancel-on-disconnect. This parameter will be removed in "
                "a future version.",
                DeprecationWarning,
                stacklevel=2,
            )

        # Store params for register_module()
        self._name = name
        self._description = description
        self._version = version
        self._url = url
        self._registry = registry
        # srs FR-ERR-011: the mapper decides whether a governance refusal
        # forwards apcore's own reason or the fixed per-class string. Off by
        # default; the *class* of refusal is conveyed either way.
        self._error_mapper = ErrorMapper(disclose_refusal_reason=disclose_refusal_reason)

        # Build security schemes — RAISES on failure (no silent except)
        security_schemes = None
        if auth is not None:
            security_schemes = auth.security_schemes()
        self._security_schemes = security_schemes

        # Build capabilities (a2a-sdk 1.0: no state_transition_history field)
        # `extended_agent_card` is advertised only when this binding actually
        # serves it (srs FR-AGC-006). With an authenticator configured the
        # extended card and its `extended_card_modifier` are both built below and
        # handed to `DefaultRequestHandler`, which is what routes the endpoint —
        # so the flag and the behaviour agree. Without one both stay `None`, the
        # endpoint is unrouted, and this stays false. A client is entitled to read
        # the flag and call the method (A2A §3.2.x), so advertising an unserved
        # capability is worse than not advertising it.
        capabilities = AgentCapabilities(
            streaming=True,
            push_notifications=push_notifications,
            extended_agent_card=(auth is not None),
        )
        self._capabilities = capabilities

        # P1-B: register system.* modules BEFORE building the AgentCard so they
        # are subject to the same visibility rules as every other skill.
        # Requires sys_modules=True and an executor that accepts .use() middleware.
        if sys_modules and hasattr(executor, "use"):
            try:
                from apcore.config import Config
                from apcore.sys_modules.registration import register_sys_modules

                # `sys_modules` is a TOP-LEVEL section of apcore's config
                # (apcore config.py DEFAULTS), and `register_sys_modules` reads
                # `config.get("sys_modules.enabled")` in legacy mode. Nesting it
                # under `apcore:` — as this did — meant the lookup missed, the
                # function returned at its first line, and `sys_modules=True`
                # registered nothing while the log below claimed it had
                # (apcore-a2a#5). Any operator settings found under either
                # spelling are carried through, top-level winning — apcore's own
                # `Registry` exposes no `config`, so this reads a host-supplied
                # one and is `{}` in the ordinary case. `sys_modules.events` has
                # no route in through this binding, so `sys_modules=True` alone
                # registers the six read modules and no `system.control.*`.
                registry_cfg: dict[str, Any] = getattr(registry, "config", {}) or {}
                nested_sys: dict[str, Any] = registry_cfg.get("apcore", {}).get("sys_modules", {})
                sys_data: dict[str, Any] = {
                    **registry_cfg,
                    "sys_modules": {
                        **nested_sys,
                        **registry_cfg.get("sys_modules", {}),
                        "enabled": True,
                    },
                }
                register_sys_modules(registry, executor, Config(data=sys_data))
            except Exception:
                logger.warning("register_sys_modules failed — continuing without sys modules", exc_info=True)
            else:
                # Reported separately from the call above, and never inside its
                # `try`: a registry that cannot be enumerated would otherwise be
                # logged as a registration failure — misattributing an outcome is
                # the defect apcore-a2a#5 was made of.
                try:
                    registered = sorted(m for m in registry.list() if m.startswith("system."))
                except Exception:  # pragma: no cover - enumeration is a log detail
                    logger.info("Registered apcore system modules")
                else:
                    logger.info("Registered apcore system modules: %s", ", ".join(registered) or "none")

        _warn_on_unprotected_control_surface(executor)

        # Build AgentCard AFTER sys_modules so sys.* skills are included when enabled.
        # This is the FULL card; the public and extended views are derived from
        # it below (srs FR-AGC-003 / FR-AGC-004).
        full_card = self._agent_card_builder.build(
            registry,
            name=name,
            description=description,
            version=version,
            url=url,
            capabilities=capabilities,
            security_schemes=security_schemes,
        )

        # The public card is filtered for the anonymous principal once, here,
        # rather than per request on an auth-exempt route. Before this, every
        # registered skill was advertised to any anonymous caller — id, name,
        # description and full input schema — with the ACL consulted nowhere.
        agent_card = build_public_card(full_card, executor, registry)
        self._agent_card = agent_card

        # C1: Build metrics state early so it can be wired into the executor
        metrics_state = _MetricsState()
        self._metrics_state = metrics_state

        # Build ApCoreAgentExecutor — C1: wire state-transition callback when metrics enabled
        on_state_change_cb = metrics_state.on_state_transition if metrics else None
        sdk_task_store = task_store if task_store is not None else A2ATaskStore()
        self._task_store = sdk_task_store

        async def load_task(task_id: str, context: ServerCallContext) -> Task | None:
            stored = await sdk_task_store.get(task_id, context)
            return stored.task if stored is not None and isinstance(sdk_task_store, _SDKVersionedTaskStore) else stored

        apcore_executor = ApCoreAgentExecutor(
            executor,
            self._part_converter,
            self._error_mapper,
            registry,
            execution_timeout,
            on_state_change=on_state_change_cb,
            artifact_links=artifact_links,
            track_terminal_status=True,
            load_task=load_task,
        )

        # P1-A: wire apcore observability middleware into the executor.
        # ObsLoggingMiddleware: structured per-call logging (always, low overhead).
        # ErrorHistoryMiddleware: tracks error patterns per module (only when metrics=True,
        # since register_sys_modules may already add it when sys_modules=True).
        if hasattr(executor, "use"):
            try:
                from apcore.observability.context_logger import ObsLoggingMiddleware

                executor.use(ObsLoggingMiddleware())
                if metrics and not sys_modules:
                    from apcore.middleware.error_history_middleware import ErrorHistoryMiddleware

                    executor.use(ErrorHistoryMiddleware())
            except Exception:
                logger.debug("Could not add observability middleware", exc_info=True)

        # Build push config store
        push_config_store = InMemoryPushNotificationConfigStore() if push_notifications else None

        # Build extended card (srs FR-AGC-004). It carries the FULL skill set,
        # narrowed per authenticated identity by `extended_card_modifier` on each
        # request — the a2a-sdk hook that makes a per-caller card possible at all,
        # since `extended_agent_card` itself is a static message.
        #
        # `build_extended` used to return `CopyFrom(base_card)`: a verbatim copy,
        # so a client that authenticated and asked for more saw exactly what it
        # had already been served.
        extended_card = None
        extended_card_modifier = None
        if auth is not None:
            extended_card = self._agent_card_builder.build_extended(base_card=full_card)

            async def extended_card_modifier(  # type: ignore[misc]
                card: Any, context: Any
            ) -> Any:
                return build_extended_card(card, executor, _identity_of(context))

        # Build DefaultRequestHandler (a2a-sdk 1.0: agent_card is required 3rd arg)
        handler = _TerminalAwareRequestHandler(
            agent_executor=apcore_executor,
            task_store=(
                _ObservedVersionedTaskStore(sdk_task_store, apcore_executor)
                if isinstance(sdk_task_store, _SDKVersionedTaskStore)
                else _ObservedTaskStore(sdk_task_store, apcore_executor)
            ),
            agent_card=agent_card,
            push_config_store=push_config_store,
            extended_agent_card=extended_card,
            extended_card_modifier=extended_card_modifier,
        )

        # Build custom routes (health, optional metrics, optional explorer)
        custom_routes: list[Any] = []
        health_handler = _build_health_handler(sdk_task_store, registry, metrics_state, version)
        custom_routes.append(Route("/health", endpoint=health_handler, methods=["GET"]))

        if metrics:
            metrics_handler = _build_metrics_handler(metrics_state)
            custom_routes.append(Route("/metrics", endpoint=metrics_handler, methods=["GET"]))

        if explorer:
            try:
                from apcore_a2a.explorer import create_explorer_mount  # type: ignore[import]

                # D3: pass handler so explorer has access to the request handler
                explorer_mount = create_explorer_mount(
                    agent_card,
                    handler,
                    explorer_prefix=explorer_prefix,
                    registry=registry,
                )
                custom_routes.append(explorer_mount)
            except Exception:
                logger.warning("Explorer not available", exc_info=True)

        # Build middleware — RAISES on failure (no silent except)
        middleware: list[Middleware] = []

        # C2: add request counter as a proper Starlette middleware (not raw ASGI wrapping)
        # Insert first so it is the outermost layer and counts all POST requests
        if metrics:
            middleware.append(Middleware(_RequestCountMiddleware, metrics=metrics_state))

        if auth is not None:
            from apcore_a2a.auth.middleware import AuthMiddleware

            exempt_paths = {
                "/.well-known/agent.json",
                "/.well-known/agent-card.json",
                "/health",
                "/metrics",
            }
            exempt_prefixes: set[str] = set()
            if explorer:
                exempt_prefixes.add(explorer_prefix)
            middleware.append(
                Middleware(
                    AuthMiddleware,
                    authenticator=auth,
                    exempt_paths=exempt_paths,
                    exempt_prefixes=exempt_prefixes,
                )
            )
        if cors_origins:
            middleware.append(
                Middleware(
                    CORSMiddleware,
                    allow_origins=cors_origins,
                    allow_methods=["GET", "POST"],
                    allow_headers=["*"],
                )
            )

        # Build Starlette app from routes directly (a2a-sdk 1.0 route functions)
        # Serve agent card at both A2A 1.0 path and legacy 0.3.x path for backward compat
        agent_card_routes = create_agent_card_routes(agent_card=agent_card)
        agent_card_routes_legacy = create_agent_card_routes(agent_card=agent_card, card_url="/.well-known/agent.json")
        # context_builder: bind the authenticated principal to the ServerCallContext
        # so a2a-sdk's owner-scoped stores scope every task-addressed method to
        # its owner. Without it every caller shares the UnauthenticatedUser
        # bucket and ListTasks returns every caller's tasks.
        context_builder = AuthIdentityServerCallContextBuilder()
        rest_routes = create_rest_routes(request_handler=handler, context_builder=context_builder)
        # enable_v0_3_compat: support legacy 0.3.x method names (message/send, tasks/get, etc.)
        jsonrpc_routes = create_jsonrpc_routes(
            request_handler=handler,
            rpc_url="/",
            context_builder=context_builder,
            enable_v0_3_compat=True,
        )

        # custom_routes first: REST routes include Mount /{tenant} which catches all paths
        # including /explorer, /health etc. if placed before them.
        all_routes = custom_routes + agent_card_routes + agent_card_routes_legacy + list(rest_routes) + jsonrpc_routes

        app = Starlette(routes=all_routes, middleware=middleware)

        return app, agent_card

    def register_module(self, module_id: str, descriptor: Any) -> None:
        """Runtime dynamic registration."""
        registry = getattr(self, "_registry", None)
        if registry is not None:
            registry.register(module_id, descriptor)
        # Invalidate card cache so card_modifier picks up new skills
        self._agent_card_builder.invalidate_cache()
        logger.info("Dynamically registered module: %s", module_id)
