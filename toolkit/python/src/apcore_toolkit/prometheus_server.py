"""HTTP listener for application-owned Prometheus metrics."""

from __future__ import annotations

import logging
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_logger = logging.getLogger(__name__)
_PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"


class _PrometheusHTTPServer(ThreadingHTTPServer):
    # The inherited server_close() waits for these request handlers to exit.
    daemon_threads = False


def create_prometheus_server(
    render_metrics: Callable[[], str],
    *,
    host: str = "127.0.0.1",
    port: int = 9090,
    metrics_path: str = "/metrics",
    is_ready: Callable[[], bool] | None = None,
) -> ThreadingHTTPServer:
    """Bind a Prometheus listener without starting its serving loop.

    Call ``serve_forever()`` to serve requests. From another thread, call
    ``shutdown()`` to stop accepting work and ``server_close()`` to release
    the socket and wait for accepted requests to finish. The scrape path
    must be an absolute pathname distinct from the probe paths.
    """

    if (
        not metrics_path.startswith("/")
        or metrics_path in {"/healthz", "/readyz"}
        or any(character in "?#" or character.isspace() for character in metrics_path)
    ):
        raise ValueError("metrics_path must be an absolute pathname distinct from /healthz and /readyz")

    class Handler(BaseHTTPRequestHandler):
        def parse_request(self) -> bool:
            if not super().parse_request():
                return False
            if self.command == "GET":
                return True
            self.send_response(405)
            self.send_header("Allow", "GET")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return False

        def do_GET(self) -> None:  # noqa: N802
            path = self.path.partition("?")[0]
            if path == "/healthz":
                self._respond(200, b"OK")
                return
            try:
                if path == "/readyz":
                    ready = is_ready is not None and is_ready()
                    status, body, content_type = (200, b"OK", None) if ready else (503, b"Not ready", None)
                elif path == metrics_path:
                    status, body, content_type = 200, render_metrics().encode("utf-8"), _PROMETHEUS_CONTENT_TYPE
                else:
                    status, body, content_type = 404, b"", None
            except Exception:
                _logger.exception("Prometheus HTTP callback failed for %s", path)
                status, body, content_type = 500, b"", None
            self._respond(status, body, content_type)

        def _respond(self, status: int, body: bytes, content_type: str | None = None) -> None:
            self.send_response(status)
            if content_type is not None:
                self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            _logger.debug(format, *args)

    return _PrometheusHTTPServer((host, port), Handler)
