//! Integration tests for the auth module.

mod common;

use apcore_mcp::auth::protocol::Authenticator;
use apcore_mcp::{ClaimMapping, DelegatedClaims, JWTAuthenticator};
use jsonwebtoken::{EncodingKey, Header};
use std::collections::HashMap;

const TEST_SECRET: &str = "integration-test-secret";

fn make_token(claims: &serde_json::Value) -> String {
    jsonwebtoken::encode(
        &Header::default(),
        claims,
        &EncodingKey::from_secret(TEST_SECRET.as_bytes()),
    )
    .expect("encode JWT")
}

fn headers_with_token(token: &str) -> HashMap<String, String> {
    let mut h = HashMap::new();
    h.insert("authorization".to_string(), format!("Bearer {token}"));
    h
}

fn delegated_authenticator() -> JWTAuthenticator {
    JWTAuthenticator::new(
        TEST_SECRET,
        None,
        Some("mcp-service".into()),
        Some("issuer".into()),
        Some(ClaimMapping {
            attrs_claims: Some(vec!["tenant".into(), "act".into()]),
            ..ClaimMapping::default()
        }),
        None,
        Some(false),
    )
    .with_delegated_claims(DelegatedClaims {
        scp_claim: Some("scp".into()),
        actor_roles_claim: Some("current_roles".into()),
    })
}

fn delegated_token_claims() -> serde_json::Value {
    serde_json::json!({
        "iss": "issuer",
        "aud": "mcp-service",
        "sub": "alice",
        "exp": jsonwebtoken::get_current_timestamp() + 120,
        "roles": ["reviewer"],
        "tenant": "engineering",
        "scope": "docs:read docs:edit docs:read",
        "scp": ["docs:edit", "docs:read"],
        "act": {
            "sub": "current",
            "current_roles": ["worker"],
            "act": {"sub": "prior", "current_roles": ["admin"]}
        }
    })
}

#[tokio::test]
async fn delegated_credentials_use_current_actor_and_verified_subject() {
    let auth = delegated_authenticator();
    let mut claims = delegated_token_claims();
    let identity = auth
        .authenticate(&headers_with_token(&make_token(&claims)))
        .await
        .unwrap();
    assert_eq!(identity.id(), "current");
    assert_eq!(identity.roles(), ["worker"]);
    assert_eq!(identity.delegation_depth(), 1);
    assert_eq!(identity.root_subject().id(), "alice");
    assert_eq!(identity.root_subject().roles(), ["reviewer"]);
    assert_eq!(identity.root_subject().issuer(), Some("issuer"));
    assert_eq!(identity.root_subject().attrs()["tenant"], "engineering");
    assert!(!identity.root_subject().attrs().contains_key("act"));
    claims["act"]["act"]["sub"] = "replacement".into();
    let changed_history = auth
        .authenticate(&headers_with_token(&make_token(&claims)))
        .await
        .unwrap();
    assert_eq!(changed_history.authority_key(), identity.authority_key());
    assert_eq!(changed_history.owner_key(), identity.owner_key());
}

