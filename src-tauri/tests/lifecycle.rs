use markdown_document_app_lib::{
    draft_store::{
        delete_draft_at, list_drafts_at, read_draft_at, write_draft_at, DraftPayload, DraftRecord,
        RejectedSourceBuffer, SelectionSnapshot, TableCoordinate,
    },
    file_watch::{classify_event, EventClassifier, FileChangedKind, WatchRegistry},
    lifecycle::{
        save_document_as_with_fault, save_document_as_with_hook, save_document_as_with_hooks,
        save_document_as_with_verification_hook, DesktopFailure, DesktopFailureCode,
        DurableCopyFault, SaveDocumentAsRequest,
    },
};
use notify::{
    event::{ModifyKind, RenameMode},
    Event, EventKind,
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    sync::mpsc,
    time::{Duration, Instant},
};
use tempfile::tempdir;

fn candidate_sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(windows)]
fn atomic_replace(source: &std::path::Path, target: &std::path::Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    assert_ne!(
        unsafe {
            MoveFileExW(
                source.as_ptr(),
                target.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        },
        0,
        "{:?}",
        std::io::Error::last_os_error()
    );
}

fn payload(id: &str, bytes: &[u8]) -> DraftPayload {
    DraftPayload {
        id: id.into(),
        session_id: "session-1".into(),
        canonical_path: None,
        baseline_version: None,
        bytes: bytes.to_vec(),
        candidate_revision: 7,
        rejected_source_buffer: Some(RejectedSourceBuffer {
            base_candidate_revision: 7,
            base_candidate_sha256: candidate_sha(bytes),
            // Raw bytes FF D8 are one intentionally unpaired UTF-16 code unit.
            utf16_code_units_base64: "/9g=".into(),
            selection: Some(SelectionSnapshot::Text {
                anchor_block_key: None,
                anchor_offset: 0,
                focus_block_key: Some("block-1".into()),
                focus_offset: 1,
            }),
        }),
    }
}

fn write_raw_draft_envelope(
    app_data_root: &std::path::Path,
    id: &str,
    mut envelope: serde_json::Value,
) -> Vec<u8> {
    let drafts = app_data_root.join("drafts");
    fs::create_dir_all(&drafts).unwrap();
    envelope["draft"]["id"] = serde_json::json!(id);
    let bytes = serde_json::to_vec(&envelope).unwrap();
    fs::write(drafts.join(format!("{id}.json")), &bytes).unwrap();
    bytes
}

fn assert_invalid_raw_draft(id: &str, bytes: &[u8]) {
    let app_data = tempdir().unwrap();
    let drafts = app_data.path().join("drafts");
    fs::create_dir(&drafts).unwrap();
    fs::write(drafts.join(format!("{id}.json")), bytes).unwrap();

    let error = read_draft_at(app_data.path(), id).unwrap_err();
    assert_eq!(error.code, DesktopFailureCode::DraftInvalid);
    assert!(!drafts.join(format!("{id}.json")).exists());
    let invalid: Vec<_> = fs::read_dir(&drafts)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".invalid"))
        .collect();
    assert_eq!(invalid.len(), 1);
    assert_eq!(fs::read(invalid[0].path()).unwrap(), bytes);
}

#[test]
fn lifecycle_create_new_never_overwrites_a_target_that_wins_the_race() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("source.md");
    let target = dir.path().join("target.md");
    fs::write(&source, b"source generation").unwrap();

    let request = SaveDocumentAsRequest {
        target_path: target.to_string_lossy().into_owned(),
        bytes: b"local candidate".to_vec(),
        expected_target_version: None,
    };
    let error = save_document_as_with_hook(request, || {
        fs::write(&target, b"external winner").unwrap();
    })
    .unwrap_err();

    assert_eq!(error.code, DesktopFailureCode::AlreadyExists);
    assert_eq!(fs::read(&source).unwrap(), b"source generation");
    assert_eq!(fs::read(&target).unwrap(), b"external winner");
    assert_eq!(error.recovery_paths.len(), 1);
    assert_eq!(
        fs::read(&error.recovery_paths[0]).unwrap(),
        b"local candidate"
    );
}

#[test]
fn lifecycle_post_commit_writer_never_returns_foreign_bytes_as_saved() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("post-commit.md");
    let error = save_document_as_with_hooks(
        SaveDocumentAsRequest {
            target_path: target.to_string_lossy().into_owned(),
            bytes: b"local candidate".to_vec(),
            expected_target_version: None,
        },
        || {},
        || fs::write(&target, b"foreign writer").unwrap(),
    )
    .unwrap_err();

    assert_eq!(error.code, DesktopFailureCode::Changed);
    assert_eq!(fs::read(&target).unwrap(), b"foreign writer");
    assert_eq!(error.recovery_paths.len(), 1);
    assert_eq!(
        fs::read(&error.recovery_paths[0]).unwrap(),
        b"local candidate"
    );
}

#[test]
fn lifecycle_path_finalization_failure_keeps_verified_recovery() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("finalize.md");
    let error = save_document_as_with_verification_hook(
        SaveDocumentAsRequest {
            target_path: target.to_string_lossy().into_owned(),
            bytes: b"candidate".to_vec(),
            expected_target_version: None,
        },
        || Err(std::io::Error::other("injected canonicalization failure")),
    )
    .unwrap_err();
    assert_eq!(error.recovery_paths.len(), 1);
    assert_eq!(fs::read(&error.recovery_paths[0]).unwrap(), b"candidate");
}

