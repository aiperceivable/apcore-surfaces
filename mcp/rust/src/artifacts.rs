//! Local, authority-bound MCP resource artifacts.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use apcore::Identity;
use regex::Regex;

pub const ARTIFACT_URI_PREFIX: &str = "apcore-artifact://";

#[derive(Debug, thiserror::Error)]
pub enum ArtifactStoreError {
    #[error("Artifact limits and expiry must be positive")]
    InvalidLimits,
    #[error("Artifact content exceeds the size limit")]
    TooLarge,
    #[error("Artifact name must be a printable filename")]
    InvalidName,
    #[error("Artifact MIME type is invalid")]
    InvalidMediaType,
    #[error("An authenticated artifact owner is required")]
    MissingOwner,
    #[error("Artifact store is full")]
    Full,
    #[error("Artifact store unavailable")]
    Unavailable,
}

#[derive(PartialEq, Eq)]
struct Authority {
    issuer: Option<String>,
    identity_type: String,
    id: String,
    roles: Vec<String>,
    key: Option<String>,
}

impl From<&Identity> for Authority {
    fn from(identity: &Identity) -> Self {
        let mut roles = identity.roles().to_vec();
        roles.sort_unstable();
        Self {
            issuer: identity.issuer().map(str::to_owned),
            identity_type: identity.identity_type().to_owned(),
            id: identity.id().to_owned(),
            roles,
            key: identity.authority_key(),
        }
    }
}

pub(crate) struct Artifact {
    pub(crate) bytes: Vec<u8>,
    pub(crate) name: String,
    pub(crate) mime_type: String,
    owner: Authority,
    expires_at: Instant,
}

/// In-memory artifact storage owned by an opt-in MCP application.
pub struct MCPArtifactStore {
    max_bytes: usize,
    max_entries: usize,
    ttl: Duration,
    items: Mutex<HashMap<String, Arc<Artifact>>>,
}

impl Default for MCPArtifactStore {
    fn default() -> Self {
        Self {
            max_bytes: 8_388_608,
            max_entries: 16,
            ttl: Duration::from_secs(300),
            items: Mutex::default(),
        }
    }
}

impl MCPArtifactStore {
    /// Create a store with a size limit per artifact, an entry limit and an expiry.
    pub fn with_limits(
        max_bytes: usize,
        max_entries: usize,
        ttl: Duration,
    ) -> Result<Self, ArtifactStoreError> {
        if max_bytes == 0
            || max_entries == 0
            || ttl.is_zero()
            || Instant::now().checked_add(ttl).is_none()
        {
            return Err(ArtifactStoreError::InvalidLimits);
        }
        Ok(Self {
            max_bytes,
            max_entries,
            ttl,
            items: Mutex::default(),
        })
    }

    /// Register owned bytes for a trusted authenticated identity and return an opaque key.
    pub fn put(
        &self,
        bytes: Vec<u8>,
        name: &str,
        mime_type: &str,
        owner: &Identity,
    ) -> Result<String, ArtifactStoreError> {
        static FILENAME: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"\A[^\p{C}/\\]{1,200}\z").expect("constant filename pattern")
        });
        static MEDIA_TYPE: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"\A[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+\z")
                .expect("constant MIME pattern")
        });
        if bytes.len() > self.max_bytes {
            return Err(ArtifactStoreError::TooLarge);
        }
        if !FILENAME.is_match(name) {
            return Err(ArtifactStoreError::InvalidName);
        }
        if mime_type.len() > 127 || !MEDIA_TYPE.is_match(mime_type) {
            return Err(ArtifactStoreError::InvalidMediaType);
        }
        if owner.id().is_empty() {
            return Err(ArtifactStoreError::MissingOwner);
        }
        let owner = Authority::from(owner);
        let mut items = self
            .items
            .lock()
            .map_err(|_| ArtifactStoreError::Unavailable)?;
        let now = Instant::now();
        let expires_at = now
            .checked_add(self.ttl)
            .ok_or(ArtifactStoreError::InvalidLimits)?;
        items.retain(|_, item| item.expires_at > now);
        if items.len() >= self.max_entries {
            return Err(ArtifactStoreError::Full);
        }
        let key = uuid::Uuid::new_v4().simple().to_string();
        items.insert(
            key.clone(),
            Arc::new(Artifact {
                bytes,
                name: name.to_owned(),
                mime_type: mime_type.to_owned(),
                owner,
                expires_at,
            }),
        );
        Ok(key)
    }

    pub(crate) fn read_uri(&self, uri: &str, identity: Option<&Identity>) -> Option<Arc<Artifact>> {
        let identity = identity?;
        let key = uri.strip_prefix(ARTIFACT_URI_PREFIX)?;
        if key.len() != 32
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return None;
        }
        let mut items = self.items.lock().ok()?;
        let result = items.get(key)?;
        if result.expires_at <= Instant::now() {
            items.remove(key);
            return None;
        }
        (result.owner == Authority::from(identity)).then(|| Arc::clone(result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_external_references_and_reclaims_expired_capacity() {
        let owner = Identity::new("owner".into(), "user".into(), vec![], HashMap::new());
        let store = MCPArtifactStore::with_limits(3, 1, Duration::from_secs(1)).unwrap();
        assert!(matches!(
            store.put(vec![0; 4], "good", "text/plain", &owner),
            Err(ArtifactStoreError::TooLarge)
        ));
        assert!(matches!(
            store.put(vec![0], "../bad", "text/plain", &owner),
            Err(ArtifactStoreError::InvalidName)
        ));
        assert!(matches!(
            store.put(vec![0], "good", "text/plain\n", &owner),
            Err(ArtifactStoreError::InvalidMediaType)
        ));
        let key = store.put(vec![0], "good", "text/plain", &owner).unwrap();
        let uri = format!("{ARTIFACT_URI_PREFIX}{key}");
        assert!(store.read_uri("file:///tmp/good", Some(&owner)).is_none());
        assert!(store.read_uri(&uri, None).is_none());
        assert!(store.read_uri(&uri, Some(&owner)).is_some());
        assert!(matches!(
            store.put(vec![0], "good", "text/plain", &owner),
            Err(ArtifactStoreError::Full)
        ));
        Arc::get_mut(store.items.lock().unwrap().get_mut(&key).unwrap())
            .unwrap()
            .expires_at = Instant::now();
        assert!(store.read_uri(&uri, Some(&owner)).is_none());
        assert!(store.put(vec![0], "good", "text/plain", &owner).is_ok());
    }
}
