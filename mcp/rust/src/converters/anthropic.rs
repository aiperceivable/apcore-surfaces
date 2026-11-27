//! Project APCore module descriptors into Anthropic Messages tools.

use apcore::registry::ModuleDescriptor;
use serde_json::{json, Value};

use crate::adapters::{AdapterError, ModuleIDNormalizer};

use super::prepare_llm_schema;

/// Convert one module descriptor to an Anthropic Messages tool.
#[derive(Default)]
pub struct AnthropicConverter;

impl AnthropicConverter {
    /// Preserve input constraints and include the descriptor's input examples.
    pub fn convert_descriptor(&self, descriptor: &ModuleDescriptor) -> Result<Value, AdapterError> {
        let mut schema = descriptor.input_schema.clone();
        prepare_llm_schema(&mut schema, true);
        let mut tool = json!({
            "name": ModuleIDNormalizer::normalize(&descriptor.module_id)?,
            "description": descriptor.description,
            "input_schema": schema,
        });
        if !descriptor.examples.is_empty() {
            tool["input_examples"] = Value::Array(
                descriptor
                    .examples
                    .iter()
                    .map(|example| example.inputs.clone())
                    .collect(),
            );
        }
        Ok(tool)
    }
}