#[test]
fn lifecycle_partial_durable_copy_failures_are_removed_or_reported() {
    for fault in [
        DurableCopyFault::RecoveryWrite,
        DurableCopyFault::MovingSync,
    ] {
        let dir = tempdir().unwrap();
        let target = dir.path().join("fault.md");
        let error = save_document_as_with_fault(
            SaveDocumentAsRequest {
                target_path: target.to_string_lossy().into_owned(),
                bytes: b"candidate".to_vec(),
                expected_target_version: None,
            },
            fault,
        )
        .unwrap_err();
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".markdown-spike-save-as")
            })
            .collect();
        let reported: Vec<_> = error
            .recovery_paths
            .iter()
            .map(std::path::PathBuf::from)
            .filter_map(|path| path.canonicalize().ok())
            .collect();
        assert!(leftovers
            .iter()
            .all(|path| reported.contains(&path.canonicalize().unwrap())));
    }
}

#[test]
fn lifecycle_existing_target_requires_and_uses_the_exact_expected_version() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("target.md");
    fs::write(&target, b"baseline").unwrap();

    let missing = save_document_as_with_hook(
        SaveDocumentAsRequest {
            target_path: target.to_string_lossy().into_owned(),
            bytes: b"local".to_vec(),
            expected_target_version: None,
        },
        || {},
    )
    .unwrap_err();
    assert_eq!(missing.code, DesktopFailureCode::AlreadyExists);
    assert_eq!(fs::read(&target).unwrap(), b"baseline");
    assert_eq!(missing.recovery_paths.len(), 1);
    assert_eq!(fs::read(&missing.recovery_paths[0]).unwrap(), b"local");

    let stale = markdown_document_app_lib::lifecycle::open_document_at(&target).unwrap();
    fs::write(&target, b"external").unwrap();
    let changed = save_document_as_with_hook(
        SaveDocumentAsRequest {
            target_path: target.to_string_lossy().into_owned(),
            bytes: b"local".to_vec(),
            expected_target_version: Some(stale.version),
        },
        || {},
    )
    .unwrap_err();
    assert_eq!(changed.code, DesktopFailureCode::Changed);
    assert_eq!(fs::read(&target).unwrap(), b"external");

    let opened = markdown_document_app_lib::lifecycle::open_document_at(&target).unwrap();
    let saved = save_document_as_with_hook(
        SaveDocumentAsRequest {
            target_path: target.to_string_lossy().into_owned(),
            bytes: b"local".to_vec(),
            expected_target_version: Some(opened.version),
        },
        || {},
    )
    .unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"local");
    assert_eq!(saved.version.sha256, candidate_sha(b"local"));
}

#[test]
fn lifecycle_new_target_rejects_invalid_markdown_bytes_before_creation() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("invalid.md");
    let error = save_document_as_with_hook(
        SaveDocumentAsRequest {
            target_path: target.to_string_lossy().into_owned(),
            bytes: vec![0xff, 0xfe],
            expected_target_version: None,
        },
        || {},
    )
    .unwrap_err();

    assert_eq!(error.code, DesktopFailureCode::InvalidRequest);
    assert!(!target.exists());
    assert!(error.recovery_paths.is_empty());
}

#[test]
fn lifecycle_errors_have_only_finite_safe_wire_fields() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("exists.md");
    fs::write(&target, b"disk").unwrap();
    let error = save_document_as_with_hook(
        SaveDocumentAsRequest {
            target_path: target.to_string_lossy().into_owned(),
            bytes: b"candidate".to_vec(),
            expected_target_version: None,
        },
        || {},
    )
    .unwrap_err();
    let wire = serde_json::to_value(error).unwrap();

    assert_eq!(wire["code"], "already-exists");
    assert_eq!(wire.as_object().unwrap().len(), 4);
    assert!(wire.get("message").is_none());
    assert!(wire.get("debug").is_none());
}

#[test]
fn draft_store_contains_ids_writes_atomically_and_deletes_idempotently() {
    let app_data = tempdir().unwrap();
    let id = "00000000-0000-4000-8000-000000000001";
    let record = write_draft_at(app_data.path(), payload(id, b"# candidate"), 1234).unwrap();

    assert_eq!(record.updated_ms, 1234);
    assert_eq!(read_draft_at(app_data.path(), id).unwrap(), record);
    let replacement = write_draft_at(app_data.path(), payload(id, b"# replacement"), 1235).unwrap();
    assert_eq!(read_draft_at(app_data.path(), id).unwrap(), replacement);
    assert_eq!(replacement.bytes, b"# replacement");
    assert!(fs::read_dir(app_data.path().join("drafts"))
        .unwrap()
        .filter_map(Result::ok)
        .all(|entry| !entry
            .file_name()
            .to_string_lossy()
            .starts_with(".draft-write-")));

    let escaped = write_draft_at(app_data.path(), payload("../escape", b"bad"), 1).unwrap_err();
    assert_eq!(escaped.code, DesktopFailureCode::InvalidRequest);
    assert!(!app_data.path().join("escape.json").exists());

    delete_draft_at(app_data.path(), id).unwrap();
    delete_draft_at(app_data.path(), id).unwrap();
    assert!(!app_data
        .path()
        .join("drafts")
        .join(format!("{id}.json"))
        .exists());
}

