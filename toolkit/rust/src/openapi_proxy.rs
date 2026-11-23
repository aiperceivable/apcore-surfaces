//! Forwarding diagnostics for effective OpenAPI operation inputs.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::http_verb_map::{extract_openapi_path_param_names, is_openapi_proxy_path};
use crate::{
    http_proxy_route_metadata, proxy_supports_http_method, proxy_uses_json_body,
    OpenApiParameterProblem, OpenApiProxyInputs, ScannedModule,
};

/// The location an OpenAPI input occupies before flattening into one tool field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenApiInputLocation {
    Path,
    Query,
    Body,
}

impl std::fmt::Display for OpenApiInputLocation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Path => "path",
            Self::Query => "query",
            Self::Body => "JSON body",
        })
    }
}

/// Why the proxy cannot faithfully forward a selected operation's inputs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "code", rename_all = "snake_case")]
#[non_exhaustive]
pub enum EffectiveProxyHazardKind {
    #[error("effective input metadata is missing; use scan_with_effective_parameters")]
    MissingEffectiveInputs,
    #[error("effective input metadata is invalid: {detail}")]
    InvalidEffectiveInputs { detail: String },
    #[error("routing metadata is missing or invalid: '{key}'")]
    MissingRouteMetadata { key: String },
    #[error("unsupported HTTP method: '{method}'")]
    UnsupportedHttpMethod { method: String },
    #[error("could not resolve operation parameters: {problem}")]
    ParameterResolution { problem: OpenApiParameterProblem },
    #[error("query parameters cannot be forwarded by the JSON body method: {}", .parameters.join(", "))]
    QueryOnBodyMethod { parameters: Vec<String> },
    #[error("JSON body properties cannot be forwarded by the query method: {}", .properties.join(", "))]
    BodyOnQueryMethod { properties: Vec<String> },
    #[error("input '{name}' has conflicting locations: {}", display_locations(.locations))]
    NameCollision {
        name: String,
        locations: Vec<OpenApiInputLocation>,
    },
    #[error("path declarations disagree with the route; undeclared placeholders: {undeclared:?}; unused path parameters: {unused:?}")]
    PathTemplateMismatch {
        undeclared: Vec<String>,
        unused: Vec<String>,
    },
    #[error("tool schema disagrees with the effective inputs; unlocated fields: {unlocated:?}; unpublished inputs: {unpublished:?}; edit parameters in transform_operation")]
    InputSchemaMismatch {
        unlocated: Vec<String>,
        unpublished: Vec<String>,
    },
}

fn display_locations(locations: &[OpenApiInputLocation]) -> String {
    locations
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

/// A forwarding problem reported for the scanner's final module ID and route.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EffectiveProxyHazard {
    pub module_id: String,
    pub http_method: String,
    pub url_path: String,
    pub kind: EffectiveProxyHazardKind,
}

impl std::fmt::Display for EffectiveProxyHazard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} ({} {}): {}",
            self.module_id, self.http_method, self.url_path, self.kind
        )
    }
}

/// Check selected modules before registering them with the HTTP proxy writer.
///
/// Pass the result of the toolkit's opt-in `scan_with_effective_parameters`
/// after applying the caller's selection. The toolkit's metadata comes from
/// the same inputs used for schema extraction, including operation hooks.
/// Missing or invalid effective input metadata is a hazard.
#[must_use]
pub fn detect_effective_proxy_hazards(modules: &[ScannedModule]) -> Vec<EffectiveProxyHazard> {
    let mut hazards = Vec::new();
    for module in modules {
        let (method, path) = http_proxy_route_metadata(module);
        let method = method.filter(|value| !value.trim().is_empty());
        let path = path.filter(|value| is_openapi_proxy_path(value));
        let kinds = match OpenApiProxyInputs::from_module(module) {
            Ok(Some(inputs)) => assess_proxy_inputs(&inputs, method, path, &module.input_schema),
            Ok(None) => vec![EffectiveProxyHazardKind::MissingEffectiveInputs],
            Err(error) => vec![EffectiveProxyHazardKind::InvalidEffectiveInputs {
                detail: error.to_string(),
            }],
        };
        hazards.extend(kinds.into_iter().map(|kind| EffectiveProxyHazard {
            module_id: module.module_id.clone(),
            http_method: method.unwrap_or("?").to_string(),
            url_path: path.unwrap_or("?").to_string(),
            kind,
        }));
    }
    hazards.sort_by(|left, right| {
        (&left.module_id, &left.http_method, &left.url_path).cmp(&(
            &right.module_id,
            &right.http_method,
            &right.url_path,
        ))
    });
    hazards
}

