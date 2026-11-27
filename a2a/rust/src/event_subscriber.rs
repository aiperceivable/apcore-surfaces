//! Opt-in A2A HTTP transport for the Core event emitter.

use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use apcore::{
    register_subscriber_type, ApCoreEvent, ErrorCode, EventRetryConfig, EventSubscriber,
    ModuleError,
};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};
use serde_json::{json, Value};

const DEFAULT_SKILL_ID: &str = "apevo.event_receiver";
const DEFAULT_TIMEOUT_MS: u64 = 5_000;
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

/// Sends one A2A HTTP event delivery attempt. The APCore emitter controls retries.
#[derive(Clone)]
pub struct A2AEventSubscriber {
    id: String,
    platform_url: String,
    headers: HeaderMap,
    timeout_ms: u64,
    skill_id: String,
    retry: EventRetryConfig,
}

impl A2AEventSubscriber {
    /// Create a subscriber with the default timeout and receiver skill.
    pub fn new(platform_url: impl Into<String>) -> Self {
        let number = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        Self {
            id: format!("a2a-{number}"),
            platform_url: platform_url.into(),
            headers: HeaderMap::new(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
            skill_id: DEFAULT_SKILL_ID.into(),
            retry: EventRetryConfig::default(),
        }
    }

    /// Set the headers to merge into the delivery request.
    #[must_use]
    pub fn with_headers(mut self, headers: HeaderMap) -> Self {
        self.headers = headers;
        self
    }

    /// Set the subscriber ID exposed to the event emitter.
    #[must_use]
    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = id.into();
        self
    }

    /// Set the per-attempt request timeout in milliseconds.
    #[must_use]
    pub fn with_timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.timeout_ms = timeout_ms;
        self
    }

    /// Set the A2A receiver skill included in the payload.
    #[must_use]
    pub fn with_skill_id(mut self, skill_id: impl Into<String>) -> Self {
        self.skill_id = skill_id.into();
        self
    }

    /// Set the Core emitter's retry configuration for this subscriber.
    #[must_use]
    pub fn with_retry(mut self, retry: EventRetryConfig) -> Self {
        self.retry = retry;
        self
    }
}

impl fmt::Debug for A2AEventSubscriber {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("A2AEventSubscriber")
            .field("id", &self.id)
            .field("timeout_ms", &self.timeout_ms)
            .field("skill_id", &self.skill_id)
            .field("retry", &self.retry)
            .finish_non_exhaustive()
    }
}

#[async_trait::async_trait]
impl EventSubscriber for A2AEventSubscriber {
    fn subscriber_id(&self) -> &str {
        &self.id
    }

    fn subscriber_type(&self) -> &'static str {
        "a2a"
    }

    fn retry(&self) -> EventRetryConfig {
        self.retry
    }

    async fn on_event(&self, event: &ApCoreEvent) -> Result<(), ModuleError> {
        let payload = json!({
            "skillId": self.skill_id,
            "event": {
                "event_type": event.event_type,
                "module_id": event.module_id,
                "timestamp": event.timestamp,
                "severity": event.severity,
                "data": event.data,
            }
        });
        let response = http_client()?
            .post(&self.platform_url)
            .timeout(Duration::from_millis(self.timeout_ms))
            .headers(self.headers.clone())
            .json(&payload)
            .send()
            .await
            .map_err(|error| {
                let message = if error.is_timeout() {
                    "A2A event delivery timed out"
                } else {
                    "A2A event delivery failed"
                };
                ModuleError::new(ErrorCode::GeneralInternalError, message)
            })?;
        let status = response.status();
        if status.is_server_error() {
            return Err(ModuleError::new(
                ErrorCode::GeneralInternalError,
                format!("A2A event delivery failed with HTTP {}", status.as_u16()),
            ));
        }
        if status.is_client_error() {
            tracing::warn!(status = status.as_u16(), event_type = %event.event_type, "A2A event rejected");
        }
        Ok(())
    }
}

/// Select the A2A transport for future `type: a2a` configuration entries.
/// Existing subscriptions are owned by their original emitter.
pub fn register_a2a_subscriber() {
    register_subscriber_type("a2a", Box::new(from_config));
}

#[allow(clippy::result_large_err)] // The Core factory contract uses ModuleError.
fn from_config(config: &Value) -> Result<Box<dyn EventSubscriber>, ModuleError> {
    let url = config["platform_url"]
        .as_str()
        .filter(|url| !url.trim().is_empty())
        .ok_or_else(|| {
            ModuleError::new(ErrorCode::ConfigInvalid, "a2a: 'platform_url' is required")
        })?;
    let timeout_ms = config["timeout_ms"].as_u64().unwrap_or(DEFAULT_TIMEOUT_MS);
    let skill_id = config["skill_id"].as_str().unwrap_or(DEFAULT_SKILL_ID);
    let mut subscriber = A2AEventSubscriber::new(url)
        .with_headers(auth_headers(&config["auth"])?)
        .with_skill_id(skill_id)
        .with_timeout_ms(timeout_ms)
        .with_retry(retry_config(&config["retry"]));
    if let Some(id) = config["id"].as_str() {
        subscriber = subscriber.with_id(id);
    }
    Ok(Box::new(subscriber))
}

#[allow(clippy::result_large_err)] // Invalid authentication is a Core configuration error.
fn auth_headers(value: &Value) -> Result<HeaderMap, ModuleError> {
    let invalid = || {
        ModuleError::new(
            ErrorCode::ConfigInvalid,
            "a2a: invalid authentication header",
        )
    };
    let mut headers = HeaderMap::new();
    match value {
        Value::String(token) => {
            let mut header =
                HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| invalid())?;
            header.set_sensitive(true);
            headers.insert(AUTHORIZATION, header);
        }
        Value::Object(values) => {
            for (name, value) in values {
                if let Some(value) = value.as_str() {
                    let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid())?;
                    let mut header = HeaderValue::from_str(value).map_err(|_| invalid())?;
                    if name == AUTHORIZATION {
                        header.set_sensitive(true);
                    }
                    headers.insert(name, header);
                }
            }
        }
        _ => {}
    }
    Ok(headers)
}

fn retry_config(value: &Value) -> EventRetryConfig {
    let defaults = EventRetryConfig::default();
    EventRetryConfig {
        max_attempts: value["max_attempts"]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(defaults.max_attempts),
        initial_backoff_ms: value["initial_backoff_ms"]
            .as_u64()
            .unwrap_or(defaults.initial_backoff_ms),
        max_backoff_ms: value["max_backoff_ms"]
            .as_u64()
            .unwrap_or(defaults.max_backoff_ms),
        backoff_multiplier: value["backoff_multiplier"]
            .as_f64()
            .unwrap_or(defaults.backoff_multiplier),
    }
}

#[allow(clippy::result_large_err)] // The subscriber returns ModuleError to the emitter.
fn http_client() -> Result<&'static reqwest::Client, ModuleError> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder().no_proxy().build().map_err(|_| {
        ModuleError::new(
            ErrorCode::GeneralInternalError,
            "A2A HTTP client initialization failed",
        )
    })?;
    Ok(CLIENT.get_or_init(|| client))
}
