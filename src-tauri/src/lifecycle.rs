use crate::file_service::{
    read_utf8_document, recoverable_replace_utf8, validate_utf8_bytes,
    version_from_metadata_and_bytes, FileServiceError, FileVersion, HostOpenDocument,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Copy)]
pub enum DurableCopyFault {
    RecoveryWrite,
    MovingSync,
}

pub(crate) fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopFailureCode {
    InvalidRequest,
    InvalidPath,
    NotFound,
    AlreadyExists,
    Changed,
    ConcurrentWriter,
    PermissionDenied,
    ReadOnly,
    Io,
    DraftInvalid,
    WatchFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopFailure {
    pub code: DesktopFailureCode,
    pub affected_paths: Vec<String>,
    pub recovery_paths: Vec<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub draft_id: Option<String>,
}

impl DesktopFailure {
    pub(crate) fn new(code: DesktopFailureCode) -> Self {
        Self {
            code,
            affected_paths: vec![],
            recovery_paths: vec![],
            draft_id: None,
        }
    }

    pub(crate) fn with_affected(mut self, path: &Path) -> Self {
        self.affected_paths
            .push(path.to_string_lossy().into_owned());
        self
    }

    pub(crate) fn with_draft(mut self, id: Option<&str>) -> Self {
        self.draft_id = id.map(str::to_owned);
        self
    }

    fn with_recovery(mut self, path: &Path) -> Self {
        self.recovery_paths
            .push(path.to_string_lossy().into_owned());
        self
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveDocumentAsRequest {
    pub target_path: String,
    pub bytes: Vec<u8>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub expected_target_version: Option<FileVersion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveDocumentAsResult {
    pub canonical_path: String,
    pub version: FileVersion,
}

pub fn open_document_at(path: &Path) -> Result<HostOpenDocument, DesktopFailure> {
    read_utf8_document(path).map_err(|error| map_file_error(error, path))
}

pub fn save_document_as(
    request: SaveDocumentAsRequest,
) -> Result<SaveDocumentAsResult, DesktopFailure> {
    save_document_as_with_hooks(request, || {}, || {})
}

pub fn save_document_as_with_hook(
    request: SaveDocumentAsRequest,
    before_commit: impl FnOnce(),
) -> Result<SaveDocumentAsResult, DesktopFailure> {
    save_document_as_with_hooks(request, before_commit, || {})
}

pub fn save_document_as_with_hooks(
    request: SaveDocumentAsRequest,
    before_commit: impl FnOnce(),
    after_commit: impl FnOnce(),
) -> Result<SaveDocumentAsResult, DesktopFailure> {
    save_document_as_internal(request, before_commit, after_commit, || Ok(()), None)
}

pub fn save_document_as_with_verification_hook(
    request: SaveDocumentAsRequest,
    hook: impl FnOnce() -> io::Result<()>,
) -> Result<SaveDocumentAsResult, DesktopFailure> {
    save_document_as_internal(request, || {}, || {}, hook, None)
}

pub fn save_document_as_with_fault(
    request: SaveDocumentAsRequest,
    fault: DurableCopyFault,
) -> Result<SaveDocumentAsResult, DesktopFailure> {
    save_document_as_internal(request, || {}, || {}, || Ok(()), Some(fault))
}

fn save_document_as_internal(
    request: SaveDocumentAsRequest,
    before_commit: impl FnOnce(),
    after_commit: impl FnOnce(),
    verify_hook: impl FnOnce() -> io::Result<()>,
    fault: Option<DurableCopyFault>,
) -> Result<SaveDocumentAsResult, DesktopFailure> {
    let requested = PathBuf::from(&request.target_path);
    let target = normalized_markdown_target(&requested)?;
    validate_utf8_bytes(&request.bytes).map_err(|error| map_file_error(error, &target))?;
    let Some(expected) = request.expected_target_version else {
        return create_new_durable(
            &target,
            &request.bytes,
            before_commit,
            after_commit,
            verify_hook,
            fault,
        );
    };
    match target.try_exists() {
        Ok(true) => {
            if fs::metadata(&target).is_ok_and(|metadata| metadata.permissions().readonly()) {
                return Err(
                    DesktopFailure::new(DesktopFailureCode::ReadOnly).with_affected(&target)
                );
            }
            let version = recoverable_replace_utf8(&target, &request.bytes, &expected)
                .map_err(|error| map_file_error(error, &target))?;
            let canonical_path = target
                .canonicalize()
                .map_err(|error| map_io_error(error, &target))?
                .to_string_lossy()
                .into_owned();
            Ok(SaveDocumentAsResult {
                canonical_path,
                version,
            })
        }
        Ok(false) => Err(DesktopFailure::new(DesktopFailureCode::NotFound).with_affected(&target)),
        Err(error) => Err(map_io_error(error, &target)),
    }
}

fn normalized_markdown_target(requested: &Path) -> Result<PathBuf, DesktopFailure> {
    let extension = requested
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if !matches!(extension.as_deref(), Some("md" | "markdown")) {
        return Err(DesktopFailure::new(DesktopFailureCode::InvalidPath).with_affected(requested));
    }
    let Some(name) = requested.file_name() else {
        return Err(DesktopFailure::new(DesktopFailureCode::InvalidPath).with_affected(requested));
    };
    let Some(parent) = requested.parent() else {
        return Err(DesktopFailure::new(DesktopFailureCode::InvalidPath).with_affected(requested));
    };
    let parent = parent
        .canonicalize()
        .map_err(|error| map_io_error(error, requested))?;
    if !parent.is_dir() {
        return Err(DesktopFailure::new(DesktopFailureCode::InvalidPath).with_affected(requested));
    }
    Ok(parent.join(name))
}

fn create_new_durable(
    target: &Path,
    bytes: &[u8],
    before_commit: impl FnOnce(),
    after_commit: impl FnOnce(),
    verify_hook: impl FnOnce() -> io::Result<()>,
    fault: Option<DurableCopyFault>,
) -> Result<SaveDocumentAsResult, DesktopFailure> {
    let recovery = target
        .parent()
        .expect("normalized target has parent")
        .join(format!(
            ".markdown-spike-save-as-recovery-{}.tmp",
            Uuid::new_v4()
        ));
    let moving = target
        .parent()
        .expect("normalized target has parent")
        .join(format!(
            ".markdown-spike-save-as-moving-{}.tmp",
            Uuid::new_v4()
        ));
    if let Err(error) = create_durable_file(
        &recovery,
        bytes,
        matches!(fault, Some(DurableCopyFault::RecoveryWrite)),
        false,
    ) {
        let mut failure = map_io_error(error, target);
        if recovery.exists() {
            failure = failure.with_recovery(&recovery);
        }
        return Err(failure);
    }
    if let Err(error) = create_durable_file(
        &moving,
        bytes,
        false,
        matches!(fault, Some(DurableCopyFault::MovingSync)),
    ) {
        let _ = fs::remove_file(&moving);
        let mut failure = DesktopFailure::new(code_for_io(&error))
            .with_affected(target)
            .with_recovery(&recovery);
        if moving.exists() {
            failure = failure.with_recovery(&moving);
        }
        return Err(failure);
    }
    before_commit();

    if let Err(error) = move_no_replace(&moving, target) {
        let _ = fs::remove_file(&moving);
        return Err(DesktopFailure::new(code_for_io(&error))
            .with_affected(target)
            .with_recovery(&recovery));
    }
    after_commit();
    verify_new_target_and_cleanup(target, bytes, &recovery, verify_hook)
}

fn create_durable_file(
    path: &Path,
    bytes: &[u8],
    fail_write: bool,
    fail_sync: bool,
) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let result = if fail_write {
        Err(io::Error::other("injected write failure"))
    } else {
        file.write_all(bytes).and_then(|_| {
            if fail_sync {
                Err(io::Error::other("injected sync failure"))
            } else {
                file.sync_all()
            }
        })
    };
    drop(file);
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

#[cfg(windows)]
fn verify_new_target_and_cleanup(
    target: &Path,
    expected: &[u8],
    recovery: &Path,
    verify_hook: impl FnOnce() -> io::Result<()>,
) -> Result<SaveDocumentAsResult, DesktopFailure> {
    use std::{io::Read, os::windows::fs::OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ};

    let mut file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(target)
        .map_err(|error| failure_with_recovery(error, target, recovery))?;
    let metadata = file
        .metadata()
        .map_err(|error| failure_with_recovery(error, target, recovery))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| failure_with_recovery(error, target, recovery))?;
    if bytes != expected {
        return Err(DesktopFailure::new(DesktopFailureCode::Changed)
            .with_affected(target)
            .with_recovery(recovery));
    }
    let version = version_from_metadata_and_bytes(&metadata, &bytes)
        .map_err(|error| failure_with_recovery(error, target, recovery))?;
    let canonical_path = canonical_path_from_handle(&file)
        .map_err(|error| failure_with_recovery(error, target, recovery))?;
    verify_hook().map_err(|error| failure_with_recovery(error, target, recovery))?;
    fs::remove_file(recovery).map_err(|error| failure_with_recovery(error, target, recovery))?;
    Ok(SaveDocumentAsResult {
        canonical_path,
        version,
    })
}

#[cfg(windows)]
fn canonical_path_from_handle(file: &std::fs::File) -> io::Result<String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let needed =
        unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), std::ptr::null_mut(), 0, 0) };
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0u16; needed as usize + 1];
    let written = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    if written == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(String::from_utf16_lossy(&buffer[..written as usize]))
}