fn assess_proxy_inputs(
    inputs: &OpenApiProxyInputs,
    method: Option<&str>,
    path: Option<&str>,
    input_schema: &Value,
) -> Vec<EffectiveProxyHazardKind> {
    use EffectiveProxyHazardKind::{
        BodyOnQueryMethod, MissingRouteMetadata, ParameterResolution, QueryOnBodyMethod,
        UnsupportedHttpMethod,
    };

    let mut hazards: Vec<_> = inputs
        .problems
        .iter()
        .cloned()
        .map(|problem| ParameterResolution { problem })
        .collect();
    if let Some(method) = method {
        let uses_body = proxy_uses_json_body(method);
        // The effective contract is shared with the TypeScript proxy, whose
        // default Fetch transport rejects TRACE before sending it.
        if method == "TRACE" || !proxy_supports_http_method(method) {
            hazards.push(UnsupportedHttpMethod {
                method: method.to_string(),
            });
        } else if uses_body && !inputs.query.is_empty() {
            hazards.push(QueryOnBodyMethod {
                parameters: inputs.query.clone(),
            });
        } else if !uses_body && !inputs.body.is_empty() {
            let mut properties = inputs.body.clone();
            properties.sort();
            hazards.push(BodyOnQueryMethod { properties });
        }
    } else {
        hazards.push(MissingRouteMetadata {
            key: "http_method".to_string(),
        });
    }
    if let Some(path) = path {
        if let Some(mismatch) = path_template_mismatch(&inputs.path, path) {
            hazards.push(mismatch);
        }
    } else {
        hazards.push(MissingRouteMetadata {
            key: "url_path".to_string(),
        });
    }
    hazards.extend(name_collisions(inputs));
    hazards.extend(schema_input_mismatch(inputs, input_schema));
    hazards
}

fn path_template_mismatch(path_inputs: &[String], path: &str) -> Option<EffectiveProxyHazardKind> {
    let template: BTreeSet<_> = extract_openapi_path_param_names(path).into_iter().collect();
    let declared: BTreeSet<_> = path_inputs.iter().cloned().collect();
    (template != declared).then(|| EffectiveProxyHazardKind::PathTemplateMismatch {
        undeclared: template.difference(&declared).cloned().collect(),
        unused: declared.difference(&template).cloned().collect(),
    })
}

fn name_collisions(inputs: &OpenApiProxyInputs) -> Vec<EffectiveProxyHazardKind> {
    let mut by_name: BTreeMap<&str, Vec<_>> = BTreeMap::new();
    for (location, names) in [
        (OpenApiInputLocation::Path, &inputs.path),
        (OpenApiInputLocation::Query, &inputs.query),
        (OpenApiInputLocation::Body, &inputs.body),
    ] {
        for name in names {
            let locations = by_name.entry(name).or_default();
            if locations.last() != Some(&location) {
                locations.push(location);
            }
        }
    }
    by_name
        .into_iter()
        .filter(|(_, locations)| locations.len() > 1)
        .map(
            |(name, locations)| EffectiveProxyHazardKind::NameCollision {
                name: name.to_string(),
                locations,
            },
        )
        .collect()
}

fn schema_input_mismatch(
    inputs: &OpenApiProxyInputs,
    schema: &Value,
) -> Option<EffectiveProxyHazardKind> {
    let located: BTreeSet<_> = inputs
        .path
        .iter()
        .chain(&inputs.query)
        .chain(&inputs.body)
        .map(String::as_str)
        .collect();
    let published: BTreeSet<_> = schema["properties"]
        .as_object()
        .into_iter()
        .flat_map(|properties| properties.keys().map(String::as_str))
        .collect();
    (located != published).then(|| EffectiveProxyHazardKind::InputSchemaMismatch {
        unlocated: published
            .difference(&located)
            .map(|name| (*name).into())
            .collect(),
        unpublished: located
            .difference(&published)
            .map(|name| (*name).into())
            .collect(),
    })
}

/// The diagnostics that prevented an OpenAPI selection from being registered.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("OpenAPI proxy cannot forward selected operations: {}", format_hazards(.hazards))]
pub struct EffectiveProxyValidationError {
    /// Forwarding diagnostics in module and route order.
    pub hazards: Vec<EffectiveProxyHazard>,
}

fn format_hazards(hazards: &[EffectiveProxyHazard]) -> String {
    hazards
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("; ")
}

/// Validate the final selection before handing any modules to the proxy writer.
///
/// # Errors
///
/// Returns all forwarding diagnostics if any selected module is unsafe to proxy.
pub fn validate_effective_proxy_modules(
    modules: &[ScannedModule],
) -> Result<(), EffectiveProxyValidationError> {
    let hazards = detect_effective_proxy_hazards(modules);
    if hazards.is_empty() {
        Ok(())
    } else {
        Err(EffectiveProxyValidationError { hazards })
    }
}
