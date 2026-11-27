//! ElicitationApprovalHandler — uses MCP elicitation to request user approval
//! for destructive or sensitive tool executions.
//!
//! Also contains `StorageBackedApprovalHandler` — Phase B async approval handler
//! backed by a pluggable `ApprovalStore`.

use std::fmt;
use std::sync::Arc;

use apcore::approval::{ApprovalHandler, ApprovalRequest, ApprovalResult};
use apcore::errors::ModuleError;
use async_trait::async_trait;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::approval_store::{
    ApprovalPrincipal, ApprovalRecord, ApprovalScope, ApprovalStatus, ApprovalStore,
    ApprovalVerifier,
};
use crate::helpers::{ElicitAction, ElicitCallback, MCP_ELICIT_CALL_ID_KEY};
use crate::server::elicit_registry::{self, SharedElicitCallback};

/// Handles user approval requests via MCP elicitation.
///
/// Implements the apcore [`ApprovalHandler`] contract by sending an elicitation
/// prompt to the MCP client and interpreting the response.
///
/// # Lifecycle
///
/// - `request_approval` — formats a human-readable message from the
///   [`ApprovalRequest`], invokes the resolved [`ElicitCallback`], and maps the
///   elicit response to an [`ApprovalResult`].
///
/// # Where the callback comes from
///
/// Two sources, tried in order:
///
/// 1. **The live request.** The router registers the connection's callback per
///    tool call and writes its id into `Context.data` under
///    [`MCP_ELICIT_CALL_ID_KEY`]; this handler exchanges the id for the
///    callback. This is the path that makes a handler constructed *outside*
///    the router — by a CLI entry point that never sees a session — able to
///    prompt a real client (apexe#29).
/// 2. **The constructor.** An [`ElicitCallback`] passed to [`Self::new`] is
///    used when the request carries no id, which keeps every embedding that
///    injected its own callback working unchanged.
///
/// With neither, the request is rejected — the correct fail-closed outcome for
/// a client that never declared elicitation support.
/// - `check_approval` — always returns "rejected" because Phase B (async
///   polling of pending approvals) is not supported via stateless MCP
///   elicitation.
pub struct ElicitationApprovalHandler {
    elicit: Option<ElicitCallback>,
}

impl ElicitationApprovalHandler {
    /// Create a new approval handler with an optional elicit callback.
    ///
    /// `None` is the normal construction for a server whose callback is only
    /// known per request: the handler then resolves the live one from
    /// [`MCP_ELICIT_CALL_ID_KEY`] in the request context. It rejects only when
    /// that lookup also comes up empty, which means the connected client
    /// declared no elicitation support.
    pub fn new(elicit: Option<ElicitCallback>) -> Self {
        Self { elicit }
    }
}

impl fmt::Debug for ElicitationApprovalHandler {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ElicitationApprovalHandler")
            .field("has_elicit", &self.elicit.is_some())
            .finish()
    }
}

/// Build a rejected [`ApprovalResult`] with the given reason.
fn rejected(reason: &str) -> ApprovalResult {
    let mut result = ApprovalResult::default();
    result.status = "rejected".to_string();
    result.reason = Some(reason.to_string());
    result
}

/// Coerce an elicitation `approve` value to a decision.
///
/// [A-D-AP-5] The previous `as_bool().unwrap_or(true)` GRANTED approval for
/// any non-boolean — `null` from a blank boolean control, `0`, `""` — which is
/// the wrong direction on a fail-closed safety gate. Python coerces with
/// `bool(...)` and TypeScript with `Boolean(...)`, so this reproduces their
/// truthiness for every scalar shape where the two agree.
///
/// Arrays and objects are the one shape where the peers disagree
/// (`bool([]) is False` in Python, `Boolean([])` is `true` in JS), so they are
/// declined — the safe side of a divergence that cannot be matched either way.
fn approve_truthiness(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Null => false,
        serde_json::Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        serde_json::Value::String(s) => !s.is_empty(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => false,
    }
}

/// Build an approved [`ApprovalResult`].
fn approved() -> ApprovalResult {
    let mut result = ApprovalResult::default();
    result.status = "approved".to_string();
    result
}

/// JSON Schema (MCP elicitation `requested_schema`) for a yes/no approval prompt.
///
/// A boolean gives form-rendering clients (Cursor, Codex, ...) a concrete control
/// to display; an empty schema is tolerated by minimal SDK clients but
/// ignored/rejected by form-rendering clients, so the request returns no response
/// and the gate fails closed.
fn approval_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "title": "Approval required",
        "properties": {
            "approve": {
                "type": "boolean",
                "title": "Approve this action?",
                "description": "Select yes to allow the operation to proceed."
            }
        },
        "required": ["approve"]
    })
}

