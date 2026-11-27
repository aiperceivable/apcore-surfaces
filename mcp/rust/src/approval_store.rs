//! ApprovalStore: pluggable persistence trait for Phase B approval polling.
//!
//! Users implement `ApprovalStore` (Redis, DB, etc.).
//! `InMemoryApprovalStore` is provided for testing and local development only.

use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use apcore::{ApprovalRequest, Identity};
use async_trait::async_trait;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, Notify};
use tokio::time::Instant;

/// Convenience alias for the store's fallible operations.
pub type StoreResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// Status of an approval record.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Rejected,
}

impl std::fmt::Display for ApprovalStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::Approved => write!(f, "approved"),
            Self::Rejected => write!(f, "rejected"),
        }
    }
}

/// A snapshot of an approval record (fields available to callers).
#[derive(Debug, Clone)]
pub struct ApprovalRecord {
    pub status: ApprovalStatus,
    pub module_id: String,
    pub reason: Option<String>,
}

/// The authenticated identity used to scope approval records.
#[derive(Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ApprovalPrincipal {
    pub identity_type: String,
    pub id: String,
}

impl From<&Identity> for ApprovalPrincipal {
    fn from(identity: &Identity) -> Self {
        Self {
            identity_type: identity.identity_type().to_owned(),
            id: identity.id().to_owned(),
        }
    }
}

/// The stable parts of the invocation for which approval was requested.
#[derive(Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ApprovalScope {
    pub module_id: String,
    pub caller_id: Option<String>,
    pub principal: Option<ApprovalPrincipal>,
    pub arguments_sha256: [u8; 32],
}

impl From<&ApprovalRequest> for ApprovalScope {
    fn from(request: &ApprovalRequest) -> Self {
        let mut arguments = request.arguments.clone();
        arguments.sort_all_objects();
        Self {
            module_id: request.module_id.clone(),
            caller_id: request.caller_id.clone(),
            principal: request
                .context
                .as_ref()
                .and_then(|context| context.identity.as_ref())
                .map(ApprovalPrincipal::from),
            arguments_sha256: Sha256::digest(arguments.to_string().as_bytes()).into(),
        }
    }
}

/// SHA-256 verifier for the confidential resume credential.
pub type ApprovalVerifier = [u8; 32];

/// Pluggable storage for Phase B approval state.
#[async_trait]
pub trait ApprovalStore: Send + Sync + 'static {
    /// Persist a new pending approval record.
    async fn save_pending(
        &self,
        approval_id: &str,
        module_id: &str,
        arguments: &serde_json::Value,
    ) -> StoreResult<()>;

    /// Return the current record, or None if approval_id is unknown.
    async fn get_result(&self, approval_id: &str) -> StoreResult<Option<ApprovalRecord>>;

    /// Mark approval_id as approved or rejected.
    /// Returns false if the id is unknown or already resolved.
    async fn resolve(
        &self,
        approval_id: &str,
        approved: bool,
        reason: Option<String>,
    ) -> StoreResult<bool>;

    /// Persist a scoped record under its public audit ID without holding the credential.
    /// Status-only stores reject this operation by default.
    async fn save_scoped_pending(
        &self,
        _audit_id: &str,
        _verifier: &ApprovalVerifier,
        _scope: &ApprovalScope,
    ) -> StoreResult<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "scoped approval storage unavailable",
        )
        .into())
    }

    /// Read a scoped status only when the record belongs to this principal.
    /// An absent principal is the anonymous scope.
    async fn get_scoped_result(
        &self,
        _audit_id: &str,
        _principal: Option<&ApprovalPrincipal>,
    ) -> StoreResult<Option<ApprovalRecord>> {
        Ok(None)
    }

    /// Match the verifier and invocation scope, check expiry, and consume an
    /// approved credential within one transaction. Pending results remain
    /// available. Unknown, expired, mismatched, or consumed records yield None.
    async fn consume_scoped(
        &self,
        _audit_id: &str,
        _verifier: &ApprovalVerifier,
        _scope: &ApprovalScope,
    ) -> StoreResult<Option<ApprovalRecord>> {
        Ok(None)
    }

    /// Start a background TTL sweep for this store, returning the spawned
    /// task handle (or `None` if the store needs no sweeping).
    ///
    /// Called once from an async context when the MCP server starts. The
    /// default implementation is a no-op (returns `None`), which suits
    /// external stores (Redis, DB) that manage their own expiry. The
    /// in-process [`InMemoryApprovalStore`] overrides this to evict stale
    /// pending/resolved records.
    fn start_sweep(&self) -> Option<tokio::task::JoinHandle<()>> {
        None
    }
}

