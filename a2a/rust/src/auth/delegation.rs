//! Projection of verified RFC 8693 JWT claims into Core authority.

use std::collections::{BTreeSet, HashMap};

use serde_json::Value;

use apcore::context::Identity;

pub(super) const DELEGATED_CLOCK_SKEW: u64 = 30;

/// Enable JWT scope projection and optionally map provider and actor claims.
#[derive(Debug, Clone, Default)]
pub struct DelegatedClaims {
    /// Optional provider claim that may carry a scope string or array.
    pub scp_claim: Option<String>,
    /// Optional role-list claim on the current `act` object.
    pub actor_roles_claim: Option<String>,
}

fn scope_set(value: &Value, allow_array: bool) -> Option<BTreeSet<&str>> {
    fn valid(token: &str) -> bool {
        !token.is_empty()
            && token
                .bytes()
                .all(|byte| matches!(byte, b'!' | b'#'..=b'[' | b']'..=b'~'))
    }

    if let Some(value) = value.as_str() {
        return value
            .split(' ')
            .map(|token| valid(token).then_some(token))
            .collect();
    }
    if !allow_array {
        return None;
    }
    value
        .as_array()?
        .iter()
        .map(|token| token.as_str().filter(|token| valid(token)))
        .collect()
}

fn scopes(payload: &HashMap<String, Value>, mapping: &DelegatedClaims) -> Option<Vec<String>> {
    let standard = match payload.get("scope") {
        Some(value) => Some(scope_set(value, false)?),
        None => None,
    };
    let provider = match mapping
        .scp_claim
        .as_ref()
        .and_then(|name| payload.get(name))
    {
        Some(value) => Some(scope_set(value, true)?),
        None => None,
    };
    if matches!((&standard, &provider), (Some(left), Some(right)) if left != right) {
        return None;
    }
    Some(
        standard
            .or(provider)?
            .into_iter()
            .map(str::to_owned)
            .collect(),
    )
}

fn nonempty_string(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

fn outer_actor(value: &Value, mapping: &DelegatedClaims, issuer: &str) -> Option<Identity> {
    let outer = value.as_object()?;
    let mut node = outer;
    for depth in 1..=8 {
        nonempty_string(node.get("sub")?)?;
        if let Some(issuer) = node.get("iss") {
            nonempty_string(issuer)?;
        }
        let Some(next) = node.get("act") else { break };
        if depth == 8 {
            return None;
        }
        node = next.as_object()?;
    }
    let actor_type = match outer.get("type") {
        Some(value) => nonempty_string(value)?,
        None => "agent",
    };
    let roles = match mapping
        .actor_roles_claim
        .as_ref()
        .and_then(|name| outer.get(name))
    {
        Some(value) => value
            .as_array()?
            .iter()
            .map(|value| nonempty_string(value).map(str::to_owned))
            .collect::<Option<Vec<_>>>()?,
        None => Vec::new(),
    };
    Identity::new(
        nonempty_string(outer.get("sub")?)?.into(),
        actor_type.into(),
        roles,
        HashMap::new(),
    )
    .with_authority(None, Some(issuer.into()))
    .ok()
}

pub(super) fn project(
    payload: &HashMap<String, Value>,
    mapped: &Identity,
    mapping: &DelegatedClaims,
) -> Option<Identity> {
    if [&mapping.scp_claim, &mapping.actor_roles_claim]
        .into_iter()
        .flatten()
        .any(String::is_empty)
    {
        return None;
    }
    let issuer = nonempty_string(payload.get("iss")?)?;
    let subject_id = nonempty_string(payload.get("sub")?)?;
    let now = jsonwebtoken::get_current_timestamp() as f64;
    for claim in ["exp", "nbf", "iat"] {
        if let Some(value) = payload.get(claim) {
            let timestamp = value.as_f64()?;
            if claim != "exp" && timestamp > now + DELEGATED_CLOCK_SKEW as f64 {
                return None;
            }
        }
    }
    let scopes = scopes(payload, mapping)?;
    let mut attrs = mapped.attrs().clone();
    attrs.remove("act");
    attrs.remove("scope");
    if let Some(name) = &mapping.scp_claim {
        attrs.remove(name);
    }
    let subject = Identity::new(
        subject_id.into(),
        mapped.identity_type().into(),
        mapped.roles().to_vec(),
        attrs,
    )
    .with_authority(Some(scopes.clone()), Some(issuer.into()))
    .ok()?;
    match payload.get("act") {
        Some(value) => subject
            .delegate(outer_actor(value, mapping, issuer)?, scopes)
            .ok(),
        None => Some(subject),
    }
}
