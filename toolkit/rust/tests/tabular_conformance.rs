// Cross-language conformance harness for `format_csv` and `format_jsonl`.
//
// Reads the shared corpus at `apcore-toolkit/conformance/fixtures/` (used by
// Python and TypeScript SDKs as well) and asserts byte-identical output.

use std::path::PathBuf;

use apcore_toolkit::{format_csv, format_jsonl};
use serde_json::{Map, Value};

fn conformance_dir() -> PathBuf {
    std::env::var_os("CONFORMANCE_FIXTURES").map_or_else(
        || PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../conformance/fixtures"),
        PathBuf::from,
    )
}

fn load_fixture(name: &str) -> Vec<Value> {
    let path = conformance_dir().join(name);
    let content = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "cannot read conformance fixture {}: {error}",
            path.display()
        )
    });
    let doc: Value = serde_json::from_str(&content).expect("fixture must be valid JSON");
    doc["test_cases"].as_array().cloned().unwrap_or_default()
}

fn rows_from_value(v: &Value) -> Vec<Map<String, Value>> {
    v.as_array()
        .expect("rows must be a JSON array")
        .iter()
        .map(|row| row.as_object().expect("each row must be an object").clone())
        .collect()
}

#[test]
fn format_csv_matches_shared_conformance_fixture() {
    let cases = load_fixture("format_csv.json");
    assert!(!cases.is_empty(), "the shared fixture must contain cases");
    for case in cases {
        let id = case["id"].as_str().unwrap_or("(no-id)");
        let rows = rows_from_value(&case["input"]["rows"]);
        let bom = case["input"]["bom"].as_bool().unwrap_or(false);
        let expected = case["expected"].as_str().expect("expected must be string");
        let actual = format_csv(&rows, bom);
        assert_eq!(
            actual, expected,
            "{}: byte mismatch\nexpected: {:?}\nactual:   {:?}",
            id, expected, actual
        );
    }
}

#[test]
fn format_jsonl_matches_shared_conformance_fixture() {
    let cases = load_fixture("format_jsonl.json");
    assert!(!cases.is_empty(), "the shared fixture must contain cases");
    for case in cases {
        let id = case["id"].as_str().unwrap_or("(no-id)");
        let rows = rows_from_value(&case["input"]["rows"]);
        let expected = case["expected"].as_str().expect("expected must be string");
        let actual = format_jsonl(&rows);
        assert_eq!(
            actual, expected,
            "{}: byte mismatch\nexpected: {:?}\nactual:   {:?}",
            id, expected, actual
        );
    }
}
