use std::collections::HashMap;
use std::sync::Arc;

use apcore::{Context, Identity, Module, ModuleError, Registry};
use async_trait::async_trait;
use serde_json::{json, Value};

use crate::server::{server::ServerHandler, transport::McpHandler};
use crate::{APCoreMCP, MCPArtifactStore, AUTH_IDENTITY};

struct ArtifactModule {
    key: String,
    sensitive_key: String,
}

#[async_trait]
impl Module for ArtifactModule {
    fn input_schema(&self) -> Value {
        json!({"type":"object"})
    }

    fn output_schema(&self) -> Value {
        json!({"type":"object","properties": {
            "artifact": {"type":"string", "x-mcp-artifact":true},
            "duplicate": {"type":"string", "x-mcp-artifact":true},
            "sensitive": {"type":"string", "x-mcp-artifact":true, "x-sensitive":true},
            "url": {"type":"string", "x-mcp-artifact":true}
        }})
    }

    fn description(&self) -> &'static str {
        "Return a named artifact"
    }

    async fn execute(
        &self,
        _inputs: Value,
        _context: &Context<Value>,
    ) -> Result<Value, ModuleError> {
        Ok(
            json!({"artifact":self.key,"duplicate":self.key,"sensitive":self.sensitive_key,"url":"https://example.invalid/missing"}),
        )
    }
}

fn owner(roles: Vec<String>) -> Identity {
    Identity::new(
        "artifact-owner".into(),
        "user".into(),
        roles,
        HashMap::new(),
    )
}

async fn rpc(
    handler: &ServerHandler,
    method: &str,
    params: Value,
    identity: Option<Identity>,
) -> Value {
    AUTH_IDENTITY
        .scope(
            identity,
            handler.handle_message(json!({
                "jsonrpc":"2.0","id":1,"method":method,"params":params
            })),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn artifact_links_use_the_live_resource_route_and_preserve_legacy_content() {
    let store = Arc::new(MCPArtifactStore::default());
    let caller = owner(vec!["reader".into()]);
    let key = store
        .put(
            vec![0, 255, 1],
            "image.bin",
            "application/octet-stream",
            &caller,
        )
        .unwrap();
    let uri = format!("apcore-artifact://{key}");
    let sensitive_key = store
        .put(vec![42], "private.bin", "application/octet-stream", &caller)
        .unwrap();
    let registry = Arc::new(Registry::new());
    registry
        .register_module(
            "test.artifact",
            Box::new(ArtifactModule {
                key: key.clone(),
                sensitive_key,
            }),
        )
        .unwrap();
    let client = APCoreMCP::builder()
        .backend(registry)
        .artifact_store(store)
        .build()
        .unwrap();
    let (server, _, tools, options, _, _) = client.build_server_components().unwrap();
    let name = &tools
        .iter()
        .find(|tool| tool.output_schema.is_some())
        .unwrap()
        .name;
    let handler = ServerHandler::from_server(&server, options).unwrap();
    let params = json!({"name":name,"arguments":{},"_meta":{"mcpProtocolVersion":"2025-06-18"}});
    let response = rpc(&handler, "tools/call", params.clone(), Some(caller.clone())).await;
    let result = &response["result"];
    assert_eq!(result["structuredContent"]["artifact"], key);
    assert_eq!(result["content"][0]["type"], "text");
    assert_eq!(result["content"].as_array().unwrap().len(), 2);
    assert_eq!(
        result["content"][1],
        json!({"type":"resource_link","uri":uri,"name":"image.bin","mimeType":"application/octet-stream","size":3})
    );

    let read = rpc(
        &handler,
        "resources/read",
        json!({"uri":uri}),
        Some(caller.clone()),
    )
    .await;
    assert_eq!(
        read["result"]["contents"],
        json!([{"uri":uri,"mimeType":"application/octet-stream","blob":"AP8B"}])
    );
    for unauthorized in [None, Some(owner(vec!["writer".into()]))] {
        let read = rpc(
            &handler,
            "resources/read",
            json!({"uri":uri}),
            unauthorized.clone(),
        )
        .await;
        assert!(read.get("error").is_some());
        let response = rpc(&handler, "tools/call", params.clone(), unauthorized).await;
        assert_eq!(response["result"]["content"].as_array().unwrap().len(), 1);
    }
    let legacy = rpc(
        &handler,
        "tools/call",
        json!({"name":name,"arguments":{}}),
        Some(caller),
    )
    .await;
    assert!(legacy["result"].get("structuredContent").is_none());
    assert_eq!(legacy["result"]["content"].as_array().unwrap().len(), 1);
}
