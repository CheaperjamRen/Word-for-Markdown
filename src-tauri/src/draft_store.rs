use crate::{
    file_service::{sha256_hex, FileVersion},
    lifecycle::{deserialize_required_option, map_io_error, DesktopFailure, DesktopFailureCode},
};
use serde::{de, Deserialize, Deserializer, Serialize};
use std::{
    fs::{self, Metadata, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock},
};
use uuid::Uuid;

const ENVELOPE_VERSION: u32 = 2;
const LEGACY_ENVELOPE_VERSION: u32 = 1;
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_DRAFT_BYTES: usize = 5 * 1024 * 1024;
const MAX_REJECTED_SOURCE_BYTES: usize = 10 * 1024 * 1024;
static DRAFT_OPERATIONS: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableCoordinate {
    #[serde(deserialize_with = "deserialize_js_safe_u64")]
    pub row: u64,
    #[serde(deserialize_with = "deserialize_js_safe_u64")]
    pub column: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SelectionSnapshot {
    Text {
        #[serde(deserialize_with = "deserialize_required_option")]
        anchor_block_key: Option<String>,
        #[serde(deserialize_with = "deserialize_js_safe_u64")]
        anchor_offset: u64,
        #[serde(deserialize_with = "deserialize_required_option")]
        focus_block_key: Option<String>,
        #[serde(deserialize_with = "deserialize_js_safe_u64")]
        focus_offset: u64,
    },
    Table {
        table_block_view_key: String,
        anchor: TableCoordinate,
        focus: TableCoordinate,
        origin: TableCoordinate,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RejectedSourceBuffer {
    pub base_candidate_revision: u64,
    pub base_candidate_sha256: String,
    pub utf16_code_units_base64: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub selection: Option<SelectionSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftPayload {
    pub id: String,
    pub session_id: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub canonical_path: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub baseline_version: Option<FileVersion>,
    pub bytes: Vec<u8>,
    pub candidate_revision: u64,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub rejected_source_buffer: Option<RejectedSourceBuffer>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftRecord {
    pub id: String,
    pub session_id: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub canonical_path: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub baseline_version: Option<FileVersion>,
    pub bytes: Vec<u8>,
    pub candidate_revision: u64,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub rejected_source_buffer: Option<RejectedSourceBuffer>,
    pub updated_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DraftEnvelopeV2 {
    version: u32,
    draft: DraftRecord,
}

#[derive(Debug, Deserialize)]
struct DraftEnvelopeVersion {
    version: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacySelectionSnapshotV1 {
    #[serde(deserialize_with = "deserialize_required_option")]
    anchor_block_key: Option<String>,
    #[serde(deserialize_with = "deserialize_js_safe_u64")]
    anchor_offset: u64,
    #[serde(deserialize_with = "deserialize_required_option")]
    focus_block_key: Option<String>,
    #[serde(deserialize_with = "deserialize_js_safe_u64")]
    focus_offset: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyRejectedSourceBufferV1 {
    base_candidate_revision: u64,
    base_candidate_sha256: String,
    utf16_code_units_base64: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    selection: Option<LegacySelectionSnapshotV1>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyDraftRecordV1 {
    id: String,
    session_id: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    canonical_path: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    baseline_version: Option<FileVersion>,
    bytes: Vec<u8>,
    candidate_revision: u64,
    #[serde(deserialize_with = "deserialize_required_option")]
    rejected_source_buffer: Option<LegacyRejectedSourceBufferV1>,
    updated_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DraftEnvelopeV1 {
    version: u32,
    draft: LegacyDraftRecordV1,
}

impl LegacyDraftRecordV1 {
    fn migrate(self) -> DraftRecord {
        DraftRecord {
            id: self.id,
            session_id: self.session_id,
            canonical_path: self.canonical_path,
            baseline_version: self.baseline_version,
            bytes: self.bytes,
            candidate_revision: self.candidate_revision,
            rejected_source_buffer: self.rejected_source_buffer.map(|rejected| {
                RejectedSourceBuffer {
                    base_candidate_revision: rejected.base_candidate_revision,
                    base_candidate_sha256: rejected.base_candidate_sha256,
                    utf16_code_units_base64: rejected.utf16_code_units_base64,
                    selection: rejected.selection.map(|selection| SelectionSnapshot::Text {
                        anchor_block_key: selection.anchor_block_key,
                        anchor_offset: selection.anchor_offset,
                        focus_block_key: selection.focus_block_key,
                        focus_offset: selection.focus_offset,
                    }),
                }
            }),
            updated_ms: self.updated_ms,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteDraftRequest {
    pub draft: DraftPayload,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftIdRequest {
    pub id: String,
}

pub fn write_draft_at(
    app_data_root: &Path,
    draft: DraftPayload,
    updated_ms: u64,
) -> Result<DraftRecord, DesktopFailure> {
    let _operation = lock_operations()?;
    validate_id(&draft.id)?;
    validate_payload(&draft)?;
    if updated_ms > JS_MAX_SAFE_INTEGER {
        return Err(draft_invalid(Some(&draft.id)));
    }
    let root =
        secure_drafts_root(app_data_root, true)?.expect("creating the draft root returns a path");
    let record = DraftRecord {
        id: draft.id,
        session_id: draft.session_id,
        canonical_path: draft.canonical_path,
        baseline_version: draft.baseline_version,
        bytes: draft.bytes,
        candidate_revision: draft.candidate_revision,
        rejected_source_buffer: draft.rejected_source_buffer,
        updated_ms,
    };
    let envelope = DraftEnvelopeV2 {
        version: ENVELOPE_VERSION,
        draft: record.clone(),
    };
    let encoded = serde_json::to_vec(&envelope).map_err(|_| draft_invalid(Some(&record.id)))?;
    let target = draft_path(&root, &record.id);
    let temp = root.join(format!(".draft-write-{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|error| map_io_error(error, &target))?;
    if let Err(error) = file.write_all(&encoded).and_then(|_| file.sync_all()) {
        return Err(DesktopFailure {
            code: code_for_draft_io(&error),
            affected_paths: vec![target.to_string_lossy().into_owned()],
            recovery_paths: vec![temp.to_string_lossy().into_owned()],
            draft_id: Some(record.id.clone()),
        });
    }
    drop(file);
    if let Err(error) = move_replace(&temp, &target) {
        return Err(DesktopFailure {
            code: code_for_draft_io(&error),
            affected_paths: vec![target.to_string_lossy().into_owned()],
            recovery_paths: vec![temp.to_string_lossy().into_owned()],
            draft_id: Some(record.id.clone()),
        });
    }
    Ok(record)
}

pub fn list_drafts_at(app_data_root: &Path) -> Result<Vec<DraftRecord>, DesktopFailure> {
    let _operation = lock_operations()?;
    list_drafts_at_impl(app_data_root, || {}, || {}, false, None)
}

pub fn list_drafts_at_with_quarantine_hook(
    app_data_root: &Path,
    hook: impl FnOnce(),
) -> Result<Vec<DraftRecord>, DesktopFailure> {
    let _operation = lock_operations()?;
    list_drafts_at_impl(app_data_root, hook, || {}, false, None)
}

pub fn list_drafts_at_with_after_identity_hook(
    app_data_root: &Path,
    hook: impl FnOnce(),
) -> Result<Vec<DraftRecord>, DesktopFailure> {
    let _operation = lock_operations()?;
    list_drafts_at_impl(app_data_root, || {}, hook, false, None)
}

pub fn list_drafts_at_with_quarantine_copy_fault(
    app_data_root: &Path,
) -> Result<Vec<DraftRecord>, DesktopFailure> {
    let _operation = lock_operations()?;
    list_drafts_at_impl(app_data_root, || {}, || {}, true, None)
}

pub fn list_drafts_at_with_disposition_fault(
    app_data_root: &Path,
    error_kind: io::ErrorKind,
    block_copy_cleanup: bool,
) -> Result<Vec<DraftRecord>, DesktopFailure> {
    let _operation = lock_operations()?;
    list_drafts_at_impl(
        app_data_root,
        || {},
        || {},
        false,
        Some(DispositionFault {
            error_kind,
            block_copy_cleanup,
        }),
    )
}

#[derive(Clone, Copy)]
struct DispositionFault {
    error_kind: io::ErrorKind,
    block_copy_cleanup: bool,
}

fn list_drafts_at_impl(
    app_data_root: &Path,
    hook: impl FnOnce(),
    after_identity_hook: impl FnOnce(),
    fail_copy: bool,
    disposition_fault: Option<DispositionFault>,
) -> Result<Vec<DraftRecord>, DesktopFailure> {
    let Some(root) = secure_drafts_root(app_data_root, false)? else {
        return Ok(vec![]);
    };
    let entries = fs::read_dir(&root).map_err(|error| map_io_error(error, &root))?;
    let mut records = Vec::new();
    let mut hook = Some(hook);
    let mut after_identity_hook = Some(after_identity_hook);
    for entry in entries {
        let entry = entry.map_err(|error| map_io_error(error, &root))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let identity = entry_identity(&path)?;
        if identity.reparse {
            quarantine_if_unchanged(&root, &path, &identity, None::<fn()>, false, None)?;
            continue;
        }
        match load_record(&path) {
            Ok(record) if path.file_stem().and_then(|value| value.to_str()) == Some(&record.id) => {
                records.push(record);
            }
            _ => {
                if let Some(hook) = hook.take() {
                    hook();
                }
                if !quarantine_if_unchanged(
                    &root,
                    &path,
                    &identity,
                    after_identity_hook.take(),
                    fail_copy,
                    disposition_fault,
                )? {
                    if let Ok(record) = load_record(&path) {
                        records.push(record);
                    }
                }
            }
        }
    }
    records.sort_by(|left, right| {
        right
            .updated_ms
            .cmp(&left.updated_ms)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(records)
}

pub fn read_draft_at(app_data_root: &Path, id: &str) -> Result<DraftRecord, DesktopFailure> {
    let _operation = lock_operations()?;
    validate_id(id)?;
    let Some(root) = secure_drafts_root(app_data_root, false)? else {
        return Err(DesktopFailure::new(DesktopFailureCode::NotFound).with_draft(Some(id)));
    };
    let path = draft_path(&root, id);
    let identity = entry_identity(&path).map_err(|failure| failure.with_draft(Some(id)))?;
    if identity.reparse {
        quarantine_if_unchanged(&root, &path, &identity, None::<fn()>, false, None)?;
        return Err(draft_invalid(Some(id)));
    }
    match load_record(&path) {
        Ok(record) if record.id == id => Ok(record),
        Ok(_) | Err(LoadError::Invalid) => {
            if path.exists() {
                quarantine_if_unchanged(&root, &path, &identity, None::<fn()>, false, None)?;
            }
            Err(draft_invalid(Some(id)))
        }
        Err(LoadError::Io(error)) => Err(map_io_error(error, &path).with_draft(Some(id))),
    }
}

pub fn delete_draft_at(app_data_root: &Path, id: &str) -> Result<(), DesktopFailure> {
    let _operation = lock_operations()?;
    validate_id(id)?;
    let Some(root) = secure_drafts_root(app_data_root, false)? else {
        return Ok(());
    };
    let path = draft_path(&root, id);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(map_io_error(error, &path).with_draft(Some(id))),
    }
}

fn validate_id(id: &str) -> Result<(), DesktopFailure> {
    let parsed = Uuid::parse_str(id).map_err(|_| {
        DesktopFailure::new(DesktopFailureCode::InvalidRequest).with_draft(Some(id))
    })?;
    if parsed.hyphenated().to_string() != id.to_ascii_lowercase() {
        return Err(DesktopFailure::new(DesktopFailureCode::InvalidRequest).with_draft(Some(id)));
    }
    Ok(())
}

fn validate_payload(draft: &DraftPayload) -> Result<(), DesktopFailure> {
    if draft.bytes.len() > MAX_DRAFT_BYTES
        || draft.session_id.is_empty()
        || draft.candidate_revision > JS_MAX_SAFE_INTEGER
        || draft.baseline_version.as_ref().is_some_and(|version| {
            version.len > JS_MAX_SAFE_INTEGER || version.modified_ms > JS_MAX_SAFE_INTEGER
        })
    {
        return Err(draft_invalid(Some(&draft.id)));
    }
    if let Some(rejected) = &draft.rejected_source_buffer {
        if rejected.base_candidate_revision > JS_MAX_SAFE_INTEGER
            || rejected.base_candidate_revision != draft.candidate_revision
            || rejected.base_candidate_sha256 != sha256_hex(&draft.bytes)
            || !strict_even_base64(
                rejected.utf16_code_units_base64.as_bytes(),
                MAX_REJECTED_SOURCE_BYTES,
            )
        {
            return Err(draft_invalid(Some(&draft.id)));
        }
        if let Some(selection) = &rejected.selection {
            validate_selection(selection).map_err(|_| draft_invalid(Some(&draft.id)))?;
        }
    }
    Ok(())
}

fn validate_selection(selection: &SelectionSnapshot) -> Result<(), ()> {
    let valid = match selection {
        SelectionSnapshot::Text {
            anchor_offset,
            focus_offset,
            ..
        } => *anchor_offset <= JS_MAX_SAFE_INTEGER && *focus_offset <= JS_MAX_SAFE_INTEGER,
        SelectionSnapshot::Table {
            anchor,
            focus,
            origin,
            ..
        } => [anchor, focus, origin].into_iter().all(|coordinate| {
            coordinate.row <= JS_MAX_SAFE_INTEGER && coordinate.column <= JS_MAX_SAFE_INTEGER
        }),
    };
    valid.then_some(()).ok_or(())
}

fn deserialize_js_safe_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u64::deserialize(deserializer)?;
    if value > JS_MAX_SAFE_INTEGER {
        return Err(de::Error::custom("integer exceeds JavaScript safe range"));
    }
    Ok(value)
}

fn strict_even_base64(encoded: &[u8], max_decoded: usize) -> bool {
    if encoded.len() % 4 != 0 {
        return false;
    }
    if encoded.is_empty() {
        return true;
    }
    let padding = if encoded.ends_with(b"==") {
        2
    } else if encoded.ends_with(b"=") {
        1
    } else {
        0
    };
    let content_len = encoded.len() - padding;
    if encoded[..content_len]
        .iter()
        .any(|byte| sextet(*byte).is_none())
        || encoded[content_len..].iter().any(|byte| *byte != b'=')
        || encoded[..content_len].contains(&b'=')
    {
        return false;
    }
    if padding == 2 && sextet(encoded[content_len - 1]).map_or(true, |value| value & 0x0f != 0) {
        return false;
    }
    if padding == 1 && sextet(encoded[content_len - 1]).map_or(true, |value| value & 0x03 != 0) {
        return false;
    }
    let Some(decoded_len) = (encoded.len() / 4)
        .checked_mul(3)
        .and_then(|value| value.checked_sub(padding))
    else {
        return false;
    };
    decoded_len <= max_decoded && decoded_len % 2 == 0
}

fn sextet(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

enum LoadError {
    Invalid,
    Io(io::Error),
}

fn load_record(path: &Path) -> Result<DraftRecord, LoadError> {
    let bytes = read_entry_no_follow(path)?;
    let probe: DraftEnvelopeVersion =
        serde_json::from_slice(&bytes).map_err(|_| LoadError::Invalid)?;
    let draft = match probe.version {
        ENVELOPE_VERSION => {
            let envelope: DraftEnvelopeV2 =
                serde_json::from_slice(&bytes).map_err(|_| LoadError::Invalid)?;
            if envelope.version != ENVELOPE_VERSION {
                return Err(LoadError::Invalid);
            }
            envelope.draft
        }
        LEGACY_ENVELOPE_VERSION => {
            let envelope: DraftEnvelopeV1 =
                serde_json::from_slice(&bytes).map_err(|_| LoadError::Invalid)?;
            if envelope.version != LEGACY_ENVELOPE_VERSION {
                return Err(LoadError::Invalid);
            }
            envelope.draft.migrate()
        }
        _ => return Err(LoadError::Invalid),
    };
    if draft.updated_ms > JS_MAX_SAFE_INTEGER
        || validate_id(&draft.id).is_err()
        || validate_payload(&DraftPayload {
            id: draft.id.clone(),
            session_id: draft.session_id.clone(),
            canonical_path: draft.canonical_path.clone(),
            baseline_version: draft.baseline_version.clone(),
            bytes: draft.bytes.clone(),
            candidate_revision: draft.candidate_revision,
            rejected_source_buffer: draft.rejected_source_buffer.clone(),
        })
        .is_err()
    {
        return Err(LoadError::Invalid);
    }
    Ok(draft)
}

#[cfg(windows)]
fn read_entry_no_follow(path: &Path) -> Result<Vec<u8>, LoadError> {
    use std::{
        io::Read,
        os::windows::fs::{MetadataExt, OpenOptionsExt},
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    let mut file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(LoadError::Io)?;
    let metadata = file.metadata().map_err(LoadError::Io)?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(LoadError::Invalid);
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(LoadError::Io)?;
    Ok(bytes)
}

#[cfg(not(windows))]
fn read_entry_no_follow(path: &Path) -> Result<Vec<u8>, LoadError> {
    let metadata = fs::symlink_metadata(path).map_err(LoadError::Io)?;
    if metadata.file_type().is_symlink() {
        return Err(LoadError::Invalid);
    }
    fs::read(path).map_err(LoadError::Io)
}

#[derive(Debug)]
struct QuarantineFailure {
    error: io::Error,
    guard_failure: bool,
    recovery_copy: bool,
}

impl QuarantineFailure {
    fn guard(error: io::Error) -> Self {
        Self {
            error,
            guard_failure: true,
            recovery_copy: false,
        }
    }

    fn operation(error: io::Error) -> Self {
        Self {
            error,
            guard_failure: false,
            recovery_copy: false,
        }
    }

    fn after_copy(error: io::Error, target: &Path) -> Self {
        Self {
            error,
            guard_failure: false,
            recovery_copy: cleanup_failed_or_copy_may_remain(target),
        }
    }

    fn is_retryable_guard(&self) -> bool {
        self.guard_failure
            && matches!(
                self.error.kind(),
                io::ErrorKind::PermissionDenied | io::ErrorKind::WouldBlock
            )
    }
}

fn cleanup_failed_or_copy_may_remain(target: &Path) -> bool {
    let cleanup_failed = match fs::remove_file(target) {
        Ok(()) => false,
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(_) => true,
    };
    let copy_may_remain = match fs::symlink_metadata(target) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Ok(_) | Err(_) => true,
    };
    cleanup_failed || copy_may_remain
}

fn write_durable_quarantine_copy(target: &Path, bytes: &[u8]) -> Result<(), QuarantineFailure> {
    let mut copy = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(QuarantineFailure::operation)?;
    let write_result = copy.write_all(bytes).and_then(|_| copy.sync_all());
    drop(copy);
    if let Err(error) = write_result {
        return Err(QuarantineFailure::after_copy(error, target));
    }
    match fs::read(target) {
        Ok(copied) if copied == bytes => Ok(()),
        Ok(_) => Err(QuarantineFailure::after_copy(
            io::Error::other("quarantine copy verification failed"),
            target,
        )),
        Err(error) => Err(QuarantineFailure::after_copy(error, target)),
    }
}

fn finish_quarantine_disposition(
    result: io::Result<()>,
    durable_copy: Option<&Path>,
) -> Result<(), QuarantineFailure> {
    result.map_err(|error| match durable_copy {
        Some(target) => QuarantineFailure::after_copy(error, target),
        None => QuarantineFailure::operation(error),
    })
}

fn quarantine_if_unchanged(
    root: &Path,
    path: &Path,
    expected: &EntryIdentity,
    after_identity_hook: Option<impl FnOnce()>,
    fail_copy: bool,
    disposition_fault: Option<DispositionFault>,
) -> Result<bool, DesktopFailure> {
    let current = entry_identity(path)?;
    if &current != expected {
        return Ok(false);
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("draft");
    let nonce = Uuid::new_v4().simple().to_string();
    let target = root.join(format!("{name}.{}.invalid", &nonce[..8]));
    match quarantine_verified_identity(
        path,
        &target,
        expected,
        after_identity_hook,
        fail_copy,
        disposition_fault,
    ) {
        Ok(()) => Ok(true),
        Err(error) if error.is_retryable_guard() => Ok(false),
        Err(error) => {
            let QuarantineFailure {
                error,
                recovery_copy,
                ..
            } = error;
            let mut failure = map_io_error(error, path);
            if recovery_copy {
                failure
                    .recovery_paths
                    .push(target.to_string_lossy().into_owned());
            }
            Err(failure)
        }
    }
}

#[cfg(windows)]
fn quarantine_verified_identity(
    path: &Path,
    target: &Path,
    expected: &EntryIdentity,
    hook: Option<impl FnOnce()>,
    fail_copy: bool,
    disposition_fault: Option<DispositionFault>,
) -> Result<(), QuarantineFailure> {
    use std::{
        io::Read,
        mem::zeroed,
        os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    };
    use windows_sys::Win32::Foundation::GENERIC_READ;
    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfo, GetFileInformationByHandle, SetFileInformationByHandle,
        BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_INFO,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
    };
    let (mut file, info) = (|| {
        let file = OpenOptions::new()
            .access_mode(GENERIC_READ | DELETE)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let volume = info.dwVolumeSerialNumber as u64;
        let index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
        if volume != expected.volume || index != expected.file_index {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "draft identity changed",
            ));
        }
        Ok((file, info))
    })()
    .map_err(QuarantineFailure::guard)?;
    if let Some(hook) = hook {
        hook();
    }
    let copied = info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0;
    if copied {
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(QuarantineFailure::operation)?;
        if fail_copy {
            return Err(QuarantineFailure::operation(io::Error::other(
                "injected quarantine copy failure",
            )));
        }
        write_durable_quarantine_copy(target, &bytes)?;
    }
    let _cleanup_blocker = match disposition_fault {
        Some(fault) if fault.block_copy_cleanup && copied => {
            let blocker = OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ)
                .open(target)
                .map_err(|error| QuarantineFailure::after_copy(error, target))?;
            Some(blocker)
        }
        _ => None,
    };
    let disposition_result = match disposition_fault {
        Some(fault) => Err(io::Error::from(fault.error_kind)),
        None => {
            let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
            if unsafe {
                SetFileInformationByHandle(
                    file.as_raw_handle(),
                    FileDispositionInfo,
                    (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                    std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
                )
            } == 0
            {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
    };
    finish_quarantine_disposition(disposition_result, copied.then_some(target))
}

#[cfg(not(windows))]
fn quarantine_verified_identity(
    path: &Path,
    target: &Path,
    expected: &EntryIdentity,
    hook: Option<impl FnOnce()>,
    fail_copy: bool,
    disposition_fault: Option<DispositionFault>,
) -> Result<(), QuarantineFailure> {
    let metadata = fs::symlink_metadata(path).map_err(QuarantineFailure::guard)?;
    if &identity_from_metadata(&metadata) != expected {
        return Err(QuarantineFailure::guard(io::Error::new(
            io::ErrorKind::WouldBlock,
            "draft identity changed",
        )));
    }
    if let Some(hook) = hook {
        hook();
    }
    if fail_copy {
        return Err(QuarantineFailure::operation(io::Error::other(
            "injected quarantine copy failure",
        )));
    }
    let bytes = fs::read(path).map_err(QuarantineFailure::operation)?;
    write_durable_quarantine_copy(target, &bytes)?;
    let disposition_result = match disposition_fault {
        Some(fault) => Err(io::Error::from(fault.error_kind)),
        None => fs::remove_file(path),
    };
    finish_quarantine_disposition(disposition_result, Some(target))
}

fn lock_operations() -> Result<MutexGuard<'static, ()>, DesktopFailure> {
    DRAFT_OPERATIONS
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| DesktopFailure::new(DesktopFailureCode::Io))
}

#[derive(Debug, PartialEq, Eq)]
struct EntryIdentity {
    len: u64,
    modified: Option<std::time::SystemTime>,
    reparse: bool,
    volume: u64,
    file_index: u64,
}

fn entry_identity(path: &Path) -> Result<EntryIdentity, DesktopFailure> {
    let metadata = fs::symlink_metadata(path).map_err(|error| map_io_error(error, path))?;
    let mut identity = identity_from_metadata(&metadata);
    #[cfg(windows)]
    if !identity.reparse {
        use std::{
            mem::zeroed,
            os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
        };
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        let file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|error| map_io_error(error, path))?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(map_io_error(io::Error::last_os_error(), path));
        }
        identity.volume = info.dwVolumeSerialNumber as u64;
        identity.file_index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
    }
    Ok(identity)
}

#[cfg(windows)]
fn identity_from_metadata(metadata: &Metadata) -> EntryIdentity {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    EntryIdentity {
        len: metadata.len(),
        modified: metadata.modified().ok(),
        reparse: metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0,
        volume: 0,
        file_index: 0,
    }
}

#[cfg(not(windows))]
fn identity_from_metadata(metadata: &Metadata) -> EntryIdentity {
    use std::os::unix::fs::MetadataExt;
    EntryIdentity {
        len: metadata.len(),
        modified: metadata.modified().ok(),
        reparse: metadata.file_type().is_symlink(),
        volume: metadata.dev(),
        file_index: metadata.ino(),
    }
}

fn secure_drafts_root(
    app_data_root: &Path,
    create: bool,
) -> Result<Option<PathBuf>, DesktopFailure> {
    if !create {
        match fs::symlink_metadata(app_data_root) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(map_io_error(error, app_data_root)),
            Ok(_) => {}
        }
    }
    if create {
        fs::create_dir_all(app_data_root).map_err(|error| map_io_error(error, app_data_root))?;
    }
    let canonical_app = app_data_root
        .canonicalize()
        .map_err(|error| map_io_error(error, app_data_root))?;
    let root = canonical_app.join("drafts");
    if !root.exists() && !create {
        return Ok(None);
    }
    ensure_safe_directory(&root, create)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| map_io_error(error, &root))?;
    if canonical_root.parent() != Some(canonical_app.as_path()) {
        return Err(draft_invalid(None));
    }
    Ok(Some(canonical_root))
}

fn ensure_safe_directory(path: &Path, create: bool) -> Result<(), DesktopFailure> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|error| map_io_error(error, path))?;
            fs::symlink_metadata(path).map_err(|error| map_io_error(error, path))?
        }
        Err(error) => return Err(map_io_error(error, path)),
    };
    let identity = identity_from_metadata(&metadata);
    if identity.reparse || !metadata.is_dir() {
        return Err(draft_invalid(None));
    }
    Ok(())
}

fn draft_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.json"))
}

fn draft_invalid(id: Option<&str>) -> DesktopFailure {
    DesktopFailure::new(DesktopFailureCode::DraftInvalid).with_draft(id)
}

fn code_for_draft_io(error: &io::Error) -> DesktopFailureCode {
    match error.kind() {
        io::ErrorKind::PermissionDenied => DesktopFailureCode::PermissionDenied,
        _ => DesktopFailureCode::Io,
    }
}

#[cfg(windows)]
fn move_replace(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let succeeded = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if succeeded == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn move_replace(source: &Path, target: &Path) -> io::Result<()> {
    fs::rename(source, target)
}