#[test]
fn draft_store_writes_v2_tagged_selections_and_migrates_v1_without_quarantine() {
    let app_data = tempdir().unwrap();
    let text_id = "00000000-0000-4000-8000-000000000021";
    let text_record = write_draft_at(app_data.path(), payload(text_id, b"# text"), 21).unwrap();
    let text_json: serde_json::Value = serde_json::from_slice(
        &fs::read(
            app_data
                .path()
                .join("drafts")
                .join(format!("{text_id}.json")),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(text_json["version"], 2);
    assert_eq!(
        text_json["draft"]["rejectedSourceBuffer"]["selection"]["kind"],
        "text"
    );
    assert_eq!(
        read_draft_at(app_data.path(), text_id).unwrap(),
        text_record
    );

    let table_id = "00000000-0000-4000-8000-000000000022";
    let mut table_payload = payload(table_id, b"# table");
    table_payload
        .rejected_source_buffer
        .as_mut()
        .unwrap()
        .selection = Some(SelectionSnapshot::Table {
        table_block_view_key: "session-1:table-a".into(),
        anchor: TableCoordinate { row: 0, column: 1 },
        focus: TableCoordinate { row: 2, column: 3 },
        origin: TableCoordinate { row: 0, column: 1 },
    });
    let table_record = write_draft_at(app_data.path(), table_payload, 22).unwrap();
    let table_json: serde_json::Value = serde_json::from_slice(
        &fs::read(
            app_data
                .path()
                .join("drafts")
                .join(format!("{table_id}.json")),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(table_json["version"], 2);
    assert_eq!(
        table_json["draft"]["rejectedSourceBuffer"]["selection"]["kind"],
        "table"
    );
    assert_eq!(
        read_draft_at(app_data.path(), table_id).unwrap(),
        table_record
    );

    let legacy_id = "00000000-0000-4000-8000-000000000020";
    fs::write(
        app_data
            .path()
            .join("drafts")
            .join(format!("{legacy_id}.json")),
        include_bytes!("../../fixtures/contracts/draft-envelope-v1.json"),
    )
    .unwrap();
    let migrated = read_draft_at(app_data.path(), legacy_id).unwrap();
    assert_eq!(
        migrated
            .rejected_source_buffer
            .as_ref()
            .unwrap()
            .selection
            .clone(),
        Some(SelectionSnapshot::Text {
            anchor_block_key: Some("legacy-block".into()),
            anchor_offset: 1,
            focus_block_key: Some("legacy-block".into()),
            focus_offset: 2,
        })
    );
    assert!(app_data
        .path()
        .join("drafts")
        .join(format!("{legacy_id}.json"))
        .exists());
    assert!(list_drafts_at(app_data.path())
        .unwrap()
        .iter()
        .any(|draft| draft.id == legacy_id));
    let legacy_path = app_data
        .path()
        .join("drafts")
        .join(format!("{legacy_id}.json"));
    assert_eq!(
        fs::read(&legacy_path).unwrap(),
        include_bytes!("../../fixtures/contracts/draft-envelope-v1.json")
    );

    write_draft_at(
        app_data.path(),
        DraftPayload {
            id: migrated.id,
            session_id: migrated.session_id,
            canonical_path: migrated.canonical_path,
            baseline_version: migrated.baseline_version,
            bytes: migrated.bytes,
            candidate_revision: migrated.candidate_revision,
            rejected_source_buffer: migrated.rejected_source_buffer,
        },
        1_700_000_004_000,
    )
    .unwrap();
    let rewritten: serde_json::Value =
        serde_json::from_slice(&fs::read(&legacy_path).unwrap()).unwrap();
    assert_eq!(rewritten["version"], 2);
    assert_eq!(
        rewritten["draft"]["rejectedSourceBuffer"]["selection"]["kind"],
        "text"
    );
}

#[test]
fn draft_store_rejects_version_shape_mismatches_and_duplicate_tags() {
    let wire: serde_json::Value =
        serde_json::from_str(include_str!("../../fixtures/contracts/desktop-wire.json")).unwrap();
    let v2_id = wire["draftRecord"]["id"].as_str().unwrap();
    let v2 = serde_json::json!({ "version": 2, "draft": wire["draftRecord"].clone() });
    let legacy: serde_json::Value = serde_json::from_str(include_str!(
        "../../fixtures/contracts/draft-envelope-v1.json"
    ))
    .unwrap();
    let legacy_id = legacy["draft"]["id"].as_str().unwrap();

    let mut v2_untagged = v2.clone();
    v2_untagged["draft"]["rejectedSourceBuffer"]["selection"]
        .as_object_mut()
        .unwrap()
        .remove("kind");
    assert_invalid_raw_draft(v2_id, &serde_json::to_vec(&v2_untagged).unwrap());

    let mut v1_tagged = legacy.clone();
    v1_tagged["draft"]["rejectedSourceBuffer"]["selection"]["kind"] = serde_json::json!("text");
    assert_invalid_raw_draft(legacy_id, &serde_json::to_vec(&v1_tagged).unwrap());

    let mut unknown_version = v2.clone();
    unknown_version["version"] = serde_json::json!(3);
    assert_invalid_raw_draft(v2_id, &serde_json::to_vec(&unknown_version).unwrap());

    let mut unknown_kind = v2.clone();
    unknown_kind["draft"]["rejectedSourceBuffer"]["selection"]["kind"] = serde_json::json!("range");
    assert_invalid_raw_draft(v2_id, &serde_json::to_vec(&unknown_kind).unwrap());

    let mut extra_coordinate = v2.clone();
    extra_coordinate["draft"]["rejectedSourceBuffer"]["selection"] = wire["selectionTable"].clone();
    extra_coordinate["draft"]["rejectedSourceBuffer"]["selection"]["anchor"]["unexpected"] =
        serde_json::json!(true);
    assert_invalid_raw_draft(v2_id, &serde_json::to_vec(&extra_coordinate).unwrap());

    let mut missing_required_null = v2.clone();
    missing_required_null["draft"]
        .as_object_mut()
        .unwrap()
        .remove("canonicalPath");
    assert_invalid_raw_draft(v2_id, &serde_json::to_vec(&missing_required_null).unwrap());

    let compact = serde_json::to_string(&v2).unwrap();
    let duplicate_version = compact.replacen("\"version\":2", "\"version\":2,\"version\":2", 1);
    assert_ne!(duplicate_version, compact);
    assert_invalid_raw_draft(v2_id, duplicate_version.as_bytes());

    let duplicate_kind = compact.replacen(
        "\"kind\":\"text\"",
        "\"kind\":\"text\",\"kind\":\"table\"",
        1,
    );
    assert_ne!(duplicate_kind, compact);
    assert_invalid_raw_draft(v2_id, duplicate_kind.as_bytes());
}

#[test]
fn draft_store_quarantines_every_js_unsafe_integer_without_hiding_valid_drafts() {
    const UNSAFE: u64 = 9_007_199_254_740_992;
    let app_data = tempdir().unwrap();
    let valid_id = "00000000-0000-4000-8000-000000000023";
    write_draft_at(app_data.path(), payload(valid_id, b"valid"), 23).unwrap();
    let v2_base: serde_json::Value = serde_json::from_slice(
        &fs::read(
            app_data
                .path()
                .join("drafts")
                .join(format!("{valid_id}.json")),
        )
        .unwrap(),
    )
    .unwrap();
    let v1_base: serde_json::Value = serde_json::from_str(include_str!(
        "../../fixtures/contracts/draft-envelope-v1.json"
    ))
    .unwrap();

    let mut expected_quarantine = Vec::new();
    let mut next_id = 100_u64;
    for (version_index, base) in [v1_base, v2_base].into_iter().enumerate() {
        let mut cases = Vec::new();
        for case_index in 0..9 {
            let mut envelope = base.clone();
            match case_index {
                0 => {
                    envelope["draft"]["candidateRevision"] = serde_json::json!(UNSAFE);
                    envelope["draft"]["rejectedSourceBuffer"]["baseCandidateRevision"] =
                        serde_json::json!(UNSAFE);
                }
                1 => {
                    envelope["draft"]["rejectedSourceBuffer"]["baseCandidateRevision"] =
                        serde_json::json!(UNSAFE);
                }
                2 => envelope["draft"]["updatedMs"] = serde_json::json!(UNSAFE),
                3 => {
                    envelope["draft"]["baselineVersion"] = serde_json::json!({
                        "len": UNSAFE, "modifiedMs": 0, "sha256": "baseline"
                    });
                }
                4 => {
                    envelope["draft"]["baselineVersion"] = serde_json::json!({
                        "len": 0, "modifiedMs": UNSAFE, "sha256": "baseline"
                    });
                }
                5 => {
                    envelope["draft"]["rejectedSourceBuffer"]["selection"]["anchorOffset"] =
                        serde_json::json!(UNSAFE);
                }
                6 => {
                    envelope["draft"]["rejectedSourceBuffer"]["selection"]["focusOffset"] =
                        serde_json::json!(UNSAFE);
                }
                7 => {
                    envelope["draft"]["rejectedSourceBuffer"]["selection"]["anchorOffset"] =
                        serde_json::json!(-1);
                }
                8 => {
                    envelope["draft"]["rejectedSourceBuffer"]["selection"]["focusOffset"] =
                        serde_json::json!(1.5);
                }
                _ => unreachable!(),
            }
            cases.push(envelope);
        }
        if version_index == 1 {
            for point in ["anchor", "focus", "origin"] {
                for axis in ["row", "column"] {
                    let mut envelope = base.clone();
                    envelope["draft"]["rejectedSourceBuffer"]["selection"] = serde_json::json!({
                        "kind": "table",
                        "tableBlockViewKey": "table",
                        "anchor": { "row": 0, "column": 0 },
                        "focus": { "row": 0, "column": 0 },
                        "origin": { "row": 0, "column": 0 }
                    });
                    envelope["draft"]["rejectedSourceBuffer"]["selection"][point][axis] =
                        serde_json::json!(UNSAFE);
                    cases.push(envelope);
                }
            }
            for invalid_number in [serde_json::json!(-1), serde_json::json!(1.5)] {
                let mut envelope = base.clone();
                envelope["draft"]["rejectedSourceBuffer"]["selection"] = serde_json::json!({
                    "kind": "table",
                    "tableBlockViewKey": "table",
                    "anchor": { "row": invalid_number, "column": 0 },
                    "focus": { "row": 0, "column": 0 },
                    "origin": { "row": 0, "column": 0 }
                });
                cases.push(envelope);
            }
        }
        for envelope in cases {
            let id = format!("00000000-0000-4000-8000-{next_id:012}");
            next_id += 1;
            expected_quarantine.push(write_raw_draft_envelope(app_data.path(), &id, envelope));
        }
    }

    let listed = list_drafts_at(app_data.path()).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, valid_id);
    let mut quarantined: Vec<Vec<u8>> = fs::read_dir(app_data.path().join("drafts"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".invalid"))
        .map(|entry| fs::read(entry.path()).unwrap())
        .collect();
    quarantined.sort();
    expected_quarantine.sort();
    assert_eq!(quarantined, expected_quarantine);
}

#[test]
fn draft_store_rejects_unsafe_direct_writes_and_accepts_js_max_safe() {
    const MAX_SAFE: u64 = 9_007_199_254_740_991;
    const UNSAFE: u64 = MAX_SAFE + 1;
    let app_data = tempdir().unwrap();

    let mut unsafe_revision = payload("00000000-0000-4000-8000-000000000121", b"unsafe revision");
    unsafe_revision.candidate_revision = UNSAFE;
    unsafe_revision.rejected_source_buffer = None;
    assert_eq!(
        write_draft_at(app_data.path(), unsafe_revision, 1)
            .unwrap_err()
            .code,
        DesktopFailureCode::DraftInvalid
    );

    let mut unsafe_version_json = serde_json::to_value(payload(
        "00000000-0000-4000-8000-000000000122",
        b"unsafe version",
    ))
    .unwrap();
    unsafe_version_json["baselineVersion"] = serde_json::json!({
        "len": UNSAFE, "modifiedMs": 0, "sha256": "baseline"
    });
    let unsafe_version: DraftPayload = serde_json::from_value(unsafe_version_json).unwrap();
    assert_eq!(
        write_draft_at(app_data.path(), unsafe_version, 1)
            .unwrap_err()
            .code,
        DesktopFailureCode::DraftInvalid
    );

    let mut unsafe_modified_json = serde_json::to_value(payload(
        "00000000-0000-4000-8000-000000000125",
        b"unsafe modified",
    ))
    .unwrap();
    unsafe_modified_json["baselineVersion"] = serde_json::json!({
        "len": 0, "modifiedMs": UNSAFE, "sha256": "baseline"
    });
    let unsafe_modified: DraftPayload = serde_json::from_value(unsafe_modified_json).unwrap();
    assert_eq!(
        write_draft_at(app_data.path(), unsafe_modified, 1)
            .unwrap_err()
            .code,
        DesktopFailureCode::DraftInvalid
    );

    let mut unsafe_text = payload(
        "00000000-0000-4000-8000-000000000126",
        b"unsafe text selection",
    );
    unsafe_text
        .rejected_source_buffer
        .as_mut()
        .unwrap()
        .selection = Some(SelectionSnapshot::Text {
        anchor_block_key: None,
        anchor_offset: UNSAFE,
        focus_block_key: None,
        focus_offset: UNSAFE,
    });
    assert_eq!(
        write_draft_at(app_data.path(), unsafe_text, 1)
            .unwrap_err()
            .code,
        DesktopFailureCode::DraftInvalid
    );

    let mut unsafe_table = payload(
        "00000000-0000-4000-8000-000000000127",
        b"unsafe table selection",
    );
    unsafe_table
        .rejected_source_buffer
        .as_mut()
        .unwrap()
        .selection = Some(SelectionSnapshot::Table {
        table_block_view_key: "table".into(),
        anchor: TableCoordinate {
            row: UNSAFE,
            column: UNSAFE,
        },
        focus: TableCoordinate {
            row: UNSAFE,
            column: UNSAFE,
        },
        origin: TableCoordinate {
            row: UNSAFE,
            column: UNSAFE,
        },
    });
    assert_eq!(
        write_draft_at(app_data.path(), unsafe_table, 1)
            .unwrap_err()
            .code,
        DesktopFailureCode::DraftInvalid
    );

    assert_eq!(
        write_draft_at(
            app_data.path(),
            payload("00000000-0000-4000-8000-000000000123", b"unsafe time"),
            UNSAFE,
        )
        .unwrap_err()
        .code,
        DesktopFailureCode::DraftInvalid
    );

    let mut maximum = payload("00000000-0000-4000-8000-000000000124", b"maximum safe");
    maximum.candidate_revision = MAX_SAFE;
    let rejected = maximum.rejected_source_buffer.as_mut().unwrap();
    rejected.base_candidate_revision = MAX_SAFE;
    rejected.selection = Some(SelectionSnapshot::Text {
        anchor_block_key: None,
        anchor_offset: MAX_SAFE,
        focus_block_key: None,
        focus_offset: MAX_SAFE,
    });
    let mut maximum_json = serde_json::to_value(maximum).unwrap();
    maximum_json["baselineVersion"] = serde_json::json!({
        "len": MAX_SAFE, "modifiedMs": MAX_SAFE, "sha256": "baseline"
    });
    let maximum: DraftPayload = serde_json::from_value(maximum_json).unwrap();
    let record = write_draft_at(app_data.path(), maximum, MAX_SAFE).unwrap();
    assert_eq!(record.candidate_revision, MAX_SAFE);
    assert_eq!(record.updated_ms, MAX_SAFE);

    let mut maximum_table = payload("00000000-0000-4000-8000-000000000128", b"maximum table");
    maximum_table
        .rejected_source_buffer
        .as_mut()
        .unwrap()
        .selection = Some(SelectionSnapshot::Table {
        table_block_view_key: "table".into(),
        anchor: TableCoordinate {
            row: MAX_SAFE,
            column: MAX_SAFE,
        },
        focus: TableCoordinate {
            row: MAX_SAFE,
            column: MAX_SAFE,
        },
        origin: TableCoordinate {
            row: MAX_SAFE,
            column: MAX_SAFE,
        },
    });
    assert!(write_draft_at(app_data.path(), maximum_table, MAX_SAFE).is_ok());
}

#[test]
fn draft_store_quarantines_malformed_and_mismatched_rejected_source_entries() {
    let app_data = tempdir().unwrap();
    let valid_id = "00000000-0000-4000-8000-000000000001";
    write_draft_at(app_data.path(), payload(valid_id, b"valid"), 10).unwrap();
    let drafts = app_data.path().join("drafts");

    fs::write(
        drafts.join("00000000-0000-4000-8000-000000000002.json"),
        b"not json",
    )
    .unwrap();
    let mut mismatched = payload("00000000-0000-4000-8000-000000000003", b"candidate");
    mismatched
        .rejected_source_buffer
        .as_mut()
        .unwrap()
        .base_candidate_revision = 8;
    fs::write(
        drafts.join("00000000-0000-4000-8000-000000000003.json"),
        serde_json::json!({ "version": 1, "draft": {
            "id": mismatched.id,
            "sessionId": mismatched.session_id,
            "canonicalPath": mismatched.canonical_path,
            "baselineVersion": mismatched.baseline_version,
            "bytes": mismatched.bytes,
            "candidateRevision": mismatched.candidate_revision,
            "rejectedSourceBuffer": mismatched.rejected_source_buffer,
            "updatedMs": 11
        }})
        .to_string(),
    )
    .unwrap();

    let listed = list_drafts_at(app_data.path()).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, valid_id);
    let names: Vec<_> = fs::read_dir(&drafts)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name())
        .collect();
    assert_eq!(
        names
            .iter()
            .filter(|name| name.to_string_lossy().ends_with(".invalid"))
            .count(),
        2
    );
}

#[cfg(windows)]
#[test]
fn draft_store_rejects_reparse_roots_quarantine_and_uuid_entries() {
    use std::os::windows::fs::{symlink_dir, symlink_file};

    let root_case = tempdir().unwrap();
    let outside_root = tempdir().unwrap();
    symlink_dir(outside_root.path(), root_case.path().join("drafts")).unwrap();
    let root_error = list_drafts_at(root_case.path()).unwrap_err();
    assert_eq!(root_error.code, DesktopFailureCode::DraftInvalid);

    let quarantine_case = tempdir().unwrap();
    let drafts = quarantine_case.path().join("drafts");
    fs::create_dir(&drafts).unwrap();
    fs::write(
        drafts.join("00000000-0000-4000-8000-000000000010.json"),
        b"malformed",
    )
    .unwrap();
    let outside_quarantine = tempdir().unwrap();
    symlink_dir(outside_quarantine.path(), drafts.join("quarantine")).unwrap();
    assert!(list_drafts_at(quarantine_case.path()).unwrap().is_empty());
    assert_eq!(fs::read_dir(outside_quarantine.path()).unwrap().count(), 0);

    let entry_case = tempdir().unwrap();
    let external = tempdir().unwrap();
    let id = "00000000-0000-4000-8000-000000000011";
    write_draft_at(external.path(), payload(id, b"external"), 1).unwrap();
    fs::create_dir(entry_case.path().join("drafts")).unwrap();
    symlink_file(
        external.path().join("drafts").join(format!("{id}.json")),
        entry_case.path().join("drafts").join(format!("{id}.json")),
    )
    .unwrap();
    let listed = list_drafts_at(entry_case.path()).unwrap();
    assert!(listed.is_empty());
    assert_eq!(
        read_draft_at(external.path(), id).unwrap().bytes,
        b"external"
    );
}

#[test]
fn draft_store_does_not_quarantine_a_valid_replacement_of_the_invalid_identity() {
    let app_data = tempdir().unwrap();
    let id = "00000000-0000-4000-8000-000000000012";
    let drafts = app_data.path().join("drafts");
    fs::create_dir(&drafts).unwrap();
    let path = drafts.join(format!("{id}.json"));
    fs::write(&path, b"malformed").unwrap();
    let valid_root = tempdir().unwrap();
    write_draft_at(valid_root.path(), payload(id, b"valid replacement"), 9).unwrap();
    let valid = valid_root.path().join("drafts").join(format!("{id}.json"));

    let listed = markdown_document_app_lib::draft_store::list_drafts_at_with_quarantine_hook(
        app_data.path(),
        || {
            fs::remove_file(&path).unwrap();
            fs::rename(&valid, &path).unwrap();
        },
    )
    .unwrap();

    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].bytes, b"valid replacement");
    assert!(path.exists());
}

