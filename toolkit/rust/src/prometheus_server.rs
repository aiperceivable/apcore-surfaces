//! HTTP transport for a host-provided Prometheus text renderer.

use std::convert::Infallible;
use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::header::{HeaderValue, ALLOW, CONTENT_TYPE};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::timeout;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CONNECTIONS: usize = 64;
const MAX_REQUEST_BUFFER: usize = 8192;
const METRICS_CONTENT_TYPE: &str = "text/plain; version=0.0.4; charset=utf-8";
const TEXT_CONTENT_TYPE: &str = "text/plain; charset=utf-8";

/// Configures a metrics listener with liveness and readiness probes.
pub struct PrometheusServer {
    render_metrics: Box<dyn Fn() -> String + Send + Sync>,
    is_ready: Option<Box<dyn Fn() -> bool + Send + Sync>>,
    metrics_path: String,
}

impl PrometheusServer {
    /// Create a listener configuration. The renderer is called for each scrape.
    /// It runs synchronously on the Tokio runtime and must return without blocking.
    pub fn new(render_metrics: impl Fn() -> String + Send + Sync + 'static) -> Self {
        Self {
            render_metrics: Box::new(render_metrics),
            is_ready: None,
            metrics_path: "/metrics".into(),
        }
    }

    /// Set the exact scrape path. Query parameters on requests are ignored.
    #[must_use]
    pub fn with_metrics_path(mut self, path: impl Into<String>) -> Self {
        self.metrics_path = path.into();
        self
    }

    /// Check the host's current readiness for each probe. The default is false.
    /// The callback runs synchronously on the Tokio runtime and must not block.
    #[must_use]
    pub fn with_readiness(mut self, is_ready: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        self.is_ready = Some(Box::new(is_ready));
        self
    }

    /// Bind the given address and start serving requests in the current Tokio runtime.
    ///
    /// # Errors
    /// Returns an error if the path is invalid or reserved, or the address cannot be bound.
    pub async fn listen(self, address: SocketAddr) -> io::Result<PrometheusServerHandle> {
        let valid_path = self
            .metrics_path
            .parse::<hyper::http::uri::PathAndQuery>()
            .is_ok_and(|uri| uri.path() == self.metrics_path && uri.path().starts_with('/'));
        if !valid_path || matches!(self.metrics_path.as_str(), "/healthz" | "/readyz") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "metrics path must be an absolute path other than /healthz or /readyz",
            ));
        }
        let listener = TcpListener::bind(address).await?;
        let address = listener.local_addr()?;
        let (shutdown, receiver) = oneshot::channel();
        let worker = tokio::spawn(run_listener(listener, Arc::new(self), receiver));
        Ok(PrometheusServerHandle {
            address,
            shutdown: Some(shutdown),
            worker: Some(worker),
        })
    }

    fn response(&self, request: Request<Incoming>) -> Response<Full<Bytes>> {
        if request.method() != Method::GET {
            let mut response = response(StatusCode::METHOD_NOT_ALLOWED, TEXT_CONTENT_TYPE, "");
            response
                .headers_mut()
                .insert(ALLOW, HeaderValue::from_static("GET"));
            return response;
        }

        match request.uri().path() {
            path if path == self.metrics_path => response(
                StatusCode::OK,
                METRICS_CONTENT_TYPE,
                (self.render_metrics)(),
            ),
            "/healthz" => response(StatusCode::OK, TEXT_CONTENT_TYPE, "OK\n"),
            "/readyz" if self.is_ready.as_ref().is_some_and(|ready| ready()) => {
                response(StatusCode::OK, TEXT_CONTENT_TYPE, "OK\n")
            }
            "/readyz" => response(
                StatusCode::SERVICE_UNAVAILABLE,
                TEXT_CONTENT_TYPE,
                "Not ready\n",
            ),
            _ => response(StatusCode::NOT_FOUND, TEXT_CONTENT_TYPE, "Not Found\n"),
        }
    }
}

/// Owns the lifecycle of a bound Prometheus listener.
#[derive(Debug)]
pub struct PrometheusServerHandle {
    address: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    worker: Option<JoinHandle<io::Result<()>>>,
}

impl PrometheusServerHandle {
    /// Return the actual bound address, including a port selected by the OS.
    #[must_use]
    pub fn local_addr(&self) -> SocketAddr {
        self.address
    }

    /// Stop accepting and allow up to ten seconds for asynchronous connection I/O
    /// to drain. Synchronous renderer and readiness callbacks must return promptly.
    ///
    /// A repeated close returns successfully. Dropping this handle signals the
    /// same shutdown, while `close` waits for it to finish.
    ///
    /// # Errors
    /// Returns any listener error that ended the server.
    pub async fn close(&mut self) -> io::Result<()> {
        self.signal_shutdown();
        let Some(worker) = self.worker.as_mut() else {
            return Ok(());
        };
        let result = worker.await;
        self.worker = None;
        result.map_err(io::Error::other)?
    }

    fn signal_shutdown(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

impl Drop for PrometheusServerHandle {
    fn drop(&mut self) {
        self.signal_shutdown();
    }
}

async fn run_listener(
    listener: TcpListener,
    server: Arc<PrometheusServer>,
    mut shutdown: oneshot::Receiver<()>,
) -> io::Result<()> {
    let mut connections = JoinSet::new();
    let result = loop {
        tokio::select! {
            biased;
            _ = &mut shutdown => break Ok(()),
            Some(_) = connections.join_next() => {},
            accepted = listener.accept(), if connections.len() < MAX_CONNECTIONS => {
                match accepted {
                    Ok((stream, _)) => {
                        connections.spawn(serve_connection(stream, Arc::clone(&server)));
                    }
                    Err(error) => break Err(error),
                }
            }
        }
    };

    drop(listener);
    if timeout(REQUEST_TIMEOUT, async {
        while connections.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        connections.shutdown().await;
    }
    result
}

async fn serve_connection(stream: TcpStream, server: Arc<PrometheusServer>) {
    let service =
        service_fn(|request| std::future::ready(Ok::<_, Infallible>(server.response(request))));
    let connection = http1::Builder::new()
        .keep_alive(false)
        .header_read_timeout(None)
        .max_buf_size(MAX_REQUEST_BUFFER)
        .serve_connection(TokioIo::new(stream), service);
    match timeout(REQUEST_TIMEOUT, connection).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => tracing::debug!(%error, "Prometheus connection closed with an error"),
        Err(_) => tracing::debug!("Prometheus connection timed out"),
    }
}

fn response(
    status: StatusCode,
    content_type: &'static str,
    body: impl Into<Bytes>,
) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(body.into()));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
}