// ── InMemoryApprovalStore ────────────────────────────────────────────────────

struct InternalRecord {
    status: ApprovalStatus,
    module_id: String,
    reason: Option<String>,
    created_at: Instant,
    resolved_at: Option<Instant>,
    notify: Arc<Notify>,
    scoped: Option<ScopedApproval>,
}

struct ScopedApproval {
    verifier: Option<ApprovalVerifier>,
    scope: ApprovalScope,
}

impl InternalRecord {
    fn expired(&self, now: Instant, pending_ttl: Duration, resolved_ttl: Duration) -> bool {
        now.duration_since(self.created_at) >= pending_ttl
            || self
                .resolved_at
                .is_some_and(|time| now.duration_since(time) >= resolved_ttl)
    }

    fn snapshot(&self) -> ApprovalRecord {
        ApprovalRecord {
            status: self.status.clone(),
            module_id: self.module_id.clone(),
            reason: self.reason.clone(),
        }
    }
}

/// In-process approval store for testing and local development.
///
/// NOT suitable for production.
///
/// The pending TTL caps the lifetime of a record. The resolved TTL can shorten
/// the lifetime after a decision. Reads and writes enforce both deadlines.
/// The optional background sweep removes expired records that are never read.
pub struct InMemoryApprovalStore {
    records: Arc<Mutex<HashMap<String, InternalRecord>>>,
    resolved_ttl: Duration,
    pending_ttl: Duration,
    max_records: usize,
}

impl InMemoryApprovalStore {
    pub fn new() -> Self {
        Self::with_options(Duration::from_secs(120), Duration::from_secs(3600), 10_000)
    }

    pub fn with_options(resolved_ttl: Duration, pending_ttl: Duration, max_records: usize) -> Self {
        Self {
            records: Arc::new(Mutex::new(HashMap::new())),
            resolved_ttl,
            pending_ttl,
            max_records,
        }
    }

    /// Start a background sweep task. Call once from async context.
    pub fn start_sweep_task(&self) -> tokio::task::JoinHandle<()> {
        let records = Arc::clone(&self.records);
        let pending_ttl = self.pending_ttl;
        let resolved_ttl = self.resolved_ttl;
        tokio::spawn(async move {
            let interval = Duration::from_secs(300);
            loop {
                tokio::time::sleep(interval).await;
                let mut map = records.lock().await;
                let now = Instant::now();
                map.retain(|_, record| !record.expired(now, pending_ttl, resolved_ttl));
            }
        })
    }

    fn evict_oldest_pending(map: &mut HashMap<String, InternalRecord>) {
        let oldest = map
            .iter()
            .filter(|(_, r)| r.status == ApprovalStatus::Pending)
            .min_by_key(|(_, r)| r.created_at)
            .map(|(id, _)| id.clone());
        if let Some(id) = oldest {
            map.remove(&id);
        }
    }

    fn live_record<'a>(
        &self,
        records: &'a mut HashMap<String, InternalRecord>,
        audit_id: &str,
    ) -> Option<&'a mut InternalRecord> {
        let now = Instant::now();
        if records
            .get(audit_id)
            .is_some_and(|record| record.expired(now, self.pending_ttl, self.resolved_ttl))
        {
            records.remove(audit_id);
        }
        records.get_mut(audit_id)
    }

    async fn insert_pending(
        &self,
        audit_id: &str,
        module_id: &str,
        scoped: Option<ScopedApproval>,
    ) -> StoreResult<()> {
        let mut records = self.records.lock().await;
        let now = Instant::now();
        records.retain(|_, record| !record.expired(now, self.pending_ttl, self.resolved_ttl));
        if records.contains_key(audit_id) {
            return Err(
                io::Error::new(io::ErrorKind::AlreadyExists, "approval record exists").into(),
            );
        }
        if records.len() >= self.max_records {
            Self::evict_oldest_pending(&mut records);
            if records.len() >= self.max_records {
                return Err(io::Error::other("approval store is at capacity").into());
            }
        }
        records.insert(
            audit_id.to_owned(),
            InternalRecord {
                status: ApprovalStatus::Pending,
                module_id: module_id.to_owned(),
                reason: None,
                created_at: now,
                resolved_at: None,
                notify: Arc::new(Notify::new()),
                scoped,
            },
        );
        Ok(())
    }
}