#[test]
fn draft_store_stable_handle_blocks_replacement_then_disposes_invalid_identity() {
    use std::cell::Cell;
    let app_data = tempdir().unwrap();
    let id = "00000000-0000-4000-8000-000000000013";
    let drafts = app_data.path().join("drafts");
    fs::create_dir(&drafts).unwrap();
    let path = drafts.join(format!("{id}.json"));
    fs::write(&path, b"malformed").unwrap();
    let valid_root = tempdir().unwrap();
    write_draft_at(valid_root.path(), payload(id, b"valid after check"), 10).unwrap();
    let valid = valid_root.path().join("drafts").join(format!("{id}.json"));
    let blocked = Cell::new(false);
    markdown_document_app_lib::draft_store::list_drafts_at_with_after_identity_hook(
        app_data.path(),
        || {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            };
            let source: Vec<u16> = valid.as_os_str().encode_wide().chain(Some(0)).collect();
            let target: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            assert_eq!(
                unsafe {
                    MoveFileExW(
                        source.as_ptr(),
                        target.as_ptr(),
                        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                    )
                },
                0
            );
            blocked.set(true);
        },
    )
    .unwrap();
    assert!(blocked.get());
    atomic_replace(&valid, &path);
    assert_eq!(
        read_draft_at(app_data.path(), id).unwrap().bytes,
        b"valid after check"
    );
    let quarantined: Vec<_> = fs::read_dir(&drafts)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.path().extension().and_then(|value| value.to_str()) == Some("invalid")
        })
        .collect();
    assert_eq!(quarantined.len(), 1);
    assert_eq!(fs::read(quarantined[0].path()).unwrap(), b"malformed");
}

