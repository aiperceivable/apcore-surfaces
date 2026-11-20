//! Effective OpenAPI inputs shared by schema extraction and proxy diagnostics.

use std::collections::HashSet;

use indexmap::{map::Entry, IndexMap};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::openapi::{
    deep_resolve_schema_refs, display_effective_reference, extract_input_schema_from_parameters,
    resolve_local_pointer, SchemaReferenceMode,
};
use crate::ScannedModule;

/// Names exposed in the flat tool input, grouped by their OpenAPI origin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenApiProxyInputs {
    /// Effective path parameter names.
    pub path: Vec<String>,
    /// Effective query parameter names.
    pub query: Vec<String>,
    /// Properties of the JSON request body schema used by the scanner.
    pub body: Vec<String>,
    /// Resolution problems for this operation, including inherited problems.
    pub problems: Vec<OpenApiParameterProblem>,
}

impl OpenApiProxyInputs {
    pub(crate) const METADATA_KEY: &str = "proxy_inputs";
    const REQUIRED_BODY_KEY: &str = "required_json_body";

    fn metadata(module: &ScannedModule) -> Option<&Value> {
        module.metadata.get("openapi")?.get(Self::METADATA_KEY)
    }

    /// Read the routing inputs emitted by
    /// [the opt-in scanner](crate::OpenAPIScanner::scan_with_effective_parameters).
    ///
    /// `None` means the module does not carry this metadata. Malformed
    /// metadata returns an error so proxy consumers can distinguish the cases.
    pub fn from_module(module: &ScannedModule) -> Result<Option<Self>, serde_json::Error> {
        Self::metadata(module).map(Self::read_metadata).transpose()
    }

    fn read_metadata(value: &Value) -> Result<Self, serde_json::Error> {
        use serde::de::Error as _;

        if value
            .get(Self::REQUIRED_BODY_KEY)
            .is_some_and(|required| !required.is_boolean())
        {
            return Err(serde_json::Error::custom(
                "required_json_body must be a boolean",
            ));
        }
        let mut inputs = Self::deserialize(value)?;
        if inputs.problems.iter().any(|problem| {
            matches!(problem, OpenApiParameterProblem::UnsupportedInput {scope, location, ..}
                if *scope != OpenApiParameterScope::Operation
                    || !matches!(location.as_str(), "body" | "path" | "query"))
        }) {
            return Err(serde_json::Error::custom(
                "invalid unsupported input problem",
            ));
        }
        for problem in &mut inputs.problems {
            if let OpenApiParameterProblem::Reference { reference, .. } = problem {
                let redacted = display_effective_reference(reference);
                if reference != "<non-string>" && redacted != reference.as_str() {
                    *reference = redacted.to_string();
                }
            }
        }
        Ok(inputs)
    }

    #[cfg(feature = "http-proxy")]
    pub(crate) fn requires_json_body(module: &ScannedModule) -> bool {
        Self::metadata(module)
            .and_then(|value| value.get(Self::REQUIRED_BODY_KEY))
            .and_then(Value::as_bool)
            == Some(true)
    }
}

/// Where a parameter declaration appears.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenApiParameterScope {
    /// A shared parameter on the Path Item.
    PathItem,
    /// A parameter on one HTTP operation.
    Operation,
}

impl std::fmt::Display for OpenApiParameterScope {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::PathItem => "Path Item",
            Self::Operation => "operation",
        })
    }
}

/// A declaration the opt-in scanner could not include unambiguously.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OpenApiParameterProblem {
    /// The parameters member exists but is not an array.
    #[error("{scope} 'parameters' must be an array")]
    InvalidList { scope: OpenApiParameterScope },
    /// An entry is missing a valid name or location.
    #[error("{scope} parameter at index {index} has an invalid name or location")]
    InvalidParameter {
        scope: OpenApiParameterScope,
        index: usize,
    },
    /// A parameter reference could not be resolved locally.
    #[error(
        "{scope} parameter at index {index} has an unresolved reference '{reference}': {reason}"
    )]
    Reference {
        scope: OpenApiParameterScope,
        index: usize,
        reference: String,
        reason: String,
    },
    /// A parameter was declared twice at the same level.
    #[error("{scope} declares parameter '{name}' in '{location}' more than once")]
    Duplicate {
        scope: OpenApiParameterScope,
        name: String,
        location: String,
    },
    /// A declared input cannot be represented by the HTTP proxy.
    #[error("{scope} {location} input '{name}' is unsupported: {reason}")]
    UnsupportedInput {
        scope: OpenApiParameterScope,
        location: String,
        name: String,
        reason: String,
    },
}

