"""Check the alternate A2A subscriber through real configuration and HTTP."""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from contextlib import closing, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import Any

import pytest
from apcore.events import ApCoreEvent, EventEmitter, EventRetryConfig, SubscriberRegistry
from apcore.full import APCore, Config

from apcore_a2a import A2AEventSubscriber, register_a2a_subscriber

_FIXTURE = json.loads((Path(__file__).resolve().parents[3] / "conformance/fixtures/event_subscriber.json").read_text())
_DELIVERY_EVENTS = ("apcore.event.delivery_failed", "apcore.subscriber.circuit_opened")


class _DiagnosticSink:
    def __init__(self, event_pattern: str, events: list[ApCoreEvent]) -> None:
        self.event_pattern = event_pattern
        self._events = events

    async def on_event(self, event: ApCoreEvent) -> None:
        self._events.append(event)


@contextmanager
def _receiver(
    status: int = 204, delay_ms: int = 0
) -> Iterator[tuple[str, list[tuple[dict[str, str], dict[str, Any]]]]]:
    received: list[tuple[dict[str, str], dict[str, Any]]] = []

    class Receiver(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            headers = {key.lower(): value for key, value in self.headers.items()}
            received.append((headers, body))
            if delay_ms:
                time.sleep(delay_ms / 1000)
            self.send_response(status)
            self.end_headers()

        def log_message(self, format: str, *args: object) -> None:
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Receiver) as server:
        server.daemon_threads = False
        worker = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
        worker.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}/receive", received
        finally:
            server.shutdown()
            worker.join(timeout=3)


def _emit_from_config(
    path: Path,
    subscriber: dict[str, Any],
    registry: SubscriberRegistry,
) -> list[ApCoreEvent]:
    path.write_text(
        "version: '1.0.0'\nproject: {name: fixture}\n"
        "sys_modules:\n  enabled: true\n  events:\n    enabled: true\n"
        f"    subscribers: {json.dumps([subscriber])}\n"
    )
    events: list[ApCoreEvent] = []
    with closing(APCore(config=Config.load(str(path)), subscriber_registry=registry)) as core:
        assert core.events is not None
        for name in _DELIVERY_EVENTS:
            core.events.subscribe(_DiagnosticSink(name, events))
        core.events.emit(ApCoreEvent(**_FIXTURE["event"]))
        core.events.flush()
        core.events.flush()
    return events


@pytest.mark.parametrize("case", _FIXTURE["test_cases"], ids=lambda case: case["id"])
def test_event_subscriber_from_config(case: dict[str, Any], tmp_path: Path) -> None:
    with _receiver(case["status"], case.get("delay_ms", 0)) as (url, received):
        subscriber = dict(case["subscriber"])
        if subscriber["type"] == "filter":
            subscriber["delegate_config"] = {"platform_url": url}
        else:
            subscriber.update(platform_url=url, id="configured-a2a")

        registry = SubscriberRegistry()
        register_a2a_subscriber(registry)
        register_a2a_subscriber(registry)
        events = _emit_from_config(tmp_path / "apcore.yaml", subscriber, registry)

        expected = case["expected"]
        assert len(received) == expected["requests"]
        for headers, body in received:
            assert headers.get("content-type") == "application/json"
            assert headers.get("authorization") == expected.get("authorization")
            assert headers.get("x-source") == expected.get("source")
            assert body == {"skillId": expected["skill_id"], "event": _FIXTURE["event"]}
        event_types = [event.event_type for event in events]
        assert event_types.count("apcore.event.delivery_failed") == expected["dead_letters"]
        assert event_types.count("apcore.subscriber.circuit_opened") == expected["circuit_opened"]
        for event in events:
            assert event.data["subscriber_id"] == "configured-a2a"


def test_subscriber_factory_is_opt_in() -> None:
    config = {"type": "a2a", "platform_url": "https://example.com/receive"}
    registry = SubscriberRegistry()
    register_a2a_subscriber(registry)
    assert isinstance(registry.create(config), A2AEventSubscriber)
    with pytest.raises(ValueError, match="a2a"):
        SubscriberRegistry().create(config)


def test_two_hosts_keep_independent_subscriber_factories(tmp_path: Path) -> None:
    first, second = SubscriberRegistry(), SubscriberRegistry()
    register_a2a_subscriber(first)
    second.register(
        "a2a",
        lambda config: A2AEventSubscriber(config["platform_url"], skill_id="second.host"),
    )
    with _receiver() as (url, received):
        subscriber = {"type": "a2a", "platform_url": url}
        assert _emit_from_config(tmp_path / "first.yaml", subscriber, first) == []
        assert _emit_from_config(tmp_path / "second.yaml", subscriber, second) == []
        assert [payload["skillId"] for _, payload in received] == ["apevo.event_receiver", "second.host"]


async def test_zero_timeout_leaves_delivery_to_the_event_bus() -> None:
    with _receiver() as (url, received):
        subscriber = A2AEventSubscriber(url, timeout_ms=0)
        await subscriber.on_event(ApCoreEvent(**_FIXTURE["event"]))
        assert len(received) == 1


def test_transport_exposes_failure_to_event_emitter() -> None:
    with _receiver(status=503) as (url, received):
        subscriber = A2AEventSubscriber(url, retry=EventRetryConfig(max_attempts=2, initial_backoff_ms=1))
        emitter = EventEmitter()
        try:
            emitter.subscribe(subscriber)
            emitter.emit(ApCoreEvent(**_FIXTURE["event"]))
            emitter.flush()
        finally:
            emitter.shutdown()
        assert len(received) == 2
