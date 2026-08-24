pub mod draft_store;
mod file_service;
pub mod file_watch;
pub mod lifecycle;
mod metrics;
mod open_request;
pub mod target_service;
mod window_geometry;

use draft_store::{
    delete_draft_at, list_drafts_at, read_draft_at, write_draft_at, DraftIdRequest, DraftRecord,
    WriteDraftRequest,
};
use file_service::{
    read_utf8_document, recoverable_replace_utf8, FileVersion, HostOpenDocument,
    OpenDocumentRequest, SaveDocumentRequest,
};
use file_watch::{
    FileChangedEvent, UnwatchDocumentRequest, WatchDocumentRequest, WatchDocumentResult,
    WatchRegistry,
};
use lifecycle::{
    map_file_error, save_document_as as save_document_as_at, DesktopFailure, DesktopFailureCode,
    SaveDocumentAsRequest, SaveDocumentAsResult,
};
use metrics::{AppClock, RecordFirstReadablePaintRequest};
use open_request::{
    collect_markdown_paths, PendingOpenRequests, TakeOpenRequestsRequest,
    OPEN_DOCUMENT_REQUESTS_EVENT,
};
use serde::de::DeserializeOwned;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use windows_sys::Win32::{
    Foundation::ERROR_SUCCESS,
    System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ},
};
use window_geometry::initialize_tauri_startup_window;

const FILE_CHANGED_EVENT: &str = "document-file-changed";

#[tauri::command]
fn get_ui_language_hint() -> Option<String> {
    let subkey: Vec<u16> = "Software\\MarkdownDocumentApp\0".encode_utf16().collect();
    let value_name: Vec<u16> = "InstallerLanguage\0".encode_utf16().collect();
    let mut byte_count = 0_u32;
    let size_result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value_name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut byte_count,
        )
    };
    if size_result != ERROR_SUCCESS || byte_count < 2 {
        return None;
    }
    let mut buffer = vec![0_u16; (byte_count as usize + 1) / 2];
    let read_result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value_name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut byte_count,
        )
    };
    if read_result != ERROR_SUCCESS {
        return None;
    }
    let end = buffer.iter().position(|unit| *unit == 0).unwrap_or(buffer.len());
    match String::from_utf16_lossy(&buffer[..end]).as_str() {
        "zh-CN" => Some("zh-CN".to_owned()),
        "en-US" => Some("en-US".to_owned()),
        _ => None,
    }
}

struct DraftStoreRoot(PathBuf);
struct FileChangeEmitter(Arc<dyn Fn(FileChangedEvent) + Send + Sync>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartupWindowMode {
    InitializeMain,
    Disabled,
}

fn parse_lifecycle_request<T: DeserializeOwned>(
    request: Option<serde_json::Value>,
) -> Result<T, DesktopFailure> {
    request
        .and_then(|value| serde_json::from_value(value).ok())
        .ok_or_else(|| DesktopFailure::new(DesktopFailureCode::InvalidRequest))
}

#[tauri::command]
fn take_open_requests(
    request: Option<serde_json::Value>,
    state: tauri::State<'_, PendingOpenRequests>,
) -> Result<Vec<String>, DesktopFailure> {
    let _request = parse_lifecycle_request::<TakeOpenRequestsRequest>(request)?;
    Ok(state.take())
}

#[tauri::command]
fn open_document(request: Option<serde_json::Value>) -> Result<HostOpenDocument, DesktopFailure> {
    let request = parse_lifecycle_request::<OpenDocumentRequest>(request)?;
    let path = Path::new(&request.path);
    read_utf8_document(path).map_err(|error| map_file_error(error, path))
}

#[tauri::command]
fn save_document(request: Option<serde_json::Value>) -> Result<FileVersion, DesktopFailure> {
    let request = parse_lifecycle_request::<SaveDocumentRequest>(request)?;
    let path = Path::new(&request.canonical_path);
    recoverable_replace_utf8(path, &request.bytes, &request.expected_version)
        .map_err(|error| map_file_error(error, path))
}

#[tauri::command]
fn save_document_as(
    request: Option<serde_json::Value>,
) -> Result<SaveDocumentAsResult, DesktopFailure> {
    save_document_as_at(parse_lifecycle_request::<SaveDocumentAsRequest>(request)?)
}

#[tauri::command]
fn write_draft(
    state: tauri::State<'_, DraftStoreRoot>,
    request: Option<serde_json::Value>,
) -> Result<DraftRecord, DesktopFailure> {
    let request = parse_lifecycle_request::<WriteDraftRequest>(request)?;
    let updated_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX);
    write_draft_at(&state.0, request.draft, updated_ms)
}