#[async_trait]
impl ApprovalHandler for ElicitationApprovalHandler {
    async fn request_approval(
        &self,
        request: &ApprovalRequest,
    ) -> Result<ApprovalResult, ModuleError> {
        // [D10-002] Return type kept as `Result<ApprovalResult, ModuleError>` for
        // idiomatic Rust. All error paths return `Ok(rejected(...))` so callers
        // always receive an `ApprovalResult` for the elicitation surface; no `Err`
        // is returned from the elicitation logic itself. [D10-002]

        // [D10-005] "No context available for elicitation" rejection branch —
        // matches the Python/TS path where `request.context` is absent.
        // Rust previously only fired this branch when BOTH context and
        // elicit were missing, which made the callback fire even on
        // context-less requests if a constructor-injected callback was
        // present. The handler must NEVER invoke elicitation without a
        // context attached to the request because the elicitation
        // surface is security-gated and the calling identity is carried
        // by `request.context`. Reject unconditionally whenever context
        // is None.
        let Some(context) = request.context.as_ref() else {
            tracing::debug!("no context attached to approval request, rejecting");
            return Ok(rejected("No context available for elicitation"));
        };

        // [D10-001] apcore-python and apcore-typescript extract the callback
        // per call from `request.context.data[MCP_ELICIT_KEY]`, which they can
        // do because their context data holds arbitrary objects. Rust's is
        // `HashMap<String, serde_json::Value>` and no closure is a `Value`, so
        // this SDK used to be able to read only the marker string
        // `"available"` — it knew elicitation existed and had no way to
        // perform one, and rejected every gated call on any server whose
        // handler was built outside the router (apexe#29).
        //
        // The id under `MCP_ELICIT_CALL_ID_KEY` closes that gap: it IS a
        // `Value`, and the registry exchanges it for the live callback the
        // router registered for this very call. Same per-request resolution as
        // the peer SDKs, one indirection wider. [D10-001]
        let resolved: Option<SharedElicitCallback> = {
            // Scoped so the read guard is released before the `.await` below —
            // apcore's `Context.data` lock must never be held across one.
            let data = context.data.read();
            data.get(MCP_ELICIT_CALL_ID_KEY)
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        }
        .and_then(|call_id| {
            let found = elicit_registry::lookup(&call_id);
            if found.is_none() {
                // The id outlived its guard: the tool call that registered it
                // has already returned. Fall through to `self.elicit` rather
                // than failing outright.
                tracing::debug!(%call_id, "elicit call id no longer registered");
            }
            found
        });

        // Live request first, constructor-injected fallback second, reject
        // third.
        let elicit: &ElicitCallback = match resolved.as_deref() {
            Some(cb) => cb,
            None => match &self.elicit {
                Some(cb) => cb,
                None => {
                    tracing::debug!("no elicitation callback available, rejecting approval");
                    return Ok(rejected("No elicitation callback available"));
                }
            },
        };

        let message = format!(
            "Approval required for tool: {}\n\n{}\n\nArguments: {}",
            request.module_id,
            request.description.as_deref().unwrap_or(""),
            request.arguments,
        );

        // [AH-3] Catch panics from the elicit callback so a buggy
        // implementation can't bring down the approval task. Mirrors
        // Python (try/except) and TypeScript (try/catch) which both
        // degrade to `rejected("Elicitation request failed")` on error.
        // futures::FutureExt::catch_unwind handles async panics across
        // .await points; std::panic::catch_unwind cannot.
        use futures::FutureExt;
        // Send a non-empty schema so form-rendering clients can display an
        // approve/deny control; an empty schema is silently dropped by them.
        let result_outcome = std::panic::AssertUnwindSafe(elicit(message, Some(approval_schema())))
            .catch_unwind()
            .await;
        let result = match result_outcome {
            Ok(Some(r)) => r,
            Ok(None) => {
                tracing::debug!("elicitation returned no response");
                return Ok(rejected("Elicitation returned no response"));
            }
            Err(_panic) => {
                tracing::debug!("elicit callback panicked");
                return Ok(rejected("Elicitation request failed"));
            }
        };

        match result.action {
            ElicitAction::Accept => {
                // Honor an explicit approve=false from the form; clients that
                // render no field send none, so accept itself means approval.
                let approve = result
                    .content
                    .as_ref()
                    .and_then(|c| c.get("approve"))
                    .map(approve_truthiness)
                    .unwrap_or(true);
                if approve {
                    Ok(approved())
                } else {
                    Ok(rejected("User declined approval"))
                }
            }
            ElicitAction::Decline => Ok(rejected("User action: decline")),
            ElicitAction::Cancel => Ok(rejected("User action: cancel")),
            // [D11-020] Python+TS treat any non-"accept" string as rejected.
            // Rust captures the raw string in Unknown(String) so the reason
            // can be surfaced, matching cross-language semantics. [D11-020]
            ElicitAction::Unknown(raw) => Ok(rejected(&format!("User action: {raw}"))),
        }
    }

    async fn check_approval(&self, _approval_id: &str) -> Result<ApprovalResult, ModuleError> {
        Ok(rejected("Phase B not supported via MCP elicitation"))
    }
}

// ── StorageBackedApprovalHandler ─────────────────────────────────────────────

pub(crate) const BACKGROUND_APPROVAL_CONTEXT_KEY: &str = "mcp.background_task";

/// Callback type for out-of-band approval notifications (audit_id, module_id, arguments).
pub type ApprovalNotifyCallback =
    Arc<dyn Fn(String, String, serde_json::Value) + Send + Sync + 'static>;

/// Phase B approval handler backed by a pluggable [`ApprovalStore`].
///
/// The public `audit_id` identifies the record for human resolution and status.
/// Only the pending result given to the caller carries the resume credential
/// in `approval_id`. Scoped resumption verifies and consumes it through the store.
pub struct StorageBackedApprovalHandler {
    store: Arc<dyn ApprovalStore>,
    notify_callback: Option<ApprovalNotifyCallback>,
    require_foreground: bool,
}

impl StorageBackedApprovalHandler {
    /// Create a new handler backed by the given store.
    pub fn new(store: Arc<dyn ApprovalStore>) -> Self {
        Self {
            store,
            notify_callback: None,
            require_foreground: false,
        }
    }

