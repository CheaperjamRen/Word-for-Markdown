use markdown_document_app_lib::{configure_test_builder, configure_test_builder_with_app_data};
use serde_json::{json, Value};
use std::fs;
use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY},
    webview::InvokeRequest,
    WebviewWindowBuilder,
};
use tempfile::tempdir;

fn invoke(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    body: Value,
) -> Result<Value, Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "http://tauri.localhost".parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().unwrap())
}

fn assert_invalid_request_failure(result: Result<Value, Value>) {
    let error = result.expect_err("malformed request unexpectedly reached handler");
    assert_eq!(
        error,
        json!({
            "code": "invalid-request",
            "affectedPaths": [],
            "recoveryPaths": [],
            "draftId": null
        })
    );
}

#[test]
fn generated_handler_uses_the_shared_strict_nested_wire_contract() {
    assert!(
        std::env::var_os("MARKDOWN_SPIKE_METRICS_PATH").is_none(),
        "generated-handler test must not inherit a metrics output path"
    );
    let dir = tempdir().unwrap();
    let document_path = dir.path().join("handler.md");
    fs::write(&document_path, b"# A").unwrap();
    let document_path = document_path.to_string_lossy().into_owned();
    let mut wire: Value =
        serde_json::from_str(include_str!("../../fixtures/contracts/desktop-wire.json")).unwrap();
    assert_eq!(
        wire["events"]["openDocumentRequests"],
        "open-document-requests"
    );
    assert!(wire.get("openEventPayload").is_some());
    assert!(wire["openEventPayload"].is_null());

    let app = configure_test_builder(mock_builder())
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    wire["openInvoke"]["request"]["path"] = json!(document_path);
    let opened = invoke(
        &webview,
        wire["commands"]["openDocument"].as_str().unwrap(),
        wire["openInvoke"].clone(),
    )
    .unwrap();
    wire["saveInvoke"]["request"]["canonicalPath"] = opened["canonicalPath"].clone();
    wire["saveInvoke"]["request"]["expectedVersion"] = opened["version"].clone();
    wire["paintInvoke"]["request"]["path"] = opened["canonicalPath"].clone();

    for (command_key, body_key) in [
        ("takeOpenRequests", "takeOpenRequestsInvoke"),
        ("saveDocument", "saveInvoke"),
        ("recordFirstReadablePaint", "paintInvoke"),
    ] {
        invoke(
            &webview,
            wire["commands"][command_key].as_str().unwrap(),
            wire[body_key].clone(),
        )
        .unwrap_or_else(|error| panic!("valid {command_key} body failed: {error}"));
    }

    for (command_key, body_key) in [
        ("takeOpenRequests", "takeOpenRequestsInvoke"),
        ("openDocument", "openInvoke"),
        ("saveDocument", "saveInvoke"),
        ("recordFirstReadablePaint", "paintInvoke"),
    ] {
        let mut body = wire[body_key].clone();
        body["request"]["unexpected"] = json!(true);
        assert_invalid_request_failure(invoke(
            &webview,
            wire["commands"][command_key].as_str().unwrap(),
            body,
        ));
    }

    let mut nested_version = wire["saveInvoke"].clone();
    nested_version["request"]["expectedVersion"]["unexpected"] = json!(true);
    assert_invalid_request_failure(invoke(
        &webview,
        wire["commands"]["saveDocument"].as_str().unwrap(),
        nested_version,
    ));

    let mut nested_ui = wire["paintInvoke"].clone();
    nested_ui["request"]["uiContract"]["unexpected"] = json!("16px");
    assert_invalid_request_failure(invoke(
        &webview,
        wire["commands"]["recordFirstReadablePaint"]
            .as_str()
            .unwrap(),
        nested_ui,
    ));

    let mut missing_request = wire["openInvoke"].clone();
    missing_request.as_object_mut().unwrap().remove("request");
    assert_invalid_request_failure(invoke(
        &webview,
        wire["commands"]["openDocument"].as_str().unwrap(),
        missing_request,
    ));

    let missing = invoke(&webview, "missing_command", json!({})).unwrap_err();
    assert!(
        missing
            .to_string()
            .to_ascii_lowercase()
            .contains("not found"),
        "expected command-not-found error, got {missing}"
    );
}

