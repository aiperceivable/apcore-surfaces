use std::sync::{Arc, Mutex};
use std::time::Duration;

use apcore::{
    APCore, APCoreOptions, ApCoreEvent, Config, EventSubscriber, ModuleError, SubscriberRegistry,
};
use apcore_a2a::{register_a2a_subscriber, A2AEventSubscriber};
use axum::{extract::State, http::HeaderMap, http::StatusCode, routing::post, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpListener;

const DEAD_LETTER: &str = "apcore.event.delivery_failed";
const CIRCUIT_OPENED: &str = "apcore.subscriber.circuit_opened";

#[derive(Deserialize)]
struct Fixture {
    event: ApCoreEvent,
    test_cases: Vec<FixtureCase>,
}

#[derive(Deserialize)]
struct FixtureCase {
    id: String,
    subscriber: Value,
    status: u16,
    #[serde(default)]
    delay_ms: u64,
    expected: Expected,
}

#[derive(Deserialize)]
struct Expected {
    requests: usize,
    authorization: Option<String>,
    source: Option<String>,
    skill_id: Option<String>,
    dead_letters: usize,
    circuit_opened: usize,
}

#[derive(Debug)]
struct DiagnosticRecorder {
    event_type: &'static str,
    events: Arc<Mutex<Vec<ApCoreEvent>>>,
}

#[async_trait::async_trait]
impl EventSubscriber for DiagnosticRecorder {
    fn event_pattern(&self) -> &str {
        self.event_type
    }

    async fn on_event(&self, event: &ApCoreEvent) -> Result<(), ModuleError> {
        self.events.lock().unwrap().push(event.clone());
        Ok(())
    }
}

struct ReceiverState {
    requests: Mutex<Vec<(HeaderMap, Value)>>,
    status: StatusCode,
    delay_ms: u64,
}

async fn record_request(
    State(state): State<Arc<ReceiverState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> StatusCode {
    state.requests.lock().unwrap().push((headers, payload));
    if state.delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(state.delay_ms)).await;
    }
    state.status
}

async fn emit_from_config(
    subscribers: &SubscriberRegistry,
    subscriber: &Value,
    event: &ApCoreEvent,
) -> Vec<ApCoreEvent> {
    let project = tempfile::tempdir().unwrap();
    let path = project.path().join("apcore.yaml");
    std::fs::write(
        &path,
        format!(
            "version: '1.0.0'\nproject: {{name: event-test}}\nextensions: {{auto_discover: false}}\n\
             sys_modules:\n  enabled: true\n  events:\n    enabled: true\n    subscribers: [{}]\n",
            serde_json::to_string(subscriber).unwrap()
        ),
    )
    .unwrap();
    let client = APCore::try_start_with_subscribers(
        APCoreOptions {
            config: Some(Config::load(&path).unwrap()),
            fail_on_error: true,
            ..Default::default()
        },
        subscribers,
    )
    .unwrap();
    let events = client.events().expect("configured event bus");
    let captured = Arc::new(Mutex::new(Vec::new()));
    for event_type in [DEAD_LETTER, CIRCUIT_OPENED] {
        events.subscribe(Box::new(DiagnosticRecorder {
            event_type,
            events: Arc::clone(&captured),
        }));
    }
    events.emit(event).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        events.flush(0).await.unwrap();
        // A failed delivery can queue a circuit lifecycle event during flush.
        events.flush(0).await.unwrap();
    })
    .await
    .expect("event delivery settles");
    let diagnostics = captured.lock().unwrap().clone();
    diagnostics
}

async fn run_case(subscribers: &SubscriberRegistry, case: &FixtureCase, event: &ApCoreEvent) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/receive", listener.local_addr().unwrap());
    let state = Arc::new(ReceiverState {
        requests: Mutex::new(Vec::new()),
        status: StatusCode::from_u16(case.status).unwrap(),
        delay_ms: case.delay_ms,
    });
    let app = Router::new()
        .route("/receive", post(record_request))
        .with_state(Arc::clone(&state));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut subscriber = case.subscriber.clone();
    if subscriber["type"] == "filter" {
        subscriber["delegate_config"] = json!({ "platform_url": url });
    } else {
        subscriber["id"] = json!("configured-a2a");
        subscriber["platform_url"] = json!(url);
    }

    let diagnostics = emit_from_config(subscribers, &subscriber, event).await;
    assert_eq!(
        diagnostics
            .iter()
            .filter(|event| event.event_type == DEAD_LETTER)
            .count(),
        case.expected.dead_letters,
        "{}: {diagnostics:?}",
        case.id
    );
    assert_eq!(
        diagnostics
            .iter()
            .filter(|event| event.event_type == CIRCUIT_OPENED)
            .count(),
        case.expected.circuit_opened,
        "{}: {diagnostics:?}",
        case.id
    );
    for diagnostic in diagnostics {
        assert_eq!(diagnostic.data["subscriber_type"], "a2a", "{}", case.id);
        assert_eq!(
            diagnostic.data["subscriber_id"], "configured-a2a",
            "{}",
            case.id
        );
    }
    {
        let requests = state.requests.lock().unwrap();
        assert_eq!(requests.len(), case.expected.requests, "{}", case.id);
        for (headers, payload) in requests.iter() {
            let header = |name: &str| headers.get(name).map(|value| value.to_str().unwrap());
            assert_eq!(
                header("content-type"),
                Some("application/json"),
                "{}",
                case.id
            );
            assert_eq!(
                header("authorization"),
                case.expected.authorization.as_deref(),
                "{}",
                case.id
            );
            assert_eq!(
                header("x-source"),
                case.expected.source.as_deref(),
                "{}",
                case.id
            );
            assert_eq!(
                payload,
                &json!({"skillId": case.expected.skill_id, "event": event}),
                "{}",
                case.id
            );
        }
    }

    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn a2a_subscription_is_opt_in_and_uses_core_configured_delivery() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../conformance/fixtures/event_subscriber.json"
    ))
    .unwrap();
    let mut subscribers = SubscriberRegistry::new();
    let other_host = SubscriberRegistry::new();
    let config = json!({"type":"a2a", "platform_url":"https://example.com/receive"});
    assert!(subscribers.create(&config).is_err());
    assert_eq!(
        A2AEventSubscriber::new("https://example.com/receive").subscriber_type(),
        "a2a"
    );
    register_a2a_subscriber(&mut subscribers);
    register_a2a_subscriber(&mut subscribers);
    assert!(format!("{:?}", subscribers.create(&config).unwrap()).starts_with("A2AEventSubscriber"));
    assert!(other_host.create(&config).is_err());

    for case in &fixture.test_cases {
        run_case(&subscribers, case, &fixture.event).await;
    }
}