    /// Only the server-owned handler depends on MCP's private reply channel.
    pub(crate) fn for_tool_responses(mut self) -> Self {
        self.require_foreground = true;
        self
    }

    fn allows_foreground_scope(&self, request: &ApprovalRequest) -> bool {
        !self.require_foreground || crate::server::approval_bridge::is_foreground_approval(request)
    }

    /// Attach an optional notification callback.
    ///
    /// The callback receives `(audit_id, module_id, arguments)` and can
    /// be used to send an out-of-band notification (e.g. Slack, email).
    pub fn with_notify<F>(mut self, callback: F) -> Self
    where
        F: Fn(String, String, serde_json::Value) + Send + Sync + 'static,
    {
        self.notify_callback = Some(Arc::new(callback));
        self
    }

    /// Read a public approval record scoped to the current authenticated principal.
    pub async fn check_scoped_approval(
        &self,
        audit_id: &str,
        identity: Option<&apcore::Identity>,
    ) -> ApprovalResult {
        scoped_approval_status(self.store.as_ref(), audit_id, identity).await
    }
}

pub(crate) async fn scoped_approval_status(
    store: &dyn ApprovalStore,
    audit_id: &str,
    identity: Option<&apcore::Identity>,
) -> ApprovalResult {
    if !is_public_approval_id(audit_id) {
        return rejected("Approval record not found");
    }
    let principal = identity.map(ApprovalPrincipal::from);
    match store.get_scoped_result(audit_id, principal.as_ref()).await {
        Ok(Some(record)) => stored_result(&record, Some(audit_id)),
        Ok(None) => rejected("Approval record not found"),
        Err(_) => store_error(),
    }
}

pub(crate) fn is_public_approval_id(audit_id: &str) -> bool {
    audit_id.len() == 36
        && Uuid::parse_str(audit_id).is_ok_and(|id| {
            id.get_version_num() == 4
                && id.get_variant() == uuid::Variant::RFC4122
                && id.hyphenated().to_string() == audit_id
        })
}

impl fmt::Debug for StorageBackedApprovalHandler {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StorageBackedApprovalHandler")
            .field("has_notify", &self.notify_callback.is_some())
            .finish()
    }
}

pub(crate) fn resume_audit_id(credential: &str) -> Option<&str> {
    let (audit_id, secret) = credential.split_once('.')?;
    (is_public_approval_id(audit_id) && secret.len() == 32 && Uuid::parse_str(secret).is_ok())
        .then_some(audit_id)
}

fn credential_verifier(credential: &str) -> ApprovalVerifier {
    Sha256::digest(credential.as_bytes()).into()
}

fn stored_result(record: &ApprovalRecord, audit_id: Option<&str>) -> ApprovalResult {
    let mut result = ApprovalResult::default();
    result.status = record.status.to_string();
    result.audit_id = audit_id.map(str::to_owned);
    result
}

fn store_error() -> ApprovalResult {
    tracing::error!("Approval store operation failed");
    rejected("internal store error")
}

fn is_background_call(request: &ApprovalRequest) -> bool {
    request.context.as_ref().is_some_and(|context| {
        context
            .data
            .read()
            .get(BACKGROUND_APPROVAL_CONTEXT_KEY)
            .and_then(serde_json::Value::as_bool)
            == Some(true)
    })
}

#[async_trait]
impl ApprovalHandler for StorageBackedApprovalHandler {
    async fn request_approval(
        &self,
        request: &ApprovalRequest,
    ) -> Result<ApprovalResult, ModuleError> {
        if is_background_call(request) {
            return Ok(rejected("Background tasks do not support Phase B approval"));
        }
        if !self.allows_foreground_scope(request) {
            return Ok(rejected("Phase B approval requires a direct MCP tool call"));
        }
        let audit_id = Uuid::new_v4().to_string();
        let credential = format!("{audit_id}.{}", Uuid::new_v4().simple());
        let verifier = credential_verifier(&credential);
        let scope = ApprovalScope::from(request);
        if self
            .store
            .save_scoped_pending(&audit_id, &verifier, &scope)
            .await
            .is_err()
        {
            return Ok(store_error());
        }

        if let Some(cb) = &self.notify_callback {
            cb(
                audit_id.clone(),
                request.module_id.clone(),
                request.arguments.clone(),
            );
        }

        crate::server::approval_bridge::record_pending_approval(request, &audit_id, &credential);
        let mut result = ApprovalResult::default();
        result.status = "pending".to_string();
        result.approval_id = Some(credential);
        result.audit_id = Some(audit_id);
        Ok(result)
    }

    async fn check_approval(&self, audit_id: &str) -> Result<ApprovalResult, ModuleError> {
        if resume_audit_id(audit_id).is_some() {
            return Ok(rejected("Approval record not found"));
        }
        Ok(match self.store.get_result(audit_id).await {
            Ok(Some(record)) => {
                let public_id = Uuid::parse_str(audit_id).is_ok().then_some(audit_id);
                let mut result = stored_result(&record, public_id);
                if record.status == ApprovalStatus::Rejected {
                    result.reason = record.reason;
                }
                result
            }
            Ok(None) => rejected("Approval record not found"),
            Err(_) => store_error(),
        })
    }

