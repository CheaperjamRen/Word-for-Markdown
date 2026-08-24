use serde_json::Value;

fn configured_windows() -> Vec<Value> {
    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .expect("tauri.conf.json must stay valid JSON");
    config["app"]["windows"]
        .as_array()
        .expect("app.windows must be an array")
        .clone()
}

fn source_slice<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
    let start_index = source.find(start).expect("source start marker missing");
    let tail = &source[start_index..];
    let end_index = tail.find(end).expect("source end marker missing");
    &tail[..end_index]
}

#[test]
fn config_creates_one_hidden_provisional_main_window() {
    let windows = configured_windows();
    let created: Vec<_> = windows
        .iter()
        .filter(|window| window.get("create").and_then(Value::as_bool) != Some(false))
        .collect();

    assert_eq!(
        created.len(),
        1,
        "exactly one startup window may be created"
    );
    let main = created[0];
    assert_eq!(main.get("label").and_then(Value::as_str), Some("main"));
    assert_eq!(main.get("width").and_then(Value::as_u64), Some(800));
    assert_eq!(main.get("height").and_then(Value::as_u64), Some(400));
    assert_eq!(main.get("minWidth").and_then(Value::as_u64), Some(640));
    assert_eq!(main.get("minHeight").and_then(Value::as_u64), Some(400));
    assert_eq!(
        main.get("visible").and_then(Value::as_bool),
        Some(false),
        "the provisional window must stay hidden until work-area geometry is applied"
    );
    assert_ne!(main.get("maximized").and_then(Value::as_bool), Some(true));
    assert_ne!(main.get("fullscreen").and_then(Value::as_bool), Some(true));
}

#[test]
fn startup_geometry_is_production_only_and_absent_from_second_instance_routing() {
    let source = include_str!("../src/lib.rs");
    assert_eq!(
        source.matches("StartupWindowMode::InitializeMain").count(),
        1,
        "only run() may request live startup geometry"
    );

    let first_test_builder = source_slice(
        source,
        "pub fn configure_test_builder<",
        "pub fn configure_test_builder_with_app_data<",
    );
    assert!(first_test_builder.contains("StartupWindowMode::Disabled"));

    let second_test_builder = source_slice(
        source,
        "pub fn configure_test_builder_with_app_data<",
        "#[cfg_attr(mobile, tauri::mobile_entry_point)]",
    );
    assert!(second_test_builder.contains("StartupWindowMode::Disabled"));

    let single_instance = source_slice(
        source,
        "tauri_plugin_single_instance::init",
        "configure_command_builder(",
    );
    for forbidden in [
        "initialize_startup_window",
        "initialize_tauri_startup_window",
        "StartupWindowMode::InitializeMain",
    ] {
        assert!(
            !single_instance.contains(forbidden),
            "second-instance routing must not contain {forbidden}"
        );
    }
}

#[test]
fn sole_setup_initializes_only_the_production_main_window() {
    let source = include_str!("../src/lib.rs");
    assert_eq!(
        source.matches(".setup(").count(),
        1,
        "draft state and startup geometry must share the sole setup hook"
    );
    let configure_builder = source_slice(
        source,
        "fn configure_command_builder<",
        "pub fn configure_test_builder<",
    );

    assert!(configure_builder.contains("startup_window_mode != StartupWindowMode::Disabled"));
    assert!(configure_builder.contains("get_webview_window(\"main\")"));
    assert!(configure_builder.contains("initialize_tauri_startup_window(&window)"));
}