type Parameters<'a> = IndexMap<(&'a str, &'a str), &'a Value>;

/// Resolve parameters once, retaining locations even when flat fields collide.
pub(crate) fn effective_input_schema(
    path_item: &Value,
    operation: &Value,
    spec: &Value,
) -> (Value, Value) {
    let mut problems = Vec::new();
    let mut parameters = resolve_list(
        path_item,
        spec,
        OpenApiParameterScope::PathItem,
        &mut problems,
    );
    parameters.extend(resolve_list(
        operation,
        spec,
        OpenApiParameterScope::Operation,
        &mut problems,
    ));
    let (body, required_body) = match effective_json_body(operation, spec) {
        Ok(body) => body,
        Err(reason) => {
            problems.push(unsupported_input("body", "requestBody", reason));
            (None, false)
        }
    };
    let schema = extract_input_schema_from_parameters(
        parameters.values().copied(),
        body.as_ref(),
        Some(spec),
        SchemaReferenceMode::Effective,
    );
    let mut sources = OpenApiProxyInputs {
        path: Vec::new(),
        query: Vec::new(),
        body: body
            .as_ref()
            .and_then(|schema| schema.get("properties"))
            .and_then(Value::as_object)
            .map(|properties| properties.keys().cloned().collect())
            .unwrap_or_default(),
        problems,
    };
    for (&(name, location), parameter) in &parameters {
        let parameter_schema = &schema["properties"][name];
        match location {
            "path" => {
                sources.path.push(name.to_string());
                if unsupported_path_parameter(parameter, parameter_schema) {
                    sources
                        .problems
                        .push(unsupported_input("path", name, "path_serialization"));
                }
            }
            "query" => {
                sources.query.push(name.to_string());
                if unsupported_query_parameter(parameter, parameter_schema) {
                    sources
                        .problems
                        .push(unsupported_input("query", name, "query_serialization"));
                }
            }
            _ => {}
        }
    }
    let mut metadata = json!(sources);
    if required_body {
        metadata[OpenApiProxyInputs::REQUIRED_BODY_KEY] = Value::Bool(true);
    }
    (schema, metadata)
}

fn unsupported_input(location: &str, name: &str, reason: &str) -> OpenApiParameterProblem {
    OpenApiParameterProblem::UnsupportedInput {
        scope: OpenApiParameterScope::Operation,
        location: location.to_string(),
        name: name.to_string(),
        reason: reason.to_string(),
    }
}

fn unsupported_path_parameter(parameter: &Value, schema: &Value) -> bool {
    parameter
        .get("style")
        .is_some_and(|style| style != "simple")
        || parameter.get("content").is_some()
        || any_schema_branch(schema, &|branch| {
            schema_has_type(branch, "object") || schema_has_type(branch, "array")
        })
}

fn unsupported_query_parameter(parameter: &Value, schema: &Value) -> bool {
    if parameter.get("style").is_some_and(|style| style != "form")
        || parameter.get("content").is_some()
        || any_schema_branch(schema, &|branch| schema_has_type(branch, "object"))
    {
        return true;
    }
    let non_exploded = parameter
        .get("explode")
        .is_some_and(|explode| explode != true);
    if non_exploded && !declares_scalar_type(schema) {
        return true;
    }
    any_schema_branch(schema, &|branch| schema_has_type(branch, "array"))
        && any_schema_branch(schema, &unsupported_array_items)
}

fn declares_scalar_type(schema: &Value) -> bool {
    let scalar = |value: &Value| {
        matches!(
            value.as_str(),
            Some("string" | "number" | "integer" | "boolean")
        )
    };
    let kind = &schema["type"];
    scalar(kind)
        || kind
            .as_array()
            .is_some_and(|types| !types.is_empty() && types.iter().all(scalar))
}

fn unsupported_array_items(schema: &Value) -> bool {
    let unsupported_item = |item: &Value| {
        any_schema_branch(item, &|branch| {
            schema_has_type(branch, "object")
                || schema_has_type(branch, "array")
                || schema_has_type(branch, "null")
        })
    };
    schema.get("items").is_some_and(unsupported_item)
        || schema
            .get("prefixItems")
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().any(unsupported_item))
}

