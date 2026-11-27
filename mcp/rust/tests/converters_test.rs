//! Integration tests for the converters module.

mod common;

use apcore::module::ModuleAnnotations;
use apcore::registry::ModuleDescriptor;
use apcore_mcp::server::factory::MCPServerFactory;
use apcore_mcp::{AnthropicConverter, ConvertOptions, OpenAIConverter, SchemaConverter};
use serde_json::{json, Value};

#[test]
fn matches_the_shared_provider_tool_projection() {
    let Some(fixture) = common::load_fixture::<Value>("tool_projection.json") else {
        return;
    };
    let module = &fixture["module"];
    let id = module["module_id"].as_str().unwrap();
    let description = module["description"].as_str().unwrap();
    let mut descriptor: ModuleDescriptor = serde_json::from_value(module.clone()).unwrap();
    let expected = &fixture["expected"];
    let openai = OpenAIConverter::new();
    let default_chat = openai
        .convert_descriptor_with_options(id, module, description, ConvertOptions::default())
        .unwrap();
    assert_eq!(default_chat, expected["openai_chat"]);
    let loose_responses = openai
        .convert_responses_descriptor(
            id,
            module,
            description,
            ConvertOptions::default().with_strict(false),
        )
        .unwrap();
    assert_eq!(loose_responses, expected["openai_responses_non_strict"]);
    let mut strict_responses = expected["openai_chat"]["function"].clone();
    strict_responses["type"] = json!("function");
    assert_eq!(
        openai
            .convert_responses_descriptor(id, module, description, ConvertOptions::default())
            .unwrap(),
        strict_responses
    );
    assert_eq!(
        AnthropicConverter.convert_descriptor(&descriptor).unwrap(),
        expected["anthropic"]
    );

    let factory = MCPServerFactory::new();
    descriptor.annotations = Some(ModuleAnnotations {
        requires_approval: true,
        streaming: true,
        ..Default::default()
    });
    let tool = factory.build_tool(&descriptor, description, None).unwrap();
    assert_eq!(tool.name, id);
    assert_eq!(tool.input_schema, descriptor.input_schema);
    assert_eq!(tool.output_schema.as_ref(), Some(&descriptor.output_schema));
    assert_eq!(tool.meta.unwrap(), expected["mcp_meta"]);
    let annotations = serde_json::to_value(tool.annotations.unwrap()).unwrap();
    assert!(annotations.get("requiresApproval").is_none());
    assert!(annotations.get("streaming").is_none());
    descriptor.annotations = Some(ModuleAnnotations::default());
    assert!(factory
        .build_tool(&descriptor, description, None)
        .unwrap()
        .meta
        .is_none());

    descriptor.input_schema = fixture["recursive_input_schema"].clone();
    assert_eq!(
        AnthropicConverter.convert_descriptor(&descriptor).unwrap()["input_schema"],
        descriptor.input_schema
    );
    let recursive = openai
        .convert_descriptor_with_options(
            id,
            &json!({"input_schema": descriptor.input_schema}),
            description,
            ConvertOptions::default(),
        )
        .unwrap();
    assert_eq!(
        recursive.pointer("/function/parameters/$defs/node/properties/children/items/$ref"),
        Some(&json!("#/$defs/node"))
    );
}

// ---- SchemaConverter roundtrip tests ---------------------------------------

#[test]
fn schema_converter_empty_schema_becomes_object() {
    let schema = json!({});
    let result = SchemaConverter::convert_input_schema_strict(&schema, false).unwrap();
    assert_eq!(result, json!({"type": "object", "properties": {}}));
}

#[test]
fn schema_converter_null_schema_becomes_empty_object() {
    let result =
        SchemaConverter::convert_input_schema_strict(&serde_json::Value::Null, false).unwrap();
    assert_eq!(result, json!({"type": "object", "properties": {}}));
}

#[test]
fn schema_converter_strict_injects_additional_properties_false() {
    let schema = json!({
        "type": "object",
        "properties": {
            "x": {"type": "string"}
        }
    });
    let result = SchemaConverter::convert_input_schema(&schema).unwrap();
    assert_eq!(result["additionalProperties"], json!(false));
}

#[test]
fn schema_converter_non_strict_does_not_inject_additional_properties() {
    let schema = json!({
        "type": "object",
        "properties": {
            "x": {"type": "string"}
        }
    });
    let result = SchemaConverter::convert_input_schema_strict(&schema, false).unwrap();
    assert!(
        result.get("additionalProperties").is_none(),
        "non-strict mode must not inject additionalProperties"
    );
}

// ---- OpenAIConverter::convert_descriptor tests -----------------------------

#[test]
fn openai_converter_normalizes_dot_to_dash() {
    let converter = OpenAIConverter::new();
    let descriptor = json!({"input_schema": {}});
    let result = converter
        .convert_descriptor("math.add", &descriptor, "Add numbers", false, false)
        .unwrap();
    assert_eq!(result["function"]["name"], "math-add");
}

#[test]
fn openai_converter_strict_mode_adds_strict_flag() {
    let converter = OpenAIConverter::new();
    let descriptor = json!({
        "input_schema": {
            "type": "object",
            "properties": {
                "x": {"type": "number"}
            }
        }
    });
    let result = converter
        .convert_descriptor("math.add", &descriptor, "desc", false, true)
        .unwrap();
    assert_eq!(result["function"]["strict"], true);
    assert_eq!(
        result["function"]["parameters"]["additionalProperties"],
        false
    );
}

#[test]
fn openai_converter_convert_registry_empty_returns_empty() {
    let converter = OpenAIConverter::new();
    let registry = json!({});
    let result = converter
        .convert_registry_json(&registry, false, false, None, None)
        .unwrap();
    assert!(result.is_empty());
}

#[test]
fn openai_converter_convert_registry_single_module() {
    let converter = OpenAIConverter::new();
    let registry = json!({
        "text.upper": {
            "description": "Uppercase text",
            "input_schema": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"}
                },
                "required": ["text"]
            }
        }
    });
    let result = converter
        .convert_registry_json(&registry, false, false, None, None)
        .unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0]["function"]["name"], "text-upper");
    assert_eq!(result[0]["function"]["description"], "Uppercase text");
    assert_eq!(result[0]["function"]["parameters"]["type"], "object");
}

// ---- OC-5 regression: convert_registry must accept a live Registry ----------
// (CHANGELOG 0.14.0 — canonical Rust entrypoint takes &Registry, not &Value)

#[test]
fn openai_converter_convert_registry_takes_live_registry() {
    use apcore::registry::registry::Registry;
    use std::sync::Arc;

    // convert_registry must accept &Registry (canonical after OC-5 rename).
    // If this fails to compile, convert_registry_apcore was not renamed.
    let registry = Arc::new(Registry::default());
    let converter = OpenAIConverter::new();
    let result = converter
        .convert_registry(&registry, false, false, None, None)
        .unwrap();
    assert!(result.is_empty());
}

#[test]
fn openai_converter_convert_registry_json_takes_value() {
    // convert_registry_json must accept &Value (preserved legacy path).
    let registry = json!({});
    let converter = OpenAIConverter::new();
    let result = converter
        .convert_registry_json(&registry, false, false, None, None)
        .unwrap();
    assert!(result.is_empty());
}