    async fn check_approval_for_call(
        &self,
        credential: &str,
        request: &ApprovalRequest,
    ) -> Result<ApprovalResult, ModuleError> {
        if is_background_call(request) {
            return Ok(rejected("Background tasks do not support Phase B approval"));
        }
        if !self.allows_foreground_scope(request) {
            return Ok(rejected("Phase B approval requires a direct MCP tool call"));
        }
        let Some(audit_id) = resume_audit_id(credential) else {
            return Ok(rejected("Approval credential unavailable for this call"));
        };
        let verifier = credential_verifier(credential);
        let scope = ApprovalScope::from(request);
        Ok(
            match self.store.consume_scoped(audit_id, &verifier, &scope).await {
                Ok(Some(record)) => {
                    let pending = record.status == ApprovalStatus::Pending;
                    let mut result = stored_result(&record, Some(audit_id));
                    if pending {
                        crate::server::approval_bridge::record_pending_approval(
                            request, audit_id, credential,
                        );
                        result.approval_id = Some(credential.to_owned());
                    }
                    result
                }
                Ok(None) => rejected("Approval credential unavailable for this call"),
                Err(_) => store_error(),
            },
        )
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::helpers::ElicitResult;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn scoped_request() -> ApprovalRequest {
        let mut request = ApprovalRequest::default();
        request.module_id = "sample.render".into();
        request.caller_id = Some("sample.caller".into());
        request.arguments = json!({"label": "draft", "options": {"width": 12, "height": 8}});
        request.context = Some(apcore::Context::new(apcore::Identity::new(
            "editor".into(),
            "user".into(),
            vec![],
            Default::default(),
        )));
        request
    }

    #[tokio::test]
    async fn storage_approval_notifies_with_a_public_record_id() {
        let store = Arc::new(crate::approval_store::InMemoryApprovalStore::new());
        let notified = Arc::new(Mutex::new(None));
        let handler = StorageBackedApprovalHandler::new(store).with_notify({
            let notified = Arc::clone(&notified);
            move |id, _, _| *notified.lock().unwrap() = Some(id)
        });
        let request = scoped_request();
        let result = handler.request_approval(&request).await.unwrap();
        assert_eq!(result.status, "pending");
        let audit_id = result
            .audit_id
            .as_deref()
            .expect("public approval record ID");
        let credential = result.approval_id.as_deref().expect("resume credential");
        assert!(Uuid::parse_str(audit_id).is_ok());
        assert_ne!(audit_id, credential);
        assert_eq!(notified.lock().unwrap().as_deref(), Some(audit_id));

        let identity = request.context.as_ref().unwrap().identity.as_ref();
        let status = handler.check_scoped_approval(audit_id, identity).await;
        assert_eq!(status.status, "pending");
        assert!(status.approval_id.is_none());
        assert_eq!(status.audit_id.as_deref(), Some(audit_id));
        let anonymous = handler.check_scoped_approval(audit_id, None).await;
        assert_eq!(anonymous.status, "rejected");
        assert!(anonymous.audit_id.is_none());
    }

    #[tokio::test]
    async fn approved_invocation_consumes_its_credential_once() {
        let store = Arc::new(crate::approval_store::InMemoryApprovalStore::new());
        let handler = StorageBackedApprovalHandler::new(store.clone());
        let request = scoped_request();
        let result = handler.request_approval(&request).await.unwrap();
        let audit_id = result.audit_id.as_deref().unwrap();
        let credential = result.approval_id.as_deref().unwrap();
        let pending = handler
            .check_approval_for_call(credential, &request)
            .await
            .unwrap();
        assert_eq!(pending.status, "pending");
        assert_eq!(pending.approval_id.as_deref(), Some(credential));
        assert!(store.resolve(audit_id, true, None).await.unwrap());

        let (first, second) = tokio::join!(
            handler.check_approval_for_call(credential, &request),
            handler.check_approval_for_call(credential, &request),
        );
        let mut statuses = [first.unwrap().status, second.unwrap().status];
        statuses.sort();
        assert_eq!(statuses, ["approved", "rejected"]);
        assert_eq!(
            handler.check_approval(audit_id).await.unwrap().status,
            "approved"
        );
    }

    #[tokio::test]
    async fn phase_b_scope_covers_the_invocation_and_does_not_depend_on_object_key_order() {
        let store = Arc::new(crate::approval_store::InMemoryApprovalStore::new());
        let handler = StorageBackedApprovalHandler::new(store.clone());
        let request = scoped_request();
        let result = handler.request_approval(&request).await.unwrap();
        let audit_id = result.audit_id.as_deref().unwrap();
        let credential = result.approval_id.as_deref().unwrap();
        assert!(store.resolve(audit_id, true, None).await.unwrap());

        let mut other_module = request.clone();
        other_module.module_id = "sample.preview".into();
        let mut other_caller = request.clone();
        other_caller.caller_id = None;
        let mut other_principal = request.clone();
        other_principal.context = Some(apcore::Context::new(apcore::Identity::new(
            "viewer".into(),
            "user".into(),
            vec![],
            Default::default(),
        )));
        let mut other_identity_type = request.clone();
        other_identity_type.context = Some(apcore::Context::new(apcore::Identity::new(
            "editor".into(),
            "service".into(),
            vec![],
            Default::default(),
        )));
        let mut other_arguments = request.clone();
        other_arguments.arguments["options"]["width"] = json!(24);
        for other in [
            other_module,
            other_caller,
            other_principal,
            other_identity_type,
            other_arguments,
        ] {
            let result = handler
                .check_approval_for_call(credential, &other)
                .await
                .unwrap();
            assert_eq!(result.status, "rejected");
            assert!(result.approval_id.is_none());
        }

        let mut same = request;
        same.arguments = json!({"options": {"height": 8, "width": 12}, "label": "draft"});
        let result = handler
            .check_approval_for_call(credential, &same)
            .await
            .unwrap();
        assert_eq!(result.status, "approved");
        assert_eq!(result.audit_id.as_deref(), Some(audit_id));
        assert!(result.approval_id.is_none());
    }

    #[tokio::test]
    async fn scoped_rejection_keeps_the_operator_note_in_the_store() {
        let store = Arc::new(crate::approval_store::InMemoryApprovalStore::new());
        let handler = StorageBackedApprovalHandler::new(store.clone());
        let request = scoped_request();
        let pending = handler.request_approval(&request).await.unwrap();
        let id = pending.audit_id.unwrap();
        let note = "Sample internal review note";
        assert!(store.resolve(&id, false, Some(note.into())).await.unwrap());

        let decision = handler
            .check_approval_for_call(&pending.approval_id.unwrap(), &request)
            .await
            .unwrap();
        assert_eq!(decision.status, "rejected");
        assert_eq!(decision.audit_id.as_deref(), Some(id.as_str()));
        assert!(decision.reason.is_none());
        assert!(decision.approval_id.is_none());
        assert_eq!(
            store
                .get_result(&id)
                .await
                .unwrap()
                .unwrap()
                .reason
                .as_deref(),
            Some(note)
        );
    }

    #[tokio::test]
    async fn status_only_store_remains_queryable_and_declines_scoped_approval() {
        use crate::approval_store::StoreResult;

        struct StatusOnly;

        #[async_trait]
        impl ApprovalStore for StatusOnly {
            async fn save_pending(
                &self,
                _: &str,
                _: &str,
                _: &serde_json::Value,
            ) -> StoreResult<()> {
                Ok(())
            }

            async fn get_result(&self, _: &str) -> StoreResult<Option<ApprovalRecord>> {
                Ok(Some(ApprovalRecord {
                    status: ApprovalStatus::Approved,
                    module_id: "sample.render".into(),
                    reason: None,
                }))
            }

            async fn resolve(&self, _: &str, _: bool, _: Option<String>) -> StoreResult<bool> {
                Ok(true)
            }
        }

        let store = Arc::new(StatusOnly);
        let bridge = crate::APCoreMCP::builder()
            .backend(Arc::new(apcore::Registry::new()))
            .approval_store(store.clone())
            .build();
        assert!(
            matches!(bridge, Err(crate::apcore_mcp::APCoreMCPError::Config(message))
            if message.contains("requires a scoped approval store"))
        );
        let handler = StorageBackedApprovalHandler::new(store);
        let id = Uuid::new_v4().to_string();
        let legacy_status = handler.check_approval(&id).await.unwrap();
        assert_eq!(legacy_status.status, "approved");
        assert!(legacy_status.approval_id.is_none());
        let request = scoped_request();
        assert_eq!(
            handler.request_approval(&request).await.unwrap().status,
            "rejected"
        );
        let credential = format!("{id}.{}", Uuid::new_v4().simple());
        assert_eq!(
            handler
                .check_approval_for_call(&credential, &request)
                .await
                .unwrap()
                .status,
            "rejected"
        );
        assert_eq!(
            handler.check_scoped_approval(&id, None).await.status,
            "rejected"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn phase_b_expiry_enforces_both_deadlines_without_a_sweeper() {
        use std::time::Duration;

        for (resolved_ttl, pending_ttl) in [(60, 5), (5, 60)] {
            let store = Arc::new(crate::approval_store::InMemoryApprovalStore::with_options(
                Duration::from_secs(resolved_ttl),
                Duration::from_secs(pending_ttl),
                10,
            ));
            let handler = StorageBackedApprovalHandler::new(store.clone());
            let request = scoped_request();
            let result = handler.request_approval(&request).await.unwrap();
            let audit_id = result.audit_id.as_deref().unwrap();
            let credential = result.approval_id.as_deref().unwrap();
            assert!(store.resolve(audit_id, true, None).await.unwrap());
            tokio::time::advance(Duration::from_secs(5)).await;
            assert_eq!(
                handler
                    .check_approval_for_call(credential, &request)
                    .await
                    .unwrap()
                    .status,
                "rejected"
            );
            assert!(store.get_result(audit_id).await.unwrap().is_none());
        }
    }

    /// Create a mock elicit callback that returns the given action.
    fn mock_elicit(action: ElicitAction) -> ElicitCallback {
        Box::new(move |_msg, _schema| {
            let action = action.clone();
            Box::pin(async move {
                Some(ElicitResult {
                    action,
                    content: None,
                })
            })
        })
    }

    /// Create a mock elicit callback that returns `None`.
    fn mock_elicit_none() -> ElicitCallback {
        Box::new(|_msg, _schema| Box::pin(async { None }))
    }

    /// Create a mock [`ApprovalRequest`] for testing.
    ///
    /// Attaches a default `Context` so the request reaches the
    /// elicitation path. [D10-005] requires the handler to reject
    /// unconditionally when `request.context.is_none()`.
    fn test_request() -> ApprovalRequest {
        use apcore::{Context, Identity};
        let mut req = ApprovalRequest::default();
        req.module_id = "test.dangerous_tool".to_string();
        req.arguments = json!({"path": "/etc/passwd"});
        req.description = Some("Delete a system file".to_string());
        req.tags = vec!["destructive".to_string()];
        req.context = Some(Context::new(Identity::new(
            "u1".into(),
            "user".into(),
            vec![],
            Default::default(),
        )));
        req
    }

    // -- request_approval tests -----------------------------------------------

    #[tokio::test]
    async fn test_request_approval_accepted() {
        let handler = ElicitationApprovalHandler::new(Some(mock_elicit(ElicitAction::Accept)));
        let result = handler.request_approval(&test_request()).await.unwrap();
        assert_eq!(result.status, "approved");
        assert!(result.reason.is_none());
    }

    #[tokio::test]
    async fn test_request_approval_sends_nonempty_schema() {
        // The approval elicitation must carry a non-empty object schema; an
        // empty schema breaks form-rendering clients (Cursor / Codex).
        let captured: Arc<Mutex<Option<serde_json::Value>>> = Arc::new(Mutex::new(None));
        let captured_clone = captured.clone();
        let cb: ElicitCallback = Box::new(move |_msg, schema| {
            let captured = captured_clone.clone();
            Box::pin(async move {
                *captured.lock().unwrap() = schema;
                Some(ElicitResult {
                    action: ElicitAction::Accept,
                    content: None,
                })
            })
        });
        let handler = ElicitationApprovalHandler::new(Some(cb));
        handler.request_approval(&test_request()).await.unwrap();

        let schema = captured
            .lock()
            .unwrap()
            .clone()
            .expect("schema must be sent");
        assert_eq!(schema["type"], "object");
        assert!(schema["properties"]["approve"].is_object());
    }

    #[tokio::test]
    async fn test_request_approval_accept_but_approve_false() {
        // action=accept with content.approve=false must reject.
        let cb: ElicitCallback = Box::new(move |_msg, _schema| {
            Box::pin(async move {
                Some(ElicitResult {
                    action: ElicitAction::Accept,
                    content: Some(json!({"approve": false})),
                })
            })
        });
        let handler = ElicitationApprovalHandler::new(Some(cb));
        let result = handler.request_approval(&test_request()).await.unwrap();
        assert_eq!(result.status, "rejected");
    }

    #[tokio::test]
    async fn test_request_approval_accept_with_approve_true() {
        // action=accept with content.approve=true must approve.
        let cb: ElicitCallback = Box::new(move |_msg, _schema| {
            Box::pin(async move {
                Some(ElicitResult {
                    action: ElicitAction::Accept,
                    content: Some(json!({"approve": true})),
                })
            })
        });
        let handler = ElicitationApprovalHandler::new(Some(cb));
        let result = handler.request_approval(&test_request()).await.unwrap();
        assert_eq!(result.status, "approved");
    }

    /// [A-D-AP-5] A present-but-unparseable `approve` must fail closed.
    ///
    /// `as_bool().unwrap_or(true)` used to GRANT approval for `null`, `0` and
    /// `""` — the wrong direction on a safety gate, and the opposite of
    /// Python's `bool(...)` and TypeScript's `Boolean(...)`.
    #[tokio::test]
    async fn test_request_approval_accept_with_falsy_approve_is_rejected() {
        for falsy in [json!(null), json!(0), json!(""), json!([]), json!({})] {
            let value = falsy.clone();
            let cb: ElicitCallback = Box::new(move |_msg, _schema| {
                let value = value.clone();
                Box::pin(async move {
                    Some(ElicitResult {
                        action: ElicitAction::Accept,
                        content: Some(json!({"approve": value})),
                    })
                })
            });
            let handler = ElicitationApprovalHandler::new(Some(cb));
            let result = handler.request_approval(&test_request()).await.unwrap();
            assert_eq!(
                result.status, "rejected",
                "approve={falsy} must be rejected, not approved"
            );
        }
    }

    /// Truthy non-bools stay approved, matching Python's `bool(1)` /
    /// `bool("yes")` and TypeScript's `Boolean(..)`.
    #[tokio::test]
    async fn test_request_approval_accept_with_truthy_approve_is_approved() {
        for truthy in [json!(1), json!("yes")] {
            let value = truthy.clone();
            let cb: ElicitCallback = Box::new(move |_msg, _schema| {
                let value = value.clone();
                Box::pin(async move {
                    Some(ElicitResult {
                        action: ElicitAction::Accept,
                        content: Some(json!({"approve": value})),
                    })
                })
            });
            let handler = ElicitationApprovalHandler::new(Some(cb));
            let result = handler.request_approval(&test_request()).await.unwrap();
            assert_eq!(
                result.status, "approved",
                "approve={truthy} must be approved"
            );
        }
    }

    /// An absent `approve` field still means approval — accept alone approves
    /// in all three SDKs.
    #[tokio::test]
    async fn test_request_approval_accept_without_approve_field_is_approved() {
        let cb: ElicitCallback = Box::new(move |_msg, _schema| {
            Box::pin(async move {
                Some(ElicitResult {
                    action: ElicitAction::Accept,
                    content: Some(json!({"other": 1})),
                })
            })
        });
        let handler = ElicitationApprovalHandler::new(Some(cb));
        let result = handler.request_approval(&test_request()).await.unwrap();
        assert_eq!(result.status, "approved");
    }

    #[tokio::test]
    async fn test_request_approval_declined() {
        let handler = ElicitationApprovalHandler::new(Some(mock_elicit(ElicitAction::Decline)));
        let result = handler.request_approval(&test_request()).await.unwrap();
        assert_eq!(result.status, "rejected");
        assert_eq!(result.reason.as_deref(), Some("User action: decline"));
    }

    #[tokio::test]
    async fn test_request_approval_cancelled() {
        let handler = ElicitationApprovalHandler::new(Some(mock_elicit(ElicitAction::Cancel)));
        let result = handler.request_approval(&test_request()).await.unwrap();
        assert_eq!(result.status, "rejected");
        assert_eq!(result.reason.as_deref(), Some("User action: cancel"));
    }

    #[tokio::test]
    async fn test_request_approval_no_callback() {
        // [D10-005] `test_request()` attaches a context, so the
        // "No context available" branch is skipped and we hit the
        // missing-callback branch instead.
        let handler = ElicitationApprovalHandler::new(None);
        let result = handler.request_approval(&test_request()).await.unwrap();
        assert_eq!(result.status, "rejected");
        assert_eq!(
            result.reason.as_deref(),
            Some("No elicitation callback available")
        );
    }

    #[tokio::test]
    async fn test_request_approval_has_context_no_callback() {
        // When context is present but no callback, falls through to the callback check.
        use apcore::Context;
        let handler = ElicitationApprovalHandler::new(None);
        let mut request = test_request();
        request.context = Some(Context::new(apcore::Identity::new(
            "u1".into(),
            "user".into(),
            vec![],
            Default::default(),
        )));
        let result = handler.request_approval(&request).await.unwrap();
        assert_eq!(result.status, "rejected");
        assert_eq!(
            result.reason.as_deref(),
            Some("No elicitation callback available")
        );
    }

    #[tokio::test]
    async fn test_request_approval_callback_none() {
        let handler = ElicitationApprovalHandler::new(Some(mock_elicit_none()));
        let result = handler.request_approval(&test_request()).await.unwrap();
        assert_eq!(result.status, "rejected");
        assert_eq!(
            result.reason.as_deref(),
            Some("Elicitation returned no response")
        );
    }

    // -- elicit callback panic-catching test (Ru-W2) ---------------------------

    #[tokio::test]
    async fn test_elicit_callback_panic_is_caught() {
        // [Ru-W2] The production code already uses `futures::FutureExt::catch_unwind`
        // (lines 118-131). A panicking callback must be caught and degraded to a
        // rejected ApprovalResult, NOT propagate as a panic.
        let panic_cb: ElicitCallback = Box::new(|_msg, _schema| {
            Box::pin(async move {
                panic!("elicit callback panicked intentionally");
            })
        });
        use apcore::{Context, Identity};
        let handler = ElicitationApprovalHandler::new(Some(panic_cb));
        let req = {
            let mut r = ApprovalRequest::default();
            r.module_id = "test_module".to_string();
            r.arguments = serde_json::json!({});
            // [D10-005] Context required so we reach the elicit path.
            r.context = Some(Context::new(Identity::new(
                "u1".into(),
                "user".into(),
                vec![],
                Default::default(),
            )));
            r
        };
        let result = handler.request_approval(&req).await;
        assert!(
            result.is_ok(),
            "panicking callback must not propagate as Err"
        );
        let approval = result.unwrap();
        assert_eq!(
            approval.status, "rejected",
            "panicking callback must yield rejected status"
        );
        assert_eq!(
            approval.reason.as_deref(),
            Some("Elicitation request failed"),
            "panic rejection reason must be 'Elicitation request failed'"
        );
    }

    // -- check_approval tests -------------------------------------------------

    #[tokio::test]
    async fn test_check_approval_always_rejected() {
        let handler = ElicitationApprovalHandler::new(None);
        let result = handler.check_approval("any-id-123").await.unwrap();
        assert_eq!(result.status, "rejected");
        assert_eq!(
            result.reason.as_deref(),
            Some("Phase B not supported via MCP elicitation")
        );
    }

    // -- message format test --------------------------------------------------

    #[tokio::test]
    async fn test_approval_message_format() {
        let captured_msg = Arc::new(Mutex::new(String::new()));
        let captured_clone = captured_msg.clone();
        let cb: ElicitCallback = Box::new(move |msg, _schema| {
            let captured = captured_clone.clone();
            Box::pin(async move {
                *captured.lock().unwrap() = msg;
                Some(ElicitResult {
                    action: ElicitAction::Accept,
                    content: None,
                })
            })
        });

        let handler = ElicitationApprovalHandler::new(Some(cb));
        let request = test_request();
        handler.request_approval(&request).await.unwrap();

        let msg = captured_msg.lock().unwrap().clone();
        assert!(
            msg.contains("test.dangerous_tool"),
            "message should contain module_id"
        );
        assert!(
            msg.contains("Delete a system file"),
            "message should contain description"
        );
        assert!(
            msg.contains("/etc/passwd"),
            "message should contain arguments"
        );
    }

    // -- Issue D10-001/D10-002: context-not-present rejection branch ----------

    #[tokio::test]
    async fn test_request_approval_no_context_no_callback_returns_rejected() {
        // D10-002: When no context AND no callback, result must be Ok(rejected),
        // not Err. Reason must indicate "No context available for elicitation".
        let handler = ElicitationApprovalHandler::new(None);
        let request = {
            let mut r = ApprovalRequest::default();
            r.module_id = "test.tool".to_string();
            r.arguments = json!({});
            r
        };
        let result = handler.request_approval(&request).await.unwrap();
        assert_eq!(result.status, "rejected");
        assert_eq!(
            result.reason.as_deref(),
            Some("No context available for elicitation"),
            "should return 'No context available for elicitation' when context is None and no callback"
        );
    }

    // -- Issue D10-005: unconditional rejection on missing context ------------

    #[tokio::test]
    async fn test_request_approval_no_context_with_callback_returns_rejected() {
        // [D10-005] Python and TypeScript unconditionally reject when
        // `request.context` is None — the elicit callback is NEVER
        // invoked because the security-gated approval handler should not
        // act without an identity/context attached to the request. Rust
        // previously special-cased the branch and only rejected when
        // both context and elicit were absent, so it would call the
        // callback for `context == None` if a constructor-injected
        // `elicit` was present. This is a cross-language behavioral
        // divergence on a security-sensitive surface.
        use std::sync::atomic::{AtomicBool, Ordering};
        let callback_called = Arc::new(AtomicBool::new(false));
        let flag = callback_called.clone();
        let cb: ElicitCallback = Box::new(move |_msg, _schema| {
            let flag = flag.clone();
            Box::pin(async move {
                flag.store(true, Ordering::SeqCst);
                Some(ElicitResult {
                    action: ElicitAction::Accept,
                    content: None,
                })
            })
        });
        let handler = ElicitationApprovalHandler::new(Some(cb));
        let request = {
            let mut r = ApprovalRequest::default();
            r.module_id = "test.tool".to_string();
            r.arguments = json!({});
            // context intentionally None
            r
        };
        let result = handler.request_approval(&request).await.unwrap();
        assert_eq!(result.status, "rejected");
        assert_eq!(
            result.reason.as_deref(),
            Some("No context available for elicitation"),
            "missing context must reject regardless of callback availability"
        );
        assert!(
            !callback_called.load(Ordering::SeqCst),
            "elicit callback must NOT be invoked when context is None"
        );
    }

    // -- Issue D11-020: Unknown action variant maps to rejected ---------------

    #[tokio::test]
    async fn test_unknown_action_maps_to_rejected_with_reason() {
        // D11-020: Unknown action strings must map to rejected with the
        // raw action string in the reason.
        let action_str = "unknown-action";
        let action = ElicitAction::Unknown(action_str.to_string());
        let cb: ElicitCallback = Box::new(move |_msg, _schema| {
            let a = action.clone();
            Box::pin(async move {
                Some(ElicitResult {
                    action: a,
                    content: None,
                })
            })
        });
        let handler = ElicitationApprovalHandler::new(Some(cb));
        let result = handler.request_approval(&test_request()).await.unwrap();
        assert_eq!(result.status, "rejected");
        assert_eq!(
            result.reason.as_deref(),
            Some("User action: unknown-action"),
            "unknown action must be rejected with 'User action: <raw_string>'"
        );
    }

    #[test]
    fn test_unknown_action_deserializes_from_unknown_string() {
        // D11-020: Unknown action strings must not cause deserialization error.
        let raw = r#"{"action": "unknown-action"}"#;
        let result: ElicitResult = serde_json::from_str(raw).unwrap();
        assert_eq!(
            result.action,
            ElicitAction::Unknown("unknown-action".to_string())
        );
    }

    // -- Issue D11-019 partial: arguments formatted as JSON (not debug repr) -

    #[tokio::test]
    async fn test_approval_message_arguments_formatted_as_json() {
        // D11-019: Arguments must be formatted as JSON (e.g. {"key":"val"}),
        // not as Rust debug repr. serde_json's Display uses JSON format — correct.
        let captured_msg = Arc::new(Mutex::new(String::new()));
        let captured_clone = captured_msg.clone();
        let cb: ElicitCallback = Box::new(move |msg, _schema| {
            let captured = captured_clone.clone();
            Box::pin(async move {
                *captured.lock().unwrap() = msg;
                Some(ElicitResult {
                    action: ElicitAction::Accept,
                    content: None,
                })
            })
        });

        use apcore::{Context, Identity};
        let handler = ElicitationApprovalHandler::new(Some(cb));
        let request = {
            let mut r = ApprovalRequest::default();
            r.module_id = "test.tool".to_string();
            r.arguments = json!({"key": "val"});
            // [D10-005] Context required so we reach the elicit path.
            r.context = Some(Context::new(Identity::new(
                "u1".into(),
                "user".into(),
                vec![],
                Default::default(),
            )));
            r
        };
        handler.request_approval(&request).await.unwrap();

        let msg = captured_msg.lock().unwrap().clone();
        // JSON format: {"key":"val"} — must contain the key in JSON, not Rust debug
        assert!(
            msg.contains("\"key\""),
            "arguments must be JSON-formatted in message: {msg}"
        );
        assert!(
            msg.contains("\"val\""),
            "arguments must be JSON-formatted in message: {msg}"
        );
    }

    // -- Debug impl test ------------------------------------------------------

    #[test]
    fn test_debug_with_callback() {
        let handler = ElicitationApprovalHandler::new(Some(mock_elicit(ElicitAction::Accept)));
        let debug_str = format!("{:?}", handler);
        assert!(debug_str.contains("has_elicit: true"));
    }

    #[test]
    fn test_debug_without_callback() {
        let handler = ElicitationApprovalHandler::new(None);
        let debug_str = format!("{:?}", handler);
        assert!(debug_str.contains("has_elicit: false"));
    }
}
