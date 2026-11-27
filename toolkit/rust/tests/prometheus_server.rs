#![cfg(feature = "prometheus-server")]

use apcore_toolkit::PrometheusServer;
use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::{timeout, Duration};

const LOOPBACK: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);

async fn request(address: SocketAddr, method: &str, path: &str) -> String {
    timeout(Duration::from_secs(5), async {
        let mut connection = TcpStream::connect(address).await.unwrap();
        connection
            .write_all(format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut response = String::new();
        connection.read_to_string(&mut response).await.unwrap();
        response
    })
    .await
    .unwrap()
}

fn split_response(response: &str) -> (&str, &str) {
    response.split_once("\r\n\r\n").unwrap()
}

#[tokio::test]
async fn serves_the_supplied_metrics_text_with_routes_and_live_readiness() {
    const METRICS: &str =
        "# TYPE example_calls_total counter\nexample_calls_total{site=\"\u{8bfe}\u{5802}\"} 1\n";
    let has_metrics = Arc::new(AtomicBool::new(false));
    let ready = Arc::new(AtomicBool::new(false));
    let mut server = PrometheusServer::new({
        let has_metrics = Arc::clone(&has_metrics);
        move || {
            if has_metrics.load(Ordering::Relaxed) {
                METRICS.to_string()
            } else {
                String::new()
            }
        }
    })
    .with_metrics_path("/custom")
    .with_readiness({
        let ready = Arc::clone(&ready);
        move || ready.load(Ordering::Relaxed)
    })
    .listen(LOOPBACK)
    .await
    .unwrap();
    let address = server.local_addr();

    let cold = request(address, "GET", "/custom?collect[]=go").await;
    let (headers, body) = split_response(&cold);
    assert!(headers.starts_with("HTTP/1.1 200 OK"));
    assert!(headers
        .to_ascii_lowercase()
        .contains("content-type: text/plain; version=0.0.4; charset=utf-8"));
    assert!(body.is_empty());

    has_metrics.store(true, Ordering::Relaxed);
    let populated = request(address, "GET", "/custom").await;
    let (headers, body) = split_response(&populated);
    assert_eq!(body, METRICS);
    assert!(headers
        .to_ascii_lowercase()
        .contains(&format!("content-length: {}", METRICS.len())));

    assert!(request(address, "GET", "/metrics").await.contains("404"));
    let rejected = request(address, "POST", "/custom").await;
    assert!(rejected.starts_with("HTTP/1.1 405"));
    assert!(rejected.to_ascii_lowercase().contains("allow: get"));
    assert!(request(address, "GET", "/healthz?probe")
        .await
        .starts_with("HTTP/1.1 200"));
    assert!(request(address, "GET", "/readyz")
        .await
        .starts_with("HTTP/1.1 503"));
    ready.store(true, Ordering::Relaxed);
    assert!(request(address, "GET", "/readyz?probe")
        .await
        .starts_with("HTTP/1.1 200"));

    let bind_error = PrometheusServer::new(String::new)
        .listen(address)
        .await
        .unwrap_err();
    assert_eq!(bind_error.kind(), ErrorKind::AddrInUse);
    server.close().await.unwrap();
    server.close().await.unwrap();
    assert_eq!(
        TcpStream::connect(address).await.unwrap_err().kind(),
        ErrorKind::ConnectionRefused
    );
}

#[tokio::test]
async fn close_stops_accepting_and_drains_an_in_flight_response() {
    const LENGTH: usize = 8 * 1024 * 1024;
    let mut server = PrometheusServer::new(|| "x".repeat(LENGTH))
        .listen(LOOPBACK)
        .await
        .unwrap();
    let address = server.local_addr();
    let mut connection = TcpStream::connect(address).await.unwrap();
    connection
        .write_all(b"GET /metrics HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await
        .unwrap();

    timeout(Duration::from_secs(5), async {
        let mut response = Vec::with_capacity(4096);
        connection.read_buf(&mut response).await.unwrap();
        assert!(!response.is_empty());
        let close = tokio::spawn(async move { server.close().await.unwrap() });
        loop {
            match TcpStream::connect(address).await {
                Err(error) if error.kind() == ErrorKind::ConnectionRefused => break,
                // Linux can reset a connection already queued when the listener closes.
                Err(error) if error.kind() == ErrorKind::ConnectionReset => {
                    tokio::task::yield_now().await;
                }
                Ok(_) => tokio::task::yield_now().await,
                Err(error) => panic!("unexpected connect error: {error}"),
            }
        }
        connection.read_to_end(&mut response).await.unwrap();
        let response = String::from_utf8(response).unwrap();
        let (headers, body) = split_response(&response);
        assert!(headers.starts_with("HTTP/1.1 200"));
        assert_eq!(body.len(), LENGTH);
        close.await.unwrap();
    })
    .await
    .unwrap();
}