#[test]
fn draft_store_first_run_list_and_delete_accept_a_missing_app_data_root() {
    let parent = tempdir().unwrap();
    let missing = parent.path().join("not-created");
    assert!(list_drafts_at(&missing).unwrap().is_empty());
    delete_draft_at(&missing, "00000000-0000-4000-8000-000000000014").unwrap();
    assert!(!missing.exists());
}

#[test]
fn draft_store_quarantine_copy_failure_keeps_source_identity() {
    let app_data = tempdir().unwrap();
    let drafts = app_data.path().join("drafts");
    fs::create_dir(&drafts).unwrap();
    let source = drafts.join("00000000-0000-4000-8000-000000000015.json");
    fs::write(&source, b"invalid exact bytes").unwrap();
    assert!(
        markdown_document_app_lib::draft_store::list_drafts_at_with_quarantine_copy_fault(
            app_data.path()
        )
        .is_err()
    );
    assert_eq!(fs::read(&source).unwrap(), b"invalid exact bytes");
    assert_eq!(fs::read_dir(&drafts).unwrap().count(), 1);
}

#[test]
fn draft_store_disposition_permission_and_would_block_faults_clean_the_durable_copy() {
    let cases = [
        (
            "00000000-0000-4000-8000-000000000016",
            std::io::ErrorKind::PermissionDenied,
            DesktopFailureCode::PermissionDenied,
        ),
        (
            "00000000-0000-4000-8000-000000000018",
            std::io::ErrorKind::WouldBlock,
            DesktopFailureCode::Io,
        ),
    ];
    for (id, disposition_error, expected_code) in cases {
        let app_data = tempdir().unwrap();
        let drafts = app_data.path().join("drafts");
        fs::create_dir(&drafts).unwrap();
        let source = drafts.join(format!("{id}.json"));
        let source_bytes = format!("invalid disposition bytes for {id}");
        fs::write(&source, source_bytes.as_bytes()).unwrap();
        let canonical_source = source.canonicalize().unwrap();

        let result = markdown_document_app_lib::draft_store::list_drafts_at_with_disposition_fault(
            app_data.path(),
            disposition_error,
            false,
        );

        let error = result.unwrap_err();
        assert_eq!(error.code, expected_code);
        assert_eq!(
            error.affected_paths,
            vec![canonical_source.to_string_lossy().into_owned()]
        );
        assert!(error.recovery_paths.is_empty());
        assert_eq!(fs::read(&source).unwrap(), source_bytes.as_bytes());
        assert!(fs::read_dir(&drafts)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| entry.path() == source));
    }
}