impl Default for InMemoryApprovalStore {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ApprovalStore for InMemoryApprovalStore {
    async fn save_pending(
        &self,
        approval_id: &str,
        module_id: &str,
        _arguments: &serde_json::Value,
    ) -> StoreResult<()> {
        self.insert_pending(approval_id, module_id, None).await
    }

    async fn get_result(&self, approval_id: &str) -> StoreResult<Option<ApprovalRecord>> {
        let mut records = self.records.lock().await;
        Ok(self
            .live_record(&mut records, approval_id)
            .map(|record| record.snapshot()))
    }

    async fn resolve(
        &self,
        approval_id: &str,
        approved: bool,
        reason: Option<String>,
    ) -> StoreResult<bool> {
        let mut records = self.records.lock().await;
        let Some(rec) = self.live_record(&mut records, approval_id) else {
            return Ok(false);
        };
        if rec.status != ApprovalStatus::Pending {
            return Ok(false);
        }
        rec.status = if approved {
            ApprovalStatus::Approved
        } else {
            ApprovalStatus::Rejected
        };
        rec.reason = reason;
        rec.resolved_at = Some(Instant::now());
        rec.notify.notify_waiters();

        Ok(true)
    }

    async fn save_scoped_pending(
        &self,
        audit_id: &str,
        verifier: &ApprovalVerifier,
        scope: &ApprovalScope,
    ) -> StoreResult<()> {
        self.insert_pending(
            audit_id,
            &scope.module_id,
            Some(ScopedApproval {
                verifier: Some(*verifier),
                scope: scope.clone(),
            }),
        )
        .await
    }

    async fn get_scoped_result(
        &self,
        audit_id: &str,
        principal: Option<&ApprovalPrincipal>,
    ) -> StoreResult<Option<ApprovalRecord>> {
        let mut records = self.records.lock().await;
        let result = self.live_record(&mut records, audit_id).and_then(|record| {
            let scope = &record.scoped.as_ref()?.scope;
            (scope.principal.as_ref() == principal).then(|| record.snapshot())
        });
        Ok(result)
    }

    async fn consume_scoped(
        &self,
        audit_id: &str,
        verifier: &ApprovalVerifier,
        scope: &ApprovalScope,
    ) -> StoreResult<Option<ApprovalRecord>> {
        let mut records = self.records.lock().await;
        let result = self.live_record(&mut records, audit_id).and_then(|record| {
            let scoped = record.scoped.as_mut()?;
            let matches_verifier = bool::from(scoped.verifier.as_ref()?.ct_eq(verifier));
            if !matches_verifier || scoped.scope != *scope {
                return None;
            }
            if record.status == ApprovalStatus::Approved {
                scoped.verifier = None;
            }
            Some(record.snapshot())
        });
        Ok(result)
    }