#[tauri::command]
fn list_drafts(
    state: tauri::State<'_, DraftStoreRoot>,
    request: Option<serde_json::Value>,
) -> Result<Vec<DraftRecord>, DesktopFailure> {
    let _request = parse_lifecycle_request::<TakeOpenRequestsRequest>(request)?;
    list_drafts_at(&state.0)
}

#[tauri::command]
fn read_draft(
    state: tauri::State<'_, DraftStoreRoot>,
    request: Option<serde_json::Value>,
) -> Result<DraftRecord, DesktopFailure> {
    let request = parse_lifecycle_request::<DraftIdRequest>(request)?;
    read_draft_at(&state.0, &request.id)
}

#[tauri::command]
fn delete_draft(
    state: tauri::State<'_, DraftStoreRoot>,
    request: Option<serde_json::Value>,
) -> Result<(), DesktopFailure> {
    let request = parse_lifecycle_request::<DraftIdRequest>(request)?;
    delete_draft_at(&state.0, &request.id)
}

#[tauri::command]
fn watch_document(
    state: tauri::State<'_, Mutex<WatchRegistry>>,
    emitter: tauri::State<'_, FileChangeEmitter>,
    request: Option<serde_json::Value>,
) -> Result<WatchDocumentResult, DesktopFailure> {
    let request = parse_lifecycle_request::<WatchDocumentRequest>(request)?;
    let affected = PathBuf::from(&request.canonical_path);
    let mut registry = state.lock().map_err(|_| {
        DesktopFailure::new(DesktopFailureCode::WatchFailed).with_affected(&affected)
    })?;
    let emit = Arc::clone(&emitter.0);
    registry.watch(&affected, move |event: FileChangedEvent| emit(event))
}

#[tauri::command]
fn unwatch_document(
    state: tauri::State<'_, Mutex<WatchRegistry>>,
    request: Option<serde_json::Value>,
) -> Result<(), DesktopFailure> {
    let request = parse_lifecycle_request::<UnwatchDocumentRequest>(request)?;
    state
        .lock()
        .map_err(|_| DesktopFailure::new(DesktopFailureCode::WatchFailed))?
        .unwatch(&request.watch_id)
}

#[tauri::command]
fn record_first_readable_paint(
    state: tauri::State<'_, AppClock>,
    request: Option<serde_json::Value>,
) -> Result<u64, DesktopFailure> {
    let request = parse_lifecycle_request::<RecordFirstReadablePaintRequest>(request)?;
    let metrics_path = std::env::var_os("MARKDOWN_SPIKE_METRICS_PATH").map(PathBuf::from);
    state
        .record(
            &request.path,
            request.application_network_requests,
            request.ui_contract,
            metrics_path.as_deref(),
        )
        .map_err(|error| {
            lifecycle::map_io_error(
                error,
                metrics_path.as_deref().unwrap_or(Path::new("metrics")),
            )
        })
}

#[tauri::command]
fn resolve_target(
    request: Option<serde_json::Value>,
) -> Result<target_service::ResolvedTarget, DesktopFailure> {
    let request = parse_lifecycle_request::<target_service::ResolveTargetRequest>(request)?;
    Ok(target_service::resolve_target(request))
}