#[cfg(windows)]
#[test]
fn draft_store_failed_copy_cleanup_reports_the_exact_surviving_copy() {
    let app_data = tempdir().unwrap();
    let drafts = app_data.path().join("drafts");
    fs::create_dir(&drafts).unwrap();
    let source = drafts.join("00000000-0000-4000-8000-000000000019.json");
    let source_bytes = b"invalid bytes whose cleanup is blocked";
    fs::write(&source, source_bytes).unwrap();
    let canonical_source = source.canonicalize().unwrap();

    let error = markdown_document_app_lib::draft_store::list_drafts_at_with_disposition_fault(
        app_data.path(),
        std::io::ErrorKind::WouldBlock,
        true,
    )
    .unwrap_err();

    let invalid: Vec<_> = fs::read_dir(&drafts)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("invalid"))
        .collect();
    assert_eq!(error.code, DesktopFailureCode::Io);
    assert_eq!(
        error.affected_paths,
        vec![canonical_source.to_string_lossy().into_owned()]
    );
    assert_eq!(invalid.len(), 1);
    assert_eq!(fs::read(&invalid[0]).unwrap(), source_bytes);
    assert_eq!(
        error.recovery_paths,
        vec![invalid[0]
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned()]
    );
    assert_eq!(fs::read(&source).unwrap(), source_bytes);
}