#[tokio::test]
async fn delegated_credentials_reject_bad_signature_claims_and_conflicts() {
    let auth = delegated_authenticator();
    let now = jsonwebtoken::get_current_timestamp();
    for (claim, invalid) in [
        ("iss", serde_json::json!("wrong")),
        ("aud", serde_json::json!("wrong")),
        ("exp", serde_json::json!(now - 120)),
        ("iat", serde_json::json!(now + 120)),
        ("nbf", serde_json::json!(now + 120)),
        ("nbf", serde_json::json!(null)),
        ("sub", serde_json::json!(123)),
        ("scope", serde_json::json!("docs:read\tdocs:edit")),
        ("scp", serde_json::json!(["docs:read"])),
        (
            "act",
            serde_json::json!({"sub":"actor", "act":{"type":"user"}}),
        ),
    ] {
        let mut claims = delegated_token_claims();
        claims[claim] = invalid;
        assert!(
            auth.authenticate(&headers_with_token(&make_token(&claims)))
                .await
                .is_none(),
            "{claim}"
        );
    }
    let mut claims = delegated_token_claims();
    for claim in ["exp", "iss", "aud", "sub"] {
        let mut missing = claims.clone();
        missing.as_object_mut().unwrap().remove(claim);
        assert!(
            auth.authenticate(&headers_with_token(&make_token(&missing)))
                .await
                .is_none(),
            "{claim}"
        );
    }
    let wrong_signature = jsonwebtoken::encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(b"other-test-key"),
    )
    .unwrap();
    assert!(auth
        .authenticate(&headers_with_token(&wrong_signature))
        .await
        .is_none());
    claims.as_object_mut().unwrap().remove("scope");
    claims["scp"] = serde_json::json!([]);
    assert!(auth
        .authenticate(&headers_with_token(&make_token(&claims)))
        .await
        .unwrap()
        .scopes()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn delegated_middleware_rejects_present_invalid_credentials_in_permissive_mode() {
    use apcore_mcp::AuthMiddlewareLayer;
    use axum::body::Body;
    use axum::http::{Request, Response, StatusCode};
    use std::{convert::Infallible, sync::Arc};
    use tower::{ServiceBuilder, ServiceExt};

    let service = ServiceBuilder::new()
        .layer(AuthMiddlewareLayer::new(Arc::new(delegated_authenticator())).require_auth(false))
        .service(tower::service_fn(|_: Request<Body>| async {
            Ok::<_, Infallible>(Response::new(Body::empty()))
        }));
    let invalid = Request::get("/mcp")
        .header("Authorization", "Bearer invalid")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        service.clone().oneshot(invalid).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let anonymous = Request::get("/mcp").body(Body::empty()).unwrap();
    assert_eq!(
        service.oneshot(anonymous).await.unwrap().status(),
        StatusCode::OK
    );
}

// ---- JWTAuthenticator with valid tokens ------------------------------------

#[tokio::test]
async fn valid_token_produces_identity() {
    let auth = JWTAuthenticator::new(TEST_SECRET, None, None, None, None, None, None);
    let token = make_token(&serde_json::json!({
        "sub": "alice",
        "type": "human",
        "roles": ["admin"]
    }));
    let identity = auth
        .authenticate(&headers_with_token(&token))
        .await
        .expect("valid token must produce identity");
    assert_eq!(identity.id(), "alice");
    assert_eq!(identity.identity_type(), "human");
    assert_eq!(identity.roles(), vec!["admin"]);
}

#[tokio::test]
async fn invalid_token_returns_none() {
    let auth = JWTAuthenticator::new(TEST_SECRET, None, None, None, None, None, None);
    let result = auth
        .authenticate(&headers_with_token("not.a.valid.jwt"))
        .await;
    assert!(result.is_none(), "invalid JWT must return None");
}

// ---- require_claims enforcement --------------------------------------------

#[tokio::test]
async fn missing_custom_claim_returns_none() {
    // [D11-006] Custom claims must be enforced post-decode.
    let auth = JWTAuthenticator::new(
        TEST_SECRET,
        None,
        None,
        None,
        None,
        Some(vec!["sub".to_string(), "org_id".to_string()]),
        None,
    );
    // Token WITHOUT org_id
    let token = make_token(&serde_json::json!({"sub": "user-1"}));
    let result = auth.authenticate(&headers_with_token(&token)).await;
    assert!(result.is_none(), "missing custom claim must reject");
}

#[tokio::test]
async fn present_custom_claim_returns_identity() {
    let auth = JWTAuthenticator::new(
        TEST_SECRET,
        None,
        None,
        None,
        None,
        Some(vec!["sub".to_string(), "org_id".to_string()]),
        None,
    );
    let token = make_token(&serde_json::json!({"sub": "user-1", "org_id": "acme"}));
    let result = auth.authenticate(&headers_with_token(&token)).await;
    assert!(result.is_some(), "all required claims present must succeed");
}

// ---- Null sub → None [D11-008] --------------------------------------------

#[tokio::test]
async fn null_sub_returns_none_not_null_string() {
    // [D11-008] JSON null sub must return None, not Some(Identity{id:"null"}).
    let auth = JWTAuthenticator::new(TEST_SECRET, None, None, None, None, Some(vec![]), None);
    let token = make_token(&serde_json::json!({"sub": null}));
    let result = auth.authenticate(&headers_with_token(&token)).await;
    assert!(result.is_none(), "null sub must return None");
}

// ---- ClaimMapping custom fields -------------------------------------------

#[tokio::test]
async fn custom_claim_mapping_works() {
    let auth = JWTAuthenticator::new(
        TEST_SECRET,
        None,
        None,
        None,
        Some(ClaimMapping {
            id_claim: "user_id".to_string(),
            type_claim: "kind".to_string(),
            roles_claim: "perms".to_string(),
            attrs_claims: None,
        }),
        Some(vec!["user_id".to_string()]),
        None,
    );
    let token = make_token(&serde_json::json!({
        "user_id": "u-99",
        "kind": "service",
        "perms": ["write", "read"]
    }));
    let identity = auth
        .authenticate(&headers_with_token(&token))
        .await
        .unwrap();
    assert_eq!(identity.id(), "u-99");
    assert_eq!(identity.identity_type(), "service");
    assert!(identity.roles().contains(&"write".to_string()));
}

// ---- require_auth accessor [D1-004] ----------------------------------------

#[test]
fn require_auth_accessor() {
    let auth = JWTAuthenticator::new(TEST_SECRET, None, None, None, None, None, Some(true));
    assert!(auth.require_auth());
    let auth = JWTAuthenticator::new(TEST_SECRET, None, None, None, None, None, Some(false));
    assert!(!auth.require_auth());
}