fn configure_command_builder<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
    pending: PendingOpenRequests,
    clock: AppClock,
    app_data_root: Option<PathBuf>,
    startup_window_mode: StartupWindowMode,
) -> tauri::Builder<R> {
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(pending)
        .manage(clock)
        .manage(Mutex::new(WatchRegistry::new()));
    let builder = if let Some(root) = app_data_root {
        builder
            .manage(DraftStoreRoot(root))
            .manage(FileChangeEmitter(Arc::new(|_| {})))
    } else {
        builder.setup(move |app| {
            let root = app.path().app_data_dir()?;
            app.manage(DraftStoreRoot(root));
            let emitter_app = app.handle().clone();
            app.manage(FileChangeEmitter(Arc::new(move |event| {
                let _ = emitter_app.emit(FILE_CHANGED_EVENT, event);
            })));
            if startup_window_mode != StartupWindowMode::Disabled {
                let window = app
                    .get_webview_window("main")
                    .ok_or(tauri::Error::WindowNotFound)?;
                initialize_tauri_startup_window(&window)?;
            }
            Ok(())
        })
    };
    builder.invoke_handler(tauri::generate_handler![
        take_open_requests,
        open_document,
        save_document,
        save_document_as,
        write_draft,
        list_drafts,
        read_draft,
        delete_draft,
        watch_document,
        unwatch_document,
        record_first_readable_paint,
        resolve_target,
        get_ui_language_hint
    ])
}

#[doc(hidden)]
pub fn configure_test_builder<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    configure_command_builder(
        builder,
        PendingOpenRequests::default(),
        AppClock::new(),
        None,
        StartupWindowMode::Disabled,
    )
}

#[doc(hidden)]
pub fn configure_test_builder_with_app_data<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
    app_data_root: PathBuf,
) -> tauri::Builder<R> {
    configure_command_builder(
        builder,
        PendingOpenRequests::default(),
        AppClock::new(),
        Some(app_data_root),
        StartupWindowMode::Disabled,
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cwd = std::env::current_dir().expect("current directory unavailable");
    let initial = collect_markdown_paths(std::env::args_os(), &cwd)
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();

    let builder =
        tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let paths: Vec<String> = collect_markdown_paths(args, Path::new(&cwd))
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            if paths.is_empty() {
                return;
            }
            app.state::<PendingOpenRequests>().push(paths);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.emit(OPEN_DOCUMENT_REQUESTS_EVENT, ());
            }
        }));

    configure_command_builder(
        builder,
        PendingOpenRequests::new(initial),
        AppClock::new(),
        None,
        StartupWindowMode::InitializeMain,
    )
    .run(tauri::generate_context!())
    .expect("failed to run Markdown 文档");
}

#[cfg(test)]
mod file_service_tests {
    use super::file_service::*;
    use std::{
        collections::VecDeque,
        fs,
        path::{Path, PathBuf},
    };
    use tempfile::{tempdir, TempDir};

    #[test]
    fn reads_utf8_bom_without_losing_original_bytes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("bom.md");
        let bytes = [b"\xEF\xBB\xBF".as_slice(), "# 标题\r\n".as_bytes()].concat();
        fs::write(&path, &bytes).unwrap();

        let opened = read_utf8_document(&path).unwrap();