#[cfg(windows)]
#[test]
fn draft_store_real_disposition_permission_denied_cleans_copy_and_returns_typed_error() {
    let app_data = tempdir().unwrap();
    let drafts = app_data.path().join("drafts");
    fs::create_dir(&drafts).unwrap();
    let source = drafts.join("00000000-0000-4000-8000-000000000017.json");
    fs::write(&source, b"read-only invalid disposition bytes").unwrap();
    let canonical_source = source.canonicalize().unwrap();
    let mut permissions = fs::metadata(&source).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&source, permissions).unwrap();

    let result = list_drafts_at(app_data.path());
    let invalid: Vec<_> = fs::read_dir(&drafts)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.path().extension().and_then(|value| value.to_str()) == Some("invalid")
        })
        .collect();
    let mut permissions = fs::metadata(&source).unwrap().permissions();
    permissions.set_readonly(false);
    fs::set_permissions(&source, permissions).unwrap();

    assert!(
        invalid.is_empty(),
        "durable quarantine copy leaked after disposition failure: {invalid:?}"
    );
    let error = result.unwrap_err();
    assert_eq!(error.code, DesktopFailureCode::PermissionDenied);
    assert_eq!(
        error.affected_paths,
        vec![canonical_source.to_string_lossy().into_owned()]
    );
    assert!(error.recovery_paths.is_empty());
    assert_eq!(
        fs::read(&source).unwrap(),
        b"read-only invalid disposition bytes"
    );
}

#[test]
fn draft_store_rejects_malformed_or_oversized_opaque_utf16_without_decoding_it() {
    let app_data = tempdir().unwrap();
    let mut odd = payload("00000000-0000-4000-8000-000000000004", b"candidate");
    odd.rejected_source_buffer
        .as_mut()
        .unwrap()
        .utf16_code_units_base64 = "YQ==".into();
    assert_eq!(
        write_draft_at(app_data.path(), odd, 1).unwrap_err().code,
        DesktopFailureCode::DraftInvalid,
    );

    let mut malformed = payload("00000000-0000-4000-8000-000000000005", b"candidate");
    malformed
        .rejected_source_buffer
        .as_mut()
        .unwrap()
        .utf16_code_units_base64 = "%%%=".into();
    assert_eq!(
        write_draft_at(app_data.path(), malformed, 1)
            .unwrap_err()
            .code,
        DesktopFailureCode::DraftInvalid,
    );

    let mut oversized = payload("00000000-0000-4000-8000-000000000006", b"candidate");
    oversized
        .rejected_source_buffer
        .as_mut()
        .unwrap()
        .utf16_code_units_base64 = "AAAA".repeat(3_495_254);
    assert_eq!(
        write_draft_at(app_data.path(), oversized, 1)
            .unwrap_err()
            .code,
        DesktopFailureCode::DraftInvalid,
    );
}