#[cfg(not(windows))]
fn verify_new_target_and_cleanup(
    target: &Path,
    expected: &[u8],
    recovery: &Path,
    verify_hook: impl FnOnce() -> io::Result<()>,
) -> Result<SaveDocumentAsResult, DesktopFailure> {
    let opened = read_utf8_document(target).map_err(|error| {
        let mut failure = map_file_error(error, target);
        failure
            .recovery_paths
            .push(recovery.to_string_lossy().into_owned());
        failure
    })?;
    if opened.bytes != expected {
        return Err(DesktopFailure::new(DesktopFailureCode::Changed)
            .with_affected(target)
            .with_recovery(recovery));
    }
    verify_hook().map_err(|error| failure_with_recovery(error, target, recovery))?;
    fs::remove_file(recovery).map_err(|error| failure_with_recovery(error, target, recovery))?;
    Ok(SaveDocumentAsResult {
        canonical_path: opened.canonical_path,
        version: opened.version,
    })
}

fn failure_with_recovery(error: io::Error, target: &Path, recovery: &Path) -> DesktopFailure {
    DesktopFailure::new(code_for_io(&error))
        .with_affected(target)
        .with_recovery(recovery)
}

#[cfg(windows)]
fn move_no_replace(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let succeeded =
        unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) };
    if succeeded == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn move_no_replace(source: &Path, target: &Path) -> io::Result<()> {
    fs::hard_link(source, target)?;
    fs::remove_file(source)
}