    fn start_sweep(&self) -> Option<tokio::task::JoinHandle<()>> {
        Some(self.start_sweep_task())
    }
}

impl InMemoryApprovalStore {
    /// Wait until an approval is resolved or timeout. Helper for tests.
    pub async fn wait_for_resolution(
        &self,
        approval_id: &str,
        timeout: Duration,
    ) -> Option<ApprovalRecord> {
        let notified = {
            let mut records = self.records.lock().await;
            self.live_record(&mut records, approval_id)
                .filter(|r| r.status == ApprovalStatus::Pending)
                .map(|r| Arc::clone(&r.notify).notified_owned())
        };
        if let Some(notification) = notified {
            let _ = tokio::time::timeout(timeout, notification).await;
        }
        self.get_result(approval_id).await.ok().flatten()
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn save_pending_then_get_result_returns_pending() {
        let store = InMemoryApprovalStore::new();
        store
            .save_pending("abc", "my.module", &json!({"x": 1}))
            .await
            .unwrap();
        let record = store.get_result("abc").await.unwrap().unwrap();
        assert_eq!(record.status, ApprovalStatus::Pending);
        assert_eq!(record.module_id, "my.module");
        assert!(record.reason.is_none());
    }

    #[tokio::test]
    async fn resolve_approved_returns_approved_status() {
        let store = InMemoryApprovalStore::new();
        store
            .save_pending("id1", "mod.a", &json!({}))
            .await
            .unwrap();
        let resolved = store.resolve("id1", true, None).await.unwrap();
        assert!(resolved);
        let record = store.get_result("id1").await.unwrap().unwrap();
        assert_eq!(record.status, ApprovalStatus::Approved);
        assert!(record.reason.is_none());
    }

    #[tokio::test]
    async fn resolve_rejected_with_reason() {
        let store = InMemoryApprovalStore::new();
        store
            .save_pending("id2", "mod.b", &json!({}))
            .await
            .unwrap();
        let resolved = store
            .resolve("id2", false, Some("not allowed".to_string()))
            .await
            .unwrap();
        assert!(resolved);
        let record = store.get_result("id2").await.unwrap().unwrap();
        assert_eq!(record.status, ApprovalStatus::Rejected);
        assert_eq!(record.reason.as_deref(), Some("not allowed"));
    }

    #[tokio::test]
    async fn resolve_unknown_returns_false() {
        let store = InMemoryApprovalStore::new();
        let resolved = store.resolve("nonexistent", true, None).await.unwrap();
        assert!(!resolved);
    }

    #[tokio::test]
    async fn double_resolve_returns_false() {
        let store = InMemoryApprovalStore::new();
        store
            .save_pending("dup", "mod.c", &json!({}))
            .await
            .unwrap();
        let first = store.resolve("dup", true, None).await.unwrap();
        assert!(first);
        // Second resolve on same id must return false (already resolved)
        let second = store.resolve("dup", false, None).await.unwrap();
        assert!(!second);
        // Status must remain approved (not overwritten)
        let record = store.get_result("dup").await.unwrap().unwrap();
        assert_eq!(record.status, ApprovalStatus::Approved);
    }

    #[tokio::test]
    async fn at_max_records_eviction_happens() {
        let store = InMemoryApprovalStore::with_options(
            Duration::from_secs(60),
            Duration::from_secs(3600),
            2, // max 2 records
        );
        store
            .save_pending("first", "mod.a", &json!({}))
            .await
            .unwrap();
        store
            .save_pending("second", "mod.b", &json!({}))
            .await
            .unwrap();
        // Third insert triggers eviction of one pending record
        store
            .save_pending("third", "mod.c", &json!({}))
            .await
            .unwrap();
        // After eviction, at most 2 records should be stored.
        // third must always be present (just inserted)
        let third = store.get_result("third").await.unwrap();
        assert!(third.is_some(), "third must be present after insert");
        // Exactly one of first/second was evicted
        let first = store.get_result("first").await.unwrap();
        let second = store.get_result("second").await.unwrap();
        let remaining = [first.is_some(), second.is_some()]
            .iter()
            .filter(|&&x| x)
            .count();
        assert_eq!(remaining, 1, "one of first/second must have been evicted");
    }

    #[tokio::test]
    async fn wait_for_resolution_unblocks_after_resolve() {
        let store = Arc::new(InMemoryApprovalStore::new());
        store
            .save_pending("wait-id", "mod.w", &json!({}))
            .await
            .unwrap();

        let store_clone = Arc::clone(&store);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            store_clone.resolve("wait-id", true, None).await.unwrap();
        });

        let result = store
            .wait_for_resolution("wait-id", Duration::from_secs(5))
            .await;
        assert!(result.is_some());
        assert_eq!(result.unwrap().status, ApprovalStatus::Approved);
    }
}
