//! Conformance: the toolkit `RegistryWriter` preserves behavioral annotations
//! through scan -> register -> get_definition. Locks the governance-critical
//! round-trip that approval/ACL gating (which keys on `requires_approval`)
//! depends on — a real `Registry`, not a mock.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use apcore::module::ModuleAnnotations;
use apcore::{AlwaysDenyHandler, AutoApproveHandler, Config, ErrorCode, Executor, Registry};
use apcore_toolkit::assert_annotations_preserved;
use apcore_toolkit::types::ScannedModule;
use apcore_toolkit::{HandlerFn, RegistryWriter};
use serde_json::json;

fn with_required_approval() -> ScannedModule {
    let mut module = ScannedModule::new(
        "orders.delete_order".into(),
        "Delete an order".into(),
        json!({"type": "object"}),
        json!({"type": "object"}),
        vec!["orders".into()],
        "app:delete_order".into(),
    );
    module.annotations = Some(ModuleAnnotations {
        destructive: true,
        requires_approval: true,
        ..Default::default()
    });

    module
}

#[test]
fn base_writer_preserves_annotations() {
    let registry = Registry::new();
    assert_annotations_preserved(&RegistryWriter::new(), &with_required_approval(), &registry);
}

#[tokio::test]
async fn toolkit_registered_annotation_controls_real_execution() {
    let module = with_required_approval();
    let registry = Arc::new(Registry::new());
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    let handler: HandlerFn = Arc::new(move |_, _| {
        counter.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(json!({"ok": true})) })
    });
    let writer =
        RegistryWriter::with_handler_factory(Arc::new(move |_| Some(Arc::clone(&handler))));
    assert_annotations_preserved(&writer, &module, &registry);

    let mut executor = Executor::new(registry, Config::default());
    executor.set_approval_handler(Box::new(AlwaysDenyHandler));
    let denied = executor
        .call(&module.module_id, json!({}), None, None)
        .await
        .unwrap_err();
    assert_eq!(denied.code, ErrorCode::ApprovalDenied);
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    executor.set_approval_handler(Box::new(AutoApproveHandler));
    let approved = executor
        .call(&module.module_id, json!({}), None, None)
        .await
        .unwrap();
    assert_eq!(approved, json!({"ok": true}));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
