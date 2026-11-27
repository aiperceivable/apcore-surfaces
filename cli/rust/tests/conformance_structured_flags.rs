use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use apcore::{Config, Context, Executor, Module, ModuleError, Registry};
use apcore_cli::discovery::{ApCoreRegistryProvider, RegistryProvider};
use apcore_cli::{
    build_module_command, dispatch_module_with_options, DispatchOptions, ErrorStream,
};
use serde::Deserialize;
use serde_json::{json, Value};

const MODULE: &str = "fixture.echo";

#[derive(Deserialize)]
struct Fixture {
    schema: Value,
    test_cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    id: String,
    args: Vec<String>,
    expected: Expected,
}

#[derive(Deserialize)]
struct Expected {
    exit_code: i32,
    calls: usize,
    input: Option<Value>,
}

struct Echo {
    schema: Value,
    calls: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl Module for Echo {
    fn input_schema(&self) -> Value {
        self.schema.clone()
    }

    fn output_schema(&self) -> Value {
        json!({"type": "object"})
    }

    fn description(&self) -> &'static str {
        "Echo the arguments received from the generated CLI command"
    }

    async fn execute(
        &self,
        inputs: Value,
        _context: &Context<Value>,
    ) -> Result<Value, ModuleError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(inputs)
    }
}

async fn run_case(schema: &Value, args: &[String], id: &str, expected: &Expected) {
    let calls = Arc::new(AtomicUsize::new(0));
    let registry = || {
        let registry = Registry::new();
        registry
            .register_module(
                MODULE,
                Box::new(Echo {
                    schema: schema.clone(),
                    calls: Arc::clone(&calls),
                }),
            )
            .unwrap();
        registry
    };
    let provider = ApCoreRegistryProvider::new(registry());
    let executor = Executor::new(registry(), Config::default());
    let descriptor = provider.get_module_descriptor(MODULE).unwrap();
    let matches = build_module_command(&descriptor)
        .unwrap()
        .try_get_matches_from(std::iter::once(MODULE).chain(args.iter().map(String::as_str)))
        .unwrap();
    let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let options = DispatchOptions {
        print_result: false,
        error_stream: ErrorStream::Custom(Arc::new({
            let observed = Arc::clone(&observed);
            move |message| observed.lock().unwrap().push(message.to_owned())
        })),
        ..DispatchOptions::default()
    };
    let result =
        dispatch_module_with_options(MODULE, &matches, &provider, &executor, &options).await;
    let errors = observed.lock().unwrap();
    assert_eq!(
        calls.load(Ordering::SeqCst),
        expected.calls,
        "{id}: {result:?} {errors:?}"
    );
    if expected.exit_code == 0 {
        assert_eq!(result, Ok(expected.input.clone()), "{id}: {errors:?}");
        assert!(errors.is_empty(), "{id}: {errors:?}");
    } else {
        assert_eq!(result, Err(expected.exit_code), "{id}: {errors:?}");
        assert!(
            errors
                .iter()
                .any(|error| error.contains("SCHEMA_VALIDATION_ERROR")),
            "{id}: {errors:?}"
        );
    }
}

#[tokio::test]
async fn generated_commands_decode_structured_flags_from_shared_fixture() {
    let root = std::env::var_os("APCORE_CLI_SPEC_REPO")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."));
    let path = root.join("conformance/fixtures/structured_flags.json");
    let source = std::fs::read(&path).unwrap_or_else(|error| {
        panic!("read fixture {}: {error}", path.display());
    });
    let fixture: Fixture = serde_json::from_slice(&source).expect("parse structured flag fixture");
    for case in fixture.test_cases {
        run_case(&fixture.schema, &case.args, &case.id, &case.expected).await;
    }
}

#[tokio::test]
async fn structured_defaults_follow_json_input_and_explicit_flag_precedence() {
    let schema = json!({
        "type": "object",
        "properties": {
            "filters": {"$ref": "#/$defs/Filters"},
            "labels": {"type": "array", "items": {"type": "string"}, "default": ["schema"]},
        },
        "$defs": {"Filters": {"type": "object", "default": {"source": "schema"}}},
        "required": ["filters", "labels"],
    });
    let json_input = [
        "--input",
        r#"{"filters":{"source":"input"},"labels":["input"]}"#,
    ];
    for (id, args, output) in [
        (
            "native defaults",
            vec![],
            json!({"filters": {"source": "schema"}, "labels": ["schema"]}),
        ),
        (
            "input before defaults",
            json_input.to_vec(),
            json!({"filters": {"source": "input"}, "labels": ["input"]}),
        ),
        (
            "flags before input",
            [&json_input[..], &["--filters", r#"{"source":"flag"}"#]].concat(),
            json!({"filters": {"source": "flag"}, "labels": ["input"]}),
        ),
    ] {
        let args: Vec<String> = args.into_iter().map(str::to_owned).collect();
        run_case(
            &schema,
            &args,
            id,
            &Expected {
                exit_code: 0,
                calls: 1,
                input: Some(output),
            },
        )
        .await;
    }
}

#[tokio::test]
async fn composition_and_reference_siblings_keep_container_flags_typed() {
    let schema = json!({
        "type": "object",
        "properties": {
            "filters": {"allOf": [{"$ref": "#/$defs/Filters"}]},
            "labels": {"$ref": "#/$defs/Labels", "default": ["adjacent"]},
        },
        "$defs": {
            "Filters": {"type": "object"},
            "Labels": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["filters", "labels"],
    });
    run_case(
        &schema,
        &["--filters".into(), "{\"active\":true}".into()],
        "composed container and adjacent default",
        &Expected {
            exit_code: 0,
            calls: 1,
            input: Some(json!({"filters": {"active": true}, "labels": ["adjacent"]})),
        },
    )
    .await;
}
