#![cfg(feature = "http-proxy")]

use std::sync::Arc;
use std::time::Duration;

use apcore::context::Context;
use apcore::Registry;
use apcore_toolkit::{
    detect_effective_proxy_hazards, EffectiveProxyHazardKind, HTTPProxyRegistryWriter,
    OpenAPIScanner, OpenApiParameterProblem, ScanOptions, ScannedModule,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

async fn scan(paths: Value) -> Vec<ScannedModule> {
    OpenAPIScanner::new()
        .scan_with_effective_parameters(
            &json!({"openapi": "3.1.0", "paths": paths}),
            &ScanOptions::new(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn reports_parameter_serializations_the_writer_cannot_preserve() {
    let modules = scan(json!({
        "/labels/{name}": {
            "parameters": [
                {"name":"name","in":"path","style":"label","required":true,"schema":{"type":"string"}}
            ],
            "get": {
                "operationId":"read_label",
                "parameters":[
                    {"name":"tags","in":"query","explode":false,
                     "schema":{"allOf":[{"type":"array","items":{"type":"string"}}]}},
                    {"name":"filters","in":"query","schema":{"oneOf":[{"type":"object"},{"type":"string"}]}},
                    {"name":"supported","in":"query","schema":{"type":"array","items":{"type":"string"}}},
                    {"name":"scalar","in":"query","explode":false,"schema":{"type":"string"}},
                    {"name":"unknown","in":"query","explode":false,"schema":true}
                ]
            }
        }
    })).await;
    let hazards = detect_effective_proxy_hazards(&modules);
    let findings: Vec<_> = hazards
        .iter()
        .filter_map(|hazard| match &hazard.kind {
            EffectiveProxyHazardKind::ParameterResolution {
                problem:
                    OpenApiParameterProblem::UnsupportedInput {
                        location,
                        name,
                        reason,
                        ..
                    },
            } => Some((location.as_str(), name.as_str(), reason.as_str())),
            _ => None,
        })
        .collect();
    assert_eq!(
        findings,
        [
            ("path", "name", "path_serialization"),
            ("query", "tags", "query_serialization"),
            ("query", "filters", "query_serialization"),
            ("query", "unknown", "query_serialization"),
        ]
    );
}

#[tokio::test]
async fn external_parameter_reference_never_reaches_serialized_diagnostics() {
    let modules = scan(json!({
        "/items":{"get":{"operationId":"items","parameters":[
            {"$ref":"https://example.invalid/contract?example_marker=sample"},
            {"$ref":"#/components/parameters/Absent"}
        ], "responses":{"200":{"description":"OK","content":{"application/json":{
            "schema":{"$ref":"https://example.invalid/schema?example_marker=sample"}
        }}}}}}
    }))
    .await;
    let hazards = detect_effective_proxy_hazards(&modules);
    assert_eq!(
        serde_json::to_value(&hazards[0]).unwrap()["kind"]["problem"]["reference"],
        "<external-ref>"
    );
    assert_eq!(
        serde_json::to_value(&hazards[1]).unwrap()["kind"]["problem"]["reference"],
        "#/components/parameters/Absent"
    );
    let metadata = serde_json::to_string(&modules[0].metadata).unwrap();
    assert!(!metadata.contains("example_marker"), "{metadata}");
    assert_eq!(
        modules[0].warnings,
        ["external $ref not fetched: <external-ref>"]
    );
}

#[tokio::test]
async fn rejects_invalid_effective_paths_without_echoing_raw_metadata() {
    let mut modules = scan(json!({"/stock":{"get":{"operationId":"stock"}}})).await;
    let writer = HTTPProxyRegistryWriter::new("http://127.0.0.1:1".to_string(), None, 1.0).unwrap();
    for path in [
        "stock",
        "//example.invalid/stock",
        "http://example.invalid/stock",
        "/stock?format=json",
        "/stock#page",
        "/\\stock",
        "/stock/{}",
        "/stock/{name",
    ] {
        modules[0]
            .metadata
            .insert("url_path".to_string(), json!(path));
        let hazards = detect_effective_proxy_hazards(&modules);
        assert_eq!(hazards.len(), 1, "{path}: {hazards:?}");
        assert_eq!(hazards[0].url_path, "?");
        assert!(matches!(
            &hazards[0].kind,
            EffectiveProxyHazardKind::MissingRouteMetadata { key } if key == "url_path"
        ));
        let registry = Registry::new();
        assert!(writer.write(&modules, &registry)[0]
            .verification_error
            .is_some());
        assert!(registry.get("stock").unwrap().is_none());
    }
}

#[tokio::test]
async fn effective_proxy_rejects_runtime_values_it_cannot_serialize() {
    let modules = scan(json!({
        "/items/{name}":{"get":{"operationId":"read_item","parameters":[
            {"name":"name","in":"path","required":true,"schema":true},
            {"name":"filters","in":"query","schema":true}
        ]}}
    }))
    .await;
    assert!(detect_effective_proxy_hazards(&modules).is_empty());
    let writer = HTTPProxyRegistryWriter::new("http://127.0.0.1:1".to_string(), None, 1.0).unwrap();
    let registry = Registry::new();
    assert!(writer.write(&modules, &registry)[0].verified);
    let context = Context::create(None, None, None, None, json!({}), None);
    let proxy = registry.get("read_item").unwrap().unwrap();
    for (input, expected) in [
        (json!({"name":["blue"]}), "Path parameter 'name' requires"),
        (
            json!({"name":"blue","filters":{"color":"green"}}),
            "Query parameter 'filters'",
        ),
    ] {
        let error = proxy.execute(input, &context).await.unwrap_err();
        assert!(error.to_string().contains(expected), "{error}");
    }
}

#[tokio::test]
async fn effective_route_transports_literal_colons_and_substitutes_brace_parameters() {
    let modules = scan(json!({
        "/inventory:search":{
            "get":{"operationId":"inventory_search"}
        },
        "/items/{name}:name":{
            "get":{"operationId":"read_item","parameters":[
                {"name":"name","in":"path","required":true,"schema":{"type":"string"}}
            ]}
        }
    }))
    .await;
    assert!(detect_effective_proxy_hazards(&modules).is_empty());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let writer = HTTPProxyRegistryWriter::new(
        format!("http://{}", listener.local_addr().unwrap()),
        None,
        1.0,
    )
    .unwrap();
    let registry = Arc::new(Registry::new());
    assert!(writer
        .write(&modules, &registry)
        .iter()
        .all(|result| result.verified));
    let context = Context::create(None, None, None, None, json!({}), None);
    for (id, input, expected) in [
        ("inventory_search", json!({}), "/inventory:search"),
        (
            "read_item",
            json!({"name":"red/blue"}),
            "/items/red%2Fblue:name",
        ),
    ] {
        let proxy = registry.get(id).unwrap().unwrap();
        let receive = async {
            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            let mut request_line = String::new();
            let mut header = String::new();
            reader.read_line(&mut request_line).await.unwrap();
            loop {
                header.clear();
                if reader.read_line(&mut header).await.unwrap() == 0 || header == "\r\n" {
                    break;
                }
            }
            reader.get_mut().write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
            ).await.unwrap();
            request_line
        };
        let (result, request_line) = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(proxy.execute(input, &context), receive)
        })
        .await
        .unwrap();
        result.unwrap();
        assert_eq!(request_line, format!("GET {expected} HTTP/1.1\r\n"));
    }
}