        assert_eq!(opened.bytes, bytes);
        assert_eq!(
            opened.canonical_path,
            path.canonicalize().unwrap().to_string_lossy()
        );
    }

    #[test]
    fn rejects_non_utf8_and_files_above_the_document_limit() {
        let dir = tempdir().unwrap();
        let invalid = dir.path().join("invalid.md");
        let too_large = dir.path().join("large.md");
        fs::write(&invalid, [0xff, 0xfe, 0xfd]).unwrap();
        fs::write(&too_large, vec![b'a'; 5 * 1024 * 1024 + 1]).unwrap();

        assert!(matches!(
            read_utf8_document(&invalid),
            Err(FileServiceError::UnsupportedEncoding)
        ));
        assert!(matches!(
            read_utf8_document(&too_large),
            Err(FileServiceError::TooLarge)
        ));
        assert_eq!(
            FileServiceError::UnsupportedEncoding.to_string(),
            "Only unambiguous UTF-8 Markdown is supported"
        );
        assert_eq!(
            FileServiceError::TooLarge.to_string(),
            "Markdown file exceeds the 5 MB limit"
        );
    }

    #[test]
    fn two_unstable_reads_return_changed_while_reading() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("unstable.md");
        fs::write(&path, b"zero").unwrap();

        let error = read_utf8_document_with_hook(&path, |attempt| {
            fs::write(&path, format!("changed-{attempt}-with-new-length")).unwrap();
        })
        .unwrap_err();

        assert!(matches!(error, FileServiceError::ChangedWhileReading));
    }

    #[test]
    fn stale_version_never_overwrites_external_content() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("race.md");
        fs::write(&path, b"baseline").unwrap();
        let opened = read_utf8_document(&path).unwrap();
        fs::write(&path, b"external").unwrap();

        let error = recoverable_replace_utf8(&path, b"local", &opened.version).unwrap_err();

        assert!(error.to_string().contains("changed externally"));
        assert_eq!(fs::read(&path).unwrap(), b"external");
        assert!(transaction_paths(dir.path()).is_empty());
    }

    #[test]
    fn change_immediately_before_replace_restores_external_and_preserves_local() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("final-race.md");
        fs::write(&path, b"baseline").unwrap();
        let opened = read_utf8_document(&path).unwrap();

        let error = recoverable_replace_utf8_with_hooks(
            &path,
            b"local",
            &opened.version,
            || {
                fs::write(&path, b"late external").unwrap();
            },
            || {},
            || {},
            || {},
            || {},
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("changed during Windows replacement"));
        assert_eq!(fs::read(&path).unwrap(), b"late external");
        assert!(recovery_contents(&error)
            .iter()
            .any(|bytes| bytes == b"local"));
    }

    #[test]
    fn writer_immediately_before_rollback_keeps_both_external_generations_and_local() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("rollback-race.md");
        fs::write(&path, b"baseline").unwrap();
        let opened = read_utf8_document(&path).unwrap();

        let error = recoverable_replace_utf8_with_hooks(
            &path,
            b"local",
            &opened.version,
            || {
                fs::write(&path, b"late external").unwrap();
            },
            || {},
            || {},
            || {},
            || {
                fs::write(&path, b"newest external").unwrap();
            },
        )
        .unwrap_err();

        assert_eq!(fs::read(&path).unwrap(), b"late external");
        let recovered = recovery_contents(&error);
        assert!(recovered.iter().any(|bytes| bytes == b"local"));
        assert!(recovered.iter().any(|bytes| bytes == b"newest external"));
    }

    #[test]
    fn writer_after_replace_keeps_newest_target_and_expected_plus_local_recovery() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("post-replace-race.md");
        fs::write(&path, b"baseline").unwrap();
        let opened = read_utf8_document(&path).unwrap();

        let error = recoverable_replace_utf8_with_hooks(
            &path,
            b"local",
            &opened.version,
            || {},
            || {
                fs::write(&path, b"newest external").unwrap();
            },
            || {},
            || {},
            || {},
        )
        .unwrap_err();

        assert_eq!(fs::read(&path).unwrap(), b"newest external");
        let recovered = recovery_contents(&error);
        assert!(recovered.iter().any(|bytes| bytes == b"local"));
        assert!(recovered.iter().any(|bytes| bytes == b"baseline"));
    }

    #[test]
    fn writer_after_initial_validation_cannot_be_returned_as_a_successful_baseline() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cleanup-window.md");
        fs::write(&path, b"baseline").unwrap();
        let opened = read_utf8_document(&path).unwrap();

        let error = recoverable_replace_utf8_with_hooks(
            &path,
            b"local",
            &opened.version,
            || {},
            || {},
            || {
                fs::write(&path, b"external before cleanup").unwrap();
            },
            || {},
            || {},
        )
        .unwrap_err();

        assert_eq!(fs::read(&path).unwrap(), b"external before cleanup");
        let recovered = recovery_contents(&error);
        assert!(recovered.iter().any(|bytes| bytes == b"local"));
        assert!(recovered.iter().any(|bytes| bytes == b"baseline"));
    }

    #[cfg(windows)]
    #[test]
    fn final_target_identity_cannot_be_replaced_after_final_snapshot() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("final-target-guard.md");
        let external = dir.path().join("external-replacement.md");
        fs::write(&path, b"baseline").unwrap();
        fs::write(&external, b"late external").unwrap();
        let opened = read_utf8_document(&path).unwrap();
        let replace_result = std::cell::RefCell::new(None);

        let saved = recoverable_replace_utf8_with_hooks(
            &path,
            b"local",
            &opened.version,
            || {},
            || {},
            || {},
            || {
                *replace_result.borrow_mut() =
                    Some(replace_target_without_backup(&path, &external));
            },
            || {},
        )
        .unwrap();

        let replace_result = replace_result.into_inner().unwrap();
        assert!(
            replace_result.is_err(),
            "external ReplaceFileW unexpectedly succeeded; target={:?}, external_exists={}",
            fs::read(&path).ok(),
            external.exists()
        );
        assert_eq!(fs::read(&path).unwrap(), b"local");
        assert_eq!(fs::read(&external).unwrap(), b"late external");
        assert_eq!(saved.sha256, sha256_hex(b"local"));
        assert!(transaction_paths(dir.path()).is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn preexisting_shared_writer_to_replaced_identity_forces_recovery_not_cleanup() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("shared-writer.md");
        fs::write(&path, b"baseline").unwrap();
        let opened = read_utf8_document(&path).unwrap();
        let writer = open_shared_windows_writer(&path).unwrap();

        let error = recoverable_replace_utf8_with_hooks(
            &path,
            b"local",
            &opened.version,
            || {},
            || {},
            || {},
            || {},
            || {},
        )
        .unwrap_err();
        assert!(matches!(&error, FileServiceError::ConcurrentWriter { .. }));

        write_all_through_existing_handle(&writer, b"external through old identity").unwrap();
        drop(writer);

        let recovered = recovery_contents(&error);
        assert!(recovered
            .iter()
            .any(|bytes| bytes == b"external through old identity"));
        assert!(recovered.iter().any(|bytes| bytes == b"local"));
    }

    #[test]
    fn every_documented_replace_failure_preserves_each_unique_version() {
        for outcome in [
            ScriptedReplaceOutcome::FailUnchanged(1175),
            ScriptedReplaceOutcome::FailUnchanged(1176),
            ScriptedReplaceOutcome::FailMovedTargetToBackup(1177),
            ScriptedReplaceOutcome::FailUnchanged(87),
        ] {
            let fixture = ReplaceFixture::new(b"expected", b"candidate");
            let mut backend = ScriptedReplaceBackend::new([outcome]);
            let error = fixture.run(&mut backend).unwrap_err();
            assert_versions_recoverable(
                &fixture,
                &error,
                [b"expected".as_slice(), b"candidate".as_slice()],
            );
        }
    }

    #[test]
    fn rollback_replace_failure_preserves_local_and_raced_external_generation() {
        let fixture = ReplaceFixture::new(b"expected", b"candidate");
        let mut backend = ScriptedReplaceBackend::new([
            ScriptedReplaceOutcome::Success,
            ScriptedReplaceOutcome::FailMovedTargetToBackup(1177),
        ]);
        let target = fixture.target.clone();

        let error = fixture
            .run_with_hooks(
                &mut backend,
                || {
                    fs::write(&target, b"external-one").unwrap();
                },
                || {},
                || {},
                || {},
                || {},
            )
            .unwrap_err();

        assert_versions_recoverable(
            &fixture,
            &error,
            [b"candidate".as_slice(), b"external-one".as_slice()],
        );
    }

    #[test]
    fn verified_replace_cleans_files_only_after_target_and_backup_match() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("success.md");
        fs::write(&path, b"baseline").unwrap();
        let opened = read_utf8_document(&path).unwrap();

        let saved = recoverable_replace_utf8(&path, b"local", &opened.version).unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"local");
        assert_eq!(saved.sha256, sha256_hex(b"local"));
        assert!(transaction_paths(dir.path()).is_empty());
    }

    #[test]
    fn actual_open_and_save_types_accept_the_shared_fixture() {
        let wire: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/contracts/desktop-wire.json"))
                .unwrap();
        let open: OpenDocumentRequest =
            serde_json::from_value(wire["openInvoke"]["request"].clone()).unwrap();
        let opened: HostOpenDocument =
            serde_json::from_value(wire["openDocument"].clone()).unwrap();
        let save: SaveDocumentRequest =
            serde_json::from_value(wire["saveInvoke"]["request"].clone()).unwrap();

        assert_eq!(open.path, opened.canonical_path);
        assert_eq!(save.expected_version, opened.version);
        assert_eq!(save.canonical_path, opened.canonical_path);
    }

    #[test]
    fn actual_open_and_save_types_reject_missing_and_unknown_fields() {
        let wire: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/contracts/desktop-wire.json"))
                .unwrap();
        let mut open_unknown = wire["openInvoke"]["request"].clone();
        open_unknown["anything"] = serde_json::json!(true);
        assert!(serde_json::from_value::<OpenDocumentRequest>(open_unknown).is_err());

        let mut open_missing = wire["openInvoke"]["request"].clone();
        open_missing.as_object_mut().unwrap().remove("path");
        assert!(serde_json::from_value::<OpenDocumentRequest>(open_missing).is_err());

        let mut save_unknown = wire["saveInvoke"]["request"].clone();
        save_unknown["overwrite"] = serde_json::json!(true);
        assert!(serde_json::from_value::<SaveDocumentRequest>(save_unknown).is_err());

        let mut version_unknown = wire["saveInvoke"]["request"].clone();
        version_unknown["expectedVersion"]["unexpected"] = serde_json::json!(1);
        assert!(serde_json::from_value::<SaveDocumentRequest>(version_unknown).is_err());

        let mut version_missing = wire["saveInvoke"]["request"].clone();
        version_missing["expectedVersion"]
            .as_object_mut()
            .unwrap()
            .remove("sha256");
        assert!(serde_json::from_value::<SaveDocumentRequest>(version_missing).is_err());
    }

    fn transaction_paths(dir: &Path) -> Vec<PathBuf> {
        let mut paths: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(".markdown-spike-"))
            })
            .collect();
        paths.sort();
        paths
    }

    fn recovery_contents(error: &FileServiceError) -> Vec<Vec<u8>> {
        error
            .recovery_paths()
            .iter()
            .filter_map(|path| fs::read(path).ok())
            .collect()
    }

    #[cfg(windows)]
    fn replace_target_without_backup(target: &Path, replacement: &Path) -> std::io::Result<()> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

        let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        let replacement: Vec<u16> = replacement
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let succeeded = unsafe {
            ReplaceFileW(
                target.as_ptr(),
                replacement.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        if succeeded == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    #[cfg(windows)]
    fn open_shared_windows_writer(path: &Path) -> std::io::Result<fs::File> {
        use std::{os::windows::ffi::OsStrExt, os::windows::io::FromRawHandle};
        use windows_sys::Win32::{
            Foundation::{GENERIC_WRITE, INVALID_HANDLE_VALUE},
            Storage::FileSystem::{
                CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ,
                FILE_SHARE_WRITE, OPEN_EXISTING,
            },
        };

        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        Ok(unsafe { fs::File::from_raw_handle(handle) })
    }

    #[cfg(windows)]
    fn write_all_through_existing_handle(writer: &fs::File, bytes: &[u8]) -> std::io::Result<()> {
        use std::{
            io::{Seek, SeekFrom, Write},
            os::windows::io::AsRawHandle,
        };
        use windows_sys::Win32::Storage::FileSystem::SetEndOfFile;

        let mut same_handle = writer;
        same_handle.seek(SeekFrom::Start(0))?;
        same_handle.write_all(bytes)?;
        let succeeded = unsafe { SetEndOfFile(writer.as_raw_handle()) };
        if succeeded == 0 {
            return Err(std::io::Error::last_os_error());
        }
        same_handle.flush()?;
        writer.sync_all()
    }

    #[derive(Debug)]
    enum ScriptedReplaceOutcome {
        Success,
        FailUnchanged(i32),
        FailMovedTargetToBackup(i32),
    }

    struct ScriptedReplaceBackend {
        outcomes: VecDeque<ScriptedReplaceOutcome>,
    }

    impl ScriptedReplaceBackend {
        fn new(outcomes: impl IntoIterator<Item = ScriptedReplaceOutcome>) -> Self {
            Self {
                outcomes: outcomes.into_iter().collect(),
            }
        }
    }

    impl ReplaceOperation for ScriptedReplaceBackend {
        fn replace(
            &mut self,
            replaced: &Path,
            replacement: &Path,
            backup: &Path,
        ) -> std::io::Result<()> {
            match self.outcomes.pop_front().expect("missing scripted outcome") {
                ScriptedReplaceOutcome::Success => {
                    fs::rename(replaced, backup)?;
                    fs::rename(replacement, replaced)
                }
                ScriptedReplaceOutcome::FailUnchanged(code) => {
                    Err(std::io::Error::from_raw_os_error(code))
                }
                ScriptedReplaceOutcome::FailMovedTargetToBackup(code) => {
                    fs::rename(replaced, backup)?;
                    Err(std::io::Error::from_raw_os_error(code))
                }
            }
        }
    }

    struct ReplaceFixture {
        _dir: TempDir,
        target: PathBuf,
        candidate: Vec<u8>,
        expected: FileVersion,
    }

    impl ReplaceFixture {
        fn new(expected: &[u8], candidate: &[u8]) -> Self {
            let dir = tempdir().unwrap();
            let target = dir.path().join("fixture.md");
            fs::write(&target, expected).unwrap();
            let version = read_utf8_document(&target).unwrap().version;
            Self {
                _dir: dir,
                target,
                candidate: candidate.to_vec(),
                expected: version,
            }
        }

        fn run(
            &self,
            backend: &mut impl ReplaceOperation,
        ) -> Result<FileVersion, FileServiceError> {
            self.run_with_hooks(backend, || {}, || {}, || {}, || {}, || {})
        }

        fn run_with_hooks<F, G, H, J, I>(
            &self,
            backend: &mut impl ReplaceOperation,
            before_replace: F,
            after_replace: G,
            after_initial_validation_before_cleanup: H,
            after_final_target_snapshot_before_cleanup: J,
            before_rollback: I,
        ) -> Result<FileVersion, FileServiceError>
        where
            F: FnOnce(),
            G: FnOnce(),
            H: FnOnce(),
            J: FnOnce(),
            I: FnOnce(),
        {
            recoverable_replace_utf8_with_backend_and_hooks(
                &self.target,
                &self.candidate,
                &self.expected,
                backend,
                before_replace,
                after_replace,
                after_initial_validation_before_cleanup,
                after_final_target_snapshot_before_cleanup,
                before_rollback,
            )
        }
    }

    fn assert_versions_recoverable<'a>(
        fixture: &ReplaceFixture,
        error: &FileServiceError,
        versions: impl IntoIterator<Item = &'a [u8]>,
    ) {
        let mut recovered = recovery_contents(error);
        if let Ok(bytes) = fs::read(&fixture.target) {
            recovered.push(bytes);
        }
        for expected in versions {
            assert!(
                recovered.iter().any(|bytes| bytes == expected),
                "missing recoverable version {:?}; paths: {:?}",
                String::from_utf8_lossy(expected),
                error.recovery_paths()
            );
        }
    }
}
