//! Converters sub-module — convert apcore registries to external tool formats.

pub mod anthropic;
pub mod openai;

// ---- Re-exports -------------------------------------------------------------
pub use anthropic::AnthropicConverter;
pub use openai::{ConverterError, OpenAIConverter};

use serde_json::Value;

fn prepare_llm_schema(schema: &mut Value, strip_extensions: bool) {
    let Some(schema) = schema.as_object_mut() else {
        return;
    };
    if let Some(description) = schema
        .get("x-llm-description")
        .filter(|value| value.is_string())
    {
        schema.insert("description".to_owned(), description.clone());
    }
    if strip_extensions {
        schema.retain(|key, _| !key.starts_with("x-"));
    }
    for key in [
        "properties",
        "patternProperties",
        "$defs",
        "definitions",
        "dependentSchemas",
    ] {
        if let Some(children) = schema.get_mut(key).and_then(Value::as_object_mut) {
            for child in children.values_mut() {
                prepare_llm_schema(child, strip_extensions);
            }
        }
    }
    for key in ["oneOf", "anyOf", "allOf", "prefixItems", "items"] {
        if let Some(children) = schema.get_mut(key) {
            if let Some(children) = children.as_array_mut() {
                for child in children {
                    prepare_llm_schema(child, strip_extensions);
                }
            } else if key == "items" {
                prepare_llm_schema(children, strip_extensions);
            }
        }
    }
    for key in [
        "not",
        "if",
        "then",
        "else",
        "contains",
        "propertyNames",
        "additionalProperties",
    ] {
        if let Some(child) = schema.get_mut(key) {
            prepare_llm_schema(child, strip_extensions);
        }
    }
}
