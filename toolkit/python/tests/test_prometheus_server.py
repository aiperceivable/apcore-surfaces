"""HTTP-level compatibility for the standalone Prometheus listener."""

from __future__ import annotations

import socket
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from http.client import HTTPConnection
from http.server import HTTPServer
from threading import Event, Thread
from typing import Never

import pytest
from apcore.observability import MetricsCollector, PrometheusExporter, UsageCollector

from apcore_toolkit import create_prometheus_server


@contextmanager
def running(server: HTTPServer) -> Iterator[int]:
    with server:
        thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
        thread.start()
        try:
            yield server.server_port
        finally:
            server.shutdown()
            thread.join(timeout=3)


def request(port: int, path: str, method: str = "GET") -> tuple[int, dict[str, str], bytes]:
    client = HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        client.request(method, path)
        response = client.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        client.close()


@pytest.mark.parametrize("populated", [False, True])
def test_scrape_matches_legacy_http_response(populated: bool) -> None:
    metrics = MetricsCollector()
    usage = UsageCollector()
    if populated:
        metrics.increment("example_calls_total", {"site": "课堂"})
        metrics.observe("apcore_module_duration_seconds", {"module_id": "math.add"}, 0.01)
        usage.record(module_id="math.add", caller_id="client", latency_ms=10.0, success=True)
    exporter = PrometheusExporter(metrics, usage_collector=usage)
    exporter.start(port=0, path="/scrape")
    try:
        assert exporter._server is not None
        legacy_status, legacy_headers, legacy_body = request(exporter._server.server_port, "/scrape")
        with running(create_prometheus_server(exporter.export, port=0, metrics_path="/scrape")) as port:
            status, headers, body = request(port, "/scrape?format=prometheus")
            assert status == legacy_status == 200
            assert body == legacy_body == exporter.export().encode("utf-8")
            assert (
                headers["Content-Type"] == legacy_headers["Content-Type"] == "text/plain; version=0.0.4; charset=utf-8"
            )
            assert headers["Content-Length"] == str(len(body))
            assert request(port, "/metrics")[0] == 404
            assert request(port, "/scrape/")[0] == 404
    finally:
        exporter.stop()


def test_routes_readiness_and_rejects_non_get_requests() -> None:
    ready = Event()
    with running(create_prometheus_server(lambda: "example 1\n", port=0, is_ready=ready.is_set)) as port:
        assert request(port, "/healthz?probe=1")[::2] == (200, b"OK")
        assert request(port, "/readyz")[::2] == (503, b"Not ready")
        assert request(port, "/missing")[0] == 404
        ready.set()
        assert request(port, "/readyz?probe=1")[::2] == (200, b"OK")
        assert request(port, "/metrics")[::2] == (200, b"example 1\n")
        for method in ("HEAD", "POST", "OPTIONS", "PURGE"):
            status, headers, body = request(port, "/metrics", method=method)
            assert (status, headers["Allow"], body) == (405, "GET", b"")


@pytest.mark.parametrize("path", ["/healthz", "/readyz", "metrics", "/metrics?query", "/metrics#fragment"])
def test_invalid_metrics_paths_are_rejected_before_binding(path: str) -> None:
    with (
        pytest.raises(ValueError, match="absolute pathname"),
        create_prometheus_server(lambda: "", host="invalid host", metrics_path=path),
    ):
        pass


def test_bind_failure_and_callback_errors_are_visible() -> None:
    def fail() -> Never:
        raise RuntimeError("internal diagnostic")

    with running(create_prometheus_server(fail, port=0, is_ready=fail)) as port:
        with pytest.raises(OSError):
            create_prometheus_server(fail, port=port)
        assert request(port, "/metrics")[::2] == (500, b"")
        assert request(port, "/readyz")[::2] == (500, b"")
        assert request(port, "/healthz")[::2] == (200, b"OK")

    with running(create_prometheus_server(lambda: "", port=0)) as port:
        assert request(port, "/readyz")[::2] == (503, b"Not ready")


def test_shutdown_drains_existing_scrape_and_refuses_new_connections() -> None:
    entered = Event()
    release = Event()

    def render() -> str:
        entered.set()
        if not release.wait(3):
            raise TimeoutError("test did not release scrape")
        return "example 1\n"

    server = create_prometheus_server(render, port=0)
    with running(server) as port, ThreadPoolExecutor(max_workers=2) as pool:
        response = pool.submit(request, port, "/metrics")
        try:
            assert entered.wait(3)
            assert request(port, "/healthz")[0] == 200
            server.shutdown()
            closed = pool.submit(server.server_close)
            with pytest.raises(TimeoutError):
                closed.result(timeout=0.05)
        finally:
            release.set()
        assert response.result(timeout=3)[::2] == (200, b"example 1\n")
        closed.result(timeout=3)
    with pytest.raises(OSError), socket.create_connection(("127.0.0.1", port), timeout=3):
        pass