pub(crate) fn map_file_error(error: FileServiceError, affected: &Path) -> DesktopFailure {
    let (code, recovery) = match error {
        FileServiceError::InvalidPath(_) => (DesktopFailureCode::InvalidPath, vec![]),
        FileServiceError::UnsupportedEncoding | FileServiceError::TooLarge => {
            (DesktopFailureCode::InvalidRequest, vec![])
        }
        FileServiceError::ChangedExternally | FileServiceError::ChangedWhileReading => {
            (DesktopFailureCode::Changed, vec![])
        }
        FileServiceError::ReplacementRace { artifacts } => (DesktopFailureCode::Changed, artifacts),
        FileServiceError::ConcurrentWriter { artifacts } => {
            (DesktopFailureCode::ConcurrentWriter, artifacts)
        }
        FileServiceError::ReplacementUncertain { artifacts, source } => {
            (code_for_io(&source), artifacts)
        }
        FileServiceError::Io(source) => (code_for_io(&source), vec![]),
    };
    DesktopFailure {
        code,
        affected_paths: vec![affected.to_string_lossy().into_owned()],
        recovery_paths: recovery
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        draft_id: None,
    }
}

pub(crate) fn map_io_error(error: io::Error, affected: &Path) -> DesktopFailure {
    DesktopFailure::new(code_for_io(&error)).with_affected(affected)
}

fn code_for_io(error: &io::Error) -> DesktopFailureCode {
    match error.kind() {
        io::ErrorKind::NotFound => DesktopFailureCode::NotFound,
        io::ErrorKind::AlreadyExists => DesktopFailureCode::AlreadyExists,
        io::ErrorKind::PermissionDenied => DesktopFailureCode::PermissionDenied,
        _ => DesktopFailureCode::Io,
    }
}