#[test]
fn generated_lifecycle_handlers_use_injected_roots_and_strict_nested_requests() {
    let dir = tempdir().unwrap();
    let app_data = dir.path().join("app-data");
    let source = dir.path().join("source.md");
    let save_as = dir.path().join("saved.md");
    fs::write(&source, b"# A").unwrap();
    let mut wire: Value =
        serde_json::from_str(include_str!("../../fixtures/contracts/desktop-wire.json")).unwrap();
    let app = configure_test_builder_with_app_data(mock_builder(), app_data.clone())
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    wire["saveAsInvoke"]["request"]["targetPath"] = json!(save_as.to_string_lossy().into_owned());
    invoke(
        &webview,
        wire["commands"]["saveDocumentAs"].as_str().unwrap(),
        wire["saveAsInvoke"].clone(),
    )
    .unwrap();
    let draft = invoke(
        &webview,
        wire["commands"]["writeDraft"].as_str().unwrap(),
        wire["writeDraftInvoke"].clone(),
    )
    .unwrap();
    assert!(draft["updatedMs"].as_u64().is_some());
    assert_eq!(
        invoke(
            &webview,
            wire["commands"]["listDrafts"].as_str().unwrap(),
            wire["listDraftsInvoke"].clone(),
        )
        .unwrap()
        .as_array()
        .unwrap()
        .len(),
        1
    );
    invoke(
        &webview,
        wire["commands"]["readDraft"].as_str().unwrap(),
        wire["readDraftInvoke"].clone(),
    )
    .unwrap();
    invoke(
        &webview,
        wire["commands"]["deleteDraft"].as_str().unwrap(),
        wire["deleteDraftInvoke"].clone(),
    )
    .unwrap();

    wire["watchDocumentInvoke"]["request"]["canonicalPath"] =
        json!(source.to_string_lossy().into_owned());
    let watched = invoke(
        &webview,
        wire["commands"]["watchDocument"].as_str().unwrap(),
        wire["watchDocumentInvoke"].clone(),
    )
    .unwrap();
    wire["unwatchDocumentInvoke"]["request"]["watchId"] = watched["watchId"].clone();
    invoke(
        &webview,
        wire["commands"]["unwatchDocument"].as_str().unwrap(),
        wire["unwatchDocumentInvoke"].clone(),
    )
    .unwrap();
    invoke(
        &webview,
        wire["commands"]["unwatchDocument"].as_str().unwrap(),
        wire["unwatchDocumentInvoke"].clone(),
    )
    .unwrap();

    for (command_key, body_key) in [
        ("saveDocumentAs", "saveAsInvoke"),
        ("writeDraft", "writeDraftInvoke"),
        ("listDrafts", "listDraftsInvoke"),
        ("readDraft", "readDraftInvoke"),
        ("deleteDraft", "deleteDraftInvoke"),
        ("watchDocument", "watchDocumentInvoke"),
        ("unwatchDocument", "unwatchDocumentInvoke"),
    ] {
        let mut body = wire[body_key].clone();
        body["request"]["unexpected"] = json!(true);
        assert_invalid_request_failure(invoke(
            &webview,
            wire["commands"][command_key].as_str().unwrap(),
            body,
        ));
    }

    let mut nested = wire["writeDraftInvoke"].clone();
    nested["request"]["draft"]["unexpected"] = json!(true);
    assert_invalid_request_failure(invoke(
        &webview,
        wire["commands"]["writeDraft"].as_str().unwrap(),
        nested,
    ));
    let mut missing = wire["watchDocumentInvoke"].clone();
    missing["request"]
        .as_object_mut()
        .unwrap()
        .remove("canonicalPath");
    assert_invalid_request_failure(invoke(
        &webview,
        wire["commands"]["watchDocument"].as_str().unwrap(),
        missing,
    ));
    assert_invalid_request_failure(invoke(
        &webview,
        wire["commands"]["saveDocumentAs"].as_str().unwrap(),
        json!({}),
    ));
}