#[test]
fn lifecycle_shared_fixture_rejects_unknown_and_missing_nested_wire_fields() {
    let wire: serde_json::Value =
        serde_json::from_str(include_str!("../../fixtures/contracts/desktop-wire.json")).unwrap();
    serde_json::from_value::<DraftRecord>(wire["draftRecord"].clone()).unwrap();
    serde_json::from_value::<DesktopFailure>(wire["desktopFailure"].clone()).unwrap();
    serde_json::from_value::<markdown_document_app_lib::file_watch::FileChangedEvent>(
        wire["fileChangedEvent"].clone(),
    )
    .unwrap();
    for key in ["selectionText", "selectionTable"] {
        let selection = serde_json::from_value::<SelectionSnapshot>(wire[key].clone()).unwrap();
        assert_eq!(serde_json::to_value(selection).unwrap(), wire[key]);
    }

    let mut unknown_selection = wire["draftRecord"].clone();
    unknown_selection["rejectedSourceBuffer"]["selection"]["unexpected"] = serde_json::json!(true);
    assert!(serde_json::from_value::<DraftRecord>(unknown_selection).is_err());

    let malformed_selections = [
        serde_json::json!({ "kind": "unknown" }),
        serde_json::json!({
            "kind": "text", "anchorBlockKey": null, "anchorOffset": 0,
            "focusBlockKey": null, "focusOffset": 0, "unexpected": true
        }),
        serde_json::json!({
            "kind": "text", "anchorBlockKey": null, "anchorOffset": 0,
            "focusBlockKey": null
        }),
        serde_json::json!({
            "kind": "text", "anchorBlockKey": null, "anchorOffset": -1,
            "focusBlockKey": null, "focusOffset": 0
        }),
        serde_json::json!({
            "kind": "text", "anchorBlockKey": null, "anchorOffset": 0.5,
            "focusBlockKey": null, "focusOffset": 0
        }),
        serde_json::json!({
            "kind": "text", "anchorBlockKey": null, "anchorOffset": 9007199254740992_u64,
            "focusBlockKey": null, "focusOffset": 0
        }),
        serde_json::json!({
            "kind": "table", "tableBlockViewKey": "table",
            "anchor": { "row": 0, "column": 0, "unexpected": true },
            "focus": { "row": 0, "column": 0 },
            "origin": { "row": 0, "column": 0 }
        }),
        serde_json::json!({
            "kind": "table", "tableBlockViewKey": "table",
            "anchor": { "row": 0, "column": 0 },
            "focus": { "row": 0, "column": 9007199254740992_u64 },
            "origin": { "row": 0, "column": 0 }
        }),
    ];
    for selection in malformed_selections {
        assert!(serde_json::from_value::<SelectionSnapshot>(selection).is_err());
    }

    let mut missing_rejected = wire["draftRecord"].clone();
    missing_rejected["rejectedSourceBuffer"]
        .as_object_mut()
        .unwrap()
        .remove("utf16CodeUnitsBase64");
    assert!(serde_json::from_value::<DraftRecord>(missing_rejected).is_err());

    let mut unknown_failure = wire["desktopFailure"].clone();
    unknown_failure["message"] = serde_json::json!("unsafe display");
    assert!(serde_json::from_value::<DesktopFailure>(unknown_failure).is_err());

    let mut missing_event = wire["fileChangedEvent"].clone();
    missing_event
        .as_object_mut()
        .unwrap()
        .remove("newCanonicalPath");
    assert!(
        serde_json::from_value::<markdown_document_app_lib::file_watch::FileChangedEvent>(
            missing_event,
        )
        .is_err()
    );
}

#[test]
fn file_watch_classifies_modify_delete_and_rename_with_stable_paths() {
    let original = std::path::PathBuf::from(r"C:\docs\a.md");
    let renamed = std::path::PathBuf::from(r"C:\docs\b.md");
    let cases = [
        (
            Event::new(EventKind::Modify(ModifyKind::Any)).add_path(original.clone()),
            FileChangedKind::Content,
            None,
        ),
        (
            Event::new(EventKind::Remove(notify::event::RemoveKind::File))
                .add_path(original.clone()),
            FileChangedKind::Deleted,
            None,
        ),
        (
            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                .add_path(original.clone())
                .add_path(renamed.clone()),
            FileChangedKind::Renamed,
            Some(renamed.to_string_lossy().into_owned()),
        ),
    ];

    for (event, expected_kind, new_path) in cases {
        let facts = classify_event("watch-1", &original, &event);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].canonical_path, original.to_string_lossy());
        assert_eq!(facts[0].kind, expected_kind);
        assert_eq!(facts[0].new_canonical_path, new_path);
    }
}

#[test]
fn file_watch_pairs_the_from_to_sequence_emitted_by_windows_notify() {
    let original = std::path::PathBuf::from(r"C:\docs\a.md");
    let renamed = std::path::PathBuf::from(r"C:\docs\b.md");
    let mut classifier = EventClassifier::new("watch-1", original.clone());

    let from = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From)))
        .add_path(original.clone());
    let to =
        Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To))).add_path(renamed.clone());

    assert!(classifier.classify(&from).is_empty());
    let facts = classifier.classify(&to);
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0].kind, FileChangedKind::Renamed);
    assert_eq!(
        facts[0].new_canonical_path,
        Some(renamed.to_string_lossy().into_owned())
    );
}

#[test]
fn file_watch_real_temp_lifecycle_stops_after_deterministic_unwatch() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("watched.md");
    fs::write(&path, b"before").unwrap();
    let (tx, rx) = mpsc::channel();
    let mut registry = WatchRegistry::new();
    let watched = registry
        .watch(&path, move |event| {
            let _ = tx.send(event);
        })
        .unwrap();

    fs::write(&path, b"after").unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let observed = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let event = rx
            .recv_timeout(remaining)
            .expect("bounded watcher event timeout");
        if event.kind == FileChangedKind::Content {
            break event;
        }
    };
    assert_eq!(observed.watch_id, watched.watch_id);

    registry.unwatch(&watched.watch_id).unwrap();
    registry.unwatch(&watched.watch_id).unwrap();
    // A single filesystem write may legitimately queue more than one fact
    // before shutdown. Remove those pre-shutdown facts so the next assertion
    // measures only callbacks caused after unwatch returned.
    while rx.try_recv().is_ok() {}
    fs::write(&path, b"after shutdown").unwrap();
    assert!(rx.recv_timeout(Duration::from_millis(350)).is_err());
}