fn any_schema_branch(schema: &Value, predicate: &impl Fn(&Value) -> bool) -> bool {
    predicate(schema)
        || ["allOf", "anyOf", "oneOf"].iter().any(|keyword| {
            schema
                .get(*keyword)
                .and_then(Value::as_array)
                .is_some_and(|items| items.iter().any(|item| any_schema_branch(item, predicate)))
        })
}

fn schema_has_type(schema: &Value, name: &str) -> bool {
    let kind = &schema["type"];
    kind == name
        || kind
            .as_array()
            .is_some_and(|names| names.iter().any(|kind| kind == name))
}

fn effective_json_body(
    operation: &Value,
    spec: &Value,
) -> Result<(Option<Value>, bool), &'static str> {
    let Some(body) = operation.get("requestBody") else {
        return Ok((None, false));
    };
    let body = resolve_object(body, spec, "cyclic request body reference")
        .map_err(|_| "request_body_reference")?;
    let content = body.get("content").and_then(Value::as_object);
    let media = content
        .and_then(|content| content.get("application/json"))
        .ok_or("request_body_media_type")?;
    let schema = media.get("schema").ok_or("request_body_schema")?;
    let schema = deep_resolve_schema_refs(schema, spec, 0, SchemaReferenceMode::Effective);
    let required = body["required"] == true;
    let non_object = schema.get("type").is_some_and(|value| value != "object");
    let properties = schema.get("properties").and_then(Value::as_object);
    // Flattening only named properties cannot retain root composition.
    let composed = ["allOf", "anyOf", "oneOf", "not", "if"]
        .iter()
        .any(|keyword| schema.get(*keyword).is_some());
    if non_object
        || composed
        || properties.is_none()
        || (required && properties.is_some_and(|map| map.is_empty()))
    {
        return Err("request_body_schema");
    }
    Ok((Some(schema), required))
}

fn resolve_list<'a>(
    owner: &'a Value,
    spec: &'a Value,
    scope: OpenApiParameterScope,
    problems: &mut Vec<OpenApiParameterProblem>,
) -> Parameters<'a> {
    let mut parameters = IndexMap::new();
    let Some(entries) = owner.get("parameters") else {
        return parameters;
    };
    let Some(entries) = entries.as_array() else {
        problems.push(OpenApiParameterProblem::InvalidList { scope });
        return parameters;
    };
    for (index, entry) in entries.iter().enumerate() {
        let parameter = match resolve_parameter(entry, spec) {
            Ok(parameter) => parameter,
            Err((reference, reason)) => {
                problems.push(OpenApiParameterProblem::Reference {
                    scope,
                    index,
                    reference: reference.to_string(),
                    reason: reason.to_string(),
                });
                continue;
            }
        };
        let (Some(name), Some(location)) = (parameter["name"].as_str(), parameter["in"].as_str())
        else {
            problems.push(OpenApiParameterProblem::InvalidParameter { scope, index });
            continue;
        };
        if name.is_empty() || !matches!(location, "path" | "query" | "header" | "cookie") {
            problems.push(OpenApiParameterProblem::InvalidParameter { scope, index });
            continue;
        }
        match parameters.entry((name, location)) {
            Entry::Vacant(entry) => {
                entry.insert(parameter);
            }
            Entry::Occupied(_) => problems.push(OpenApiParameterProblem::Duplicate {
                scope,
                name: name.to_string(),
                location: location.to_string(),
            }),
        }
    }
    parameters
}

fn resolve_parameter<'a>(
    parameter: &'a Value,
    spec: &'a Value,
) -> Result<&'a Value, (&'a str, &'static str)> {
    resolve_object(parameter, spec, "cyclic parameter reference")
}

fn resolve_object<'a>(
    mut value: &'a Value,
    spec: &'a Value,
    cycle_error: &'static str,
) -> Result<&'a Value, (&'a str, &'static str)> {
    let mut seen = HashSet::new();
    while let Some(reference) = value.get("$ref") {
        let reference = reference
            .as_str()
            .ok_or(("<non-string>", "expected a string reference"))?;
        if !seen.insert(reference) {
            return Err((reference, cycle_error));
        }
        value = resolve_local_pointer(reference, spec)
            .map_err(|reason| (display_effective_reference(reference), reason))?;
        if !value.is_object() {
            return Err((reference, "pointer does not identify an object"));
        }
    }
    Ok(value)
}
