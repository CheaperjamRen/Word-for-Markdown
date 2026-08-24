use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions, Permissions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use uuid::Uuid;

const MAX_DOCUMENT_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileVersion {
    pub len: u64,
    pub modified_ms: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostOpenDocument {
    pub canonical_path: String,
    pub bytes: Vec<u8>,
    pub version: FileVersion,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OpenDocumentRequest {
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveDocumentRequest {
    pub canonical_path: String,
    pub bytes: Vec<u8>,
    pub expected_version: FileVersion,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum FileServiceError {
    #[error("not a readable Markdown file: {0}")]
    InvalidPath(String),
    #[error("Only unambiguous UTF-8 Markdown is supported")]
    UnsupportedEncoding,
    #[error("Markdown file exceeds the 5 MB limit")]
    TooLarge,
    #[error("file changed externally; original and draft were not overwritten")]
    ChangedExternally,
    #[error("file changed while reading")]
    ChangedWhileReading,
    #[error("file changed during Windows replacement; target and recovery versions were preserved: {artifacts:?}")]
    ReplacementRace { artifacts: Vec<PathBuf> },
    #[error("a shared writer still owns a replaced file identity; recovery versions were preserved: {artifacts:?}")]
    ConcurrentWriter { artifacts: Vec<PathBuf> },
    #[error("Windows replacement could not be reconciled; inspect preserved versions {artifacts:?}: {source}")]
    ReplacementUncertain {
        artifacts: Vec<PathBuf>,
        #[source]
        source: io::Error,
    },
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl FileServiceError {
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn recovery_paths(&self) -> &[PathBuf] {
        match self {
            Self::ReplacementRace { artifacts }
            | Self::ConcurrentWriter { artifacts }
            | Self::ReplacementUncertain { artifacts, .. } => artifacts,
            _ => &[],
        }
    }
}

pub(crate) fn read_utf8_document(path: &Path) -> Result<HostOpenDocument, FileServiceError> {
    read_utf8_document_with_hook(path, |_| {})
}

pub(crate) fn read_utf8_document_with_hook(
    path: &Path,
    mut after_bytes: impl FnMut(usize),
) -> Result<HostOpenDocument, FileServiceError> {
    let canonical = canonical_markdown_path(path)?;

    for attempt in 0..2 {
        let before = fs::metadata(&canonical)?;
        if before.len() > MAX_DOCUMENT_BYTES {
            return Err(FileServiceError::TooLarge);
        }

        let bytes = fs::read(&canonical)?;
        after_bytes(attempt);
        let after = fs::metadata(&canonical)?;

        if metadata_observation_matches(&before, &after) && after.len() == bytes.len() as u64 {
            validate_utf8_bytes(&bytes)?;
            let version = version_from_metadata_and_bytes(&after, &bytes)?;
            return Ok(HostOpenDocument {
                canonical_path: canonical.to_string_lossy().into_owned(),
                bytes,
                version,
            });
        }
    }

    Err(FileServiceError::ChangedWhileReading)
}

fn canonical_markdown_path(path: &Path) -> Result<PathBuf, FileServiceError> {
    let invalid = || FileServiceError::InvalidPath(path.to_string_lossy().into_owned());
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(invalid)?;
    if extension != "md" && extension != "markdown" {
        return Err(invalid());
    }

    let canonical = path.canonicalize().map_err(|_| invalid())?;
    if !canonical.is_file() {
        return Err(invalid());
    }
    Ok(canonical)
}

fn metadata_observation_matches(before: &Metadata, after: &Metadata) -> bool {
    before.is_file() == after.is_file()
        && before.len() == after.len()
        && before.modified().ok() == after.modified().ok()
}

pub(crate) fn validate_utf8_bytes(bytes: &[u8]) -> Result<(), FileServiceError> {
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(FileServiceError::TooLarge);
    }
    let payload = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    std::str::from_utf8(payload)
        .map(|_| ())
        .map_err(|_| FileServiceError::UnsupportedEncoding)
}

pub(crate) fn version_from_metadata_and_bytes(
    metadata: &Metadata,
    bytes: &[u8],
) -> Result<FileVersion, io::Error> {
    let modified_ms = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX);
    Ok(FileVersion {
        len: bytes.len() as u64,
        modified_ms,
        sha256: sha256_hex(bytes),
    })
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) trait ReplaceOperation {
    fn replace(&mut self, replaced: &Path, replacement: &Path, backup: &Path) -> io::Result<()>;
}

pub(crate) struct WindowsReplaceOperation;

impl ReplaceOperation for WindowsReplaceOperation {
    fn replace(&mut self, replaced: &Path, replacement: &Path, backup: &Path) -> io::Result<()> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

        fn wide(path: &Path) -> Vec<u16> {
            path.as_os_str().encode_wide().chain(Some(0)).collect()
        }

        let replaced = wide(replaced);
        let replacement = wide(replacement);
        let backup = wide(backup);

        // ReplaceFileW flags are deliberately zero: Microsoft documents
        // REPLACEFILE_WRITE_THROUGH as unsupported.
        // https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-replacefilew
        let succeeded = unsafe {
            ReplaceFileW(
                replaced.as_ptr(),
                replacement.as_ptr(),
                backup.as_ptr(),
                0,
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        if succeeded == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

struct StableSnapshot {
    _file: File,
    bytes: Vec<u8>,
    version: FileVersion,
}

#[derive(Clone, Copy)]
enum StableSnapshotMode {
    CleanupArtifact,
    NoDelete,
}

fn open_stable_snapshot(path: &Path, mode: StableSnapshotMode) -> io::Result<StableSnapshot> {
    use std::{
        os::windows::{ffi::OsStrExt, io::FromRawHandle},
        ptr,
    };
    use windows_sys::Win32::{
        Foundation::{GENERIC_READ, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ, OPEN_EXISTING,
        },
    };

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // Both modes omit FILE_SHARE_WRITE. Cleanup artifacts additionally share
    // delete so this transaction can remove their proven paths; final-target
    // and failure guards omit delete sharing to fix each path identity.
    // https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-createfilew
    let share_mode = match mode {
        StableSnapshotMode::CleanupArtifact => FILE_SHARE_READ | FILE_SHARE_DELETE,
        StableSnapshotMode::NoDelete => FILE_SHARE_READ,
    };
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            share_mode,
            ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }

    let mut file = unsafe { File::from_raw_handle(handle) };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let metadata = file.metadata()?;
    let version = version_from_metadata_and_bytes(&metadata, &bytes)?;
    Ok(StableSnapshot {
        _file: file,
        bytes,
        version,
    })
}

#[derive(Debug)]
struct TransactionPaths {
    target: PathBuf,
    replacement: PathBuf,
    local_recovery: PathBuf,
    replaced_backup: PathBuf,
    rollback_capture: PathBuf,
}

impl TransactionPaths {
    fn new(target: PathBuf) -> Self {
        let id = Uuid::new_v4().simple().to_string();
        let parent = target
            .parent()
            .expect("a canonical file always has a parent directory")
            .to_path_buf();
        Self {
            target,
            replacement: parent.join(format!(".markdown-spike-{id}.replacement")),
            local_recovery: parent.join(format!(".markdown-spike-{id}.local-recovery")),
            replaced_backup: parent.join(format!(".markdown-spike-{id}.replaced-backup")),
            rollback_capture: parent.join(format!(".markdown-spike-{id}.rollback-capture")),
        }
    }

    fn all(&self) -> [&Path; 5] {
        [
            &self.target,
            &self.replacement,
            &self.local_recovery,
            &self.replaced_backup,
            &self.rollback_capture,
        ]
    }

    fn surviving(&self) -> Vec<PathBuf> {
        self.all()
            .into_iter()
            .filter(|path| path.try_exists().unwrap_or(true))
            .map(Path::to_path_buf)
            .collect()
    }
}

pub(crate) fn recoverable_replace_utf8(
    target: &Path,
    candidate: &[u8],
    expected: &FileVersion,
) -> Result<FileVersion, FileServiceError> {
    recoverable_replace_utf8_with_hooks(
        target,
        candidate,
        expected,
        || {},
        || {},
        || {},
        || {},
        || {},
    )
}

pub(crate) fn recoverable_replace_utf8_with_hooks<F, G, H, J, I>(
    target: &Path,
    candidate: &[u8],
    expected: &FileVersion,
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
    let mut operation = WindowsReplaceOperation;
    recoverable_replace_utf8_with_backend_and_hooks(
        target,
        candidate,
        expected,
        &mut operation,
        before_replace,
        after_replace,
        after_initial_validation_before_cleanup,
        after_final_target_snapshot_before_cleanup,
        before_rollback,
    )
}

pub(crate) fn recoverable_replace_utf8_with_backend_and_hooks<R, F, G, H, J, I>(
    target: &Path,
    candidate: &[u8],
    expected: &FileVersion,
    replace_op: &mut R,
    before_replace: F,
    after_replace: G,
    after_initial_validation_before_cleanup: H,
    after_final_target_snapshot_before_cleanup: J,
    before_rollback: I,
) -> Result<FileVersion, FileServiceError>
where
    R: ReplaceOperation,
    F: FnOnce(),
    G: FnOnce(),
    H: FnOnce(),
    J: FnOnce(),
    I: FnOnce(),
{
    validate_utf8_bytes(candidate)?;
    let opened = read_utf8_document(target)?;
    if &opened.version != expected {
        return Err(FileServiceError::ChangedExternally);
    }

    let target = PathBuf::from(opened.canonical_path);
    let permissions = fs::metadata(&target)?.permissions();
    let transaction = TransactionPaths::new(target);

    if let Err(source) =
        create_durable_candidate(&transaction.replacement, candidate, permissions.clone())
    {
        return Err(classify_failure(&transaction, source));
    }
    if let Err(source) =
        create_durable_candidate(&transaction.local_recovery, candidate, permissions)
    {
        return Err(classify_failure(&transaction, source));
    }

    match read_utf8_document(&transaction.target) {
        Ok(rechecked) if rechecked.version == *expected => {}
        Ok(_)
        | Err(FileServiceError::InvalidPath(_))
        | Err(FileServiceError::UnsupportedEncoding)
        | Err(FileServiceError::TooLarge) => {
            discard_proven_candidate_copies(&transaction, candidate)?;
            return Err(FileServiceError::ChangedExternally);
        }
        Err(FileServiceError::Io(source)) if is_sharing_violation(&source) => {
            return Err(FileServiceError::ConcurrentWriter {
                artifacts: transaction.surviving(),
            });
        }
        Err(error) => {
            return Err(FileServiceError::ReplacementUncertain {
                artifacts: transaction.surviving(),
                source: io::Error::other(error.to_string()),
            });
        }
    }

    before_replace();
    ensure_absent(&transaction.replaced_backup, &transaction)?;
    ensure_absent(&transaction.rollback_capture, &transaction)?;
    if let Err(source) = replace_op.replace(
        &transaction.target,
        &transaction.replacement,
        &transaction.replaced_backup,
    ) {
        return Err(classify_failure(&transaction, source));
    }
    after_replace();

    let backup = cleanup_snapshot_for_transaction(&transaction.replaced_backup, &transaction)?;
    let initial_target = no_delete_snapshot_for_transaction(&transaction.target, &transaction)?;

    if backup.version == *expected {
        if initial_target.bytes != candidate {
            return Err(replacement_race(&transaction));
        }
        drop(initial_target);

        after_initial_validation_before_cleanup();
        let final_target = no_delete_snapshot_for_transaction(&transaction.target, &transaction)?;
        let local = cleanup_snapshot_for_transaction(&transaction.local_recovery, &transaction)?;
        if final_target.bytes != candidate || local.bytes != candidate {
            return Err(replacement_race(&transaction));
        }
        after_final_target_snapshot_before_cleanup();

        // Comparison plus ReplaceFileW is not filesystem CAS. Success is only
        // reported after stable target/backup/local identities match the two
        // expected byte generations throughout transaction cleanup.
        let saved_version = final_target.version.clone();
        remove_while_stable(&transaction.local_recovery, &transaction)?;
        remove_while_stable(&transaction.replaced_backup, &transaction)?;
        return Ok(saved_version);
    }

    if initial_target.bytes != candidate {
        return Err(replacement_race(&transaction));
    }

    let raced_external = backup.bytes.clone();
    drop(initial_target);
    drop(backup);
    before_rollback();
    ensure_absent(&transaction.rollback_capture, &transaction)?;

    if let Err(source) = replace_op.replace(
        &transaction.target,
        &transaction.replaced_backup,
        &transaction.rollback_capture,
    ) {
        return Err(classify_failure(&transaction, source));
    }

    let rolled_back_target = no_delete_snapshot_for_transaction(&transaction.target, &transaction)?;
    let local = no_delete_snapshot_for_transaction(&transaction.local_recovery, &transaction)?;
    let _capture = no_delete_snapshot_for_transaction(&transaction.rollback_capture, &transaction)?;
    if rolled_back_target.bytes != raced_external || local.bytes != candidate {
        return Err(FileServiceError::ReplacementUncertain {
            artifacts: transaction.surviving(),
            source: io::Error::other("rollback state did not retain the classified generations"),
        });
    }

    Err(replacement_race(&transaction))
}

fn create_durable_candidate(
    path: &Path,
    candidate: &[u8],
    permissions: Permissions,
) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(candidate)?;
    fs::set_permissions(path, permissions)?;
    file.sync_all()?;
    drop(file);
    Ok(())
}

fn discard_proven_candidate_copies(
    transaction: &TransactionPaths,
    candidate: &[u8],
) -> Result<(), FileServiceError> {
    let replacement = cleanup_snapshot_for_transaction(&transaction.replacement, transaction)?;
    let local = cleanup_snapshot_for_transaction(&transaction.local_recovery, transaction)?;
    if replacement.bytes != candidate || local.bytes != candidate {
        return Err(FileServiceError::ReplacementUncertain {
            artifacts: transaction.surviving(),
            source: io::Error::other("candidate recovery copy changed before stale-save cleanup"),
        });
    }

    remove_while_stable(&transaction.replacement, transaction)?;
    remove_while_stable(&transaction.local_recovery, transaction)?;
    drop(replacement);
    drop(local);
    Ok(())
}

fn remove_while_stable(
    path: &Path,
    transaction: &TransactionPaths,
) -> Result<(), FileServiceError> {
    fs::remove_file(path).map_err(|source| FileServiceError::ReplacementUncertain {
        artifacts: transaction.surviving(),
        source,
    })?;
    if path
        .try_exists()
        .map_err(|source| FileServiceError::ReplacementUncertain {
            artifacts: transaction.surviving(),
            source,
        })?
    {
        return Err(FileServiceError::ReplacementUncertain {
            artifacts: transaction.surviving(),
            source: io::Error::other("transaction path still exists after cleanup"),
        });
    }
    Ok(())
}

fn ensure_absent(path: &Path, transaction: &TransactionPaths) -> Result<(), FileServiceError> {
    match path.try_exists() {
        Ok(false) => Ok(()),
        Ok(true) => Err(FileServiceError::ReplacementUncertain {
            artifacts: transaction.surviving(),
            source: io::Error::new(
                io::ErrorKind::AlreadyExists,
                "transaction backup path already exists",
            ),
        }),
        Err(source) => Err(FileServiceError::ReplacementUncertain {
            artifacts: transaction.surviving(),
            source,
        }),
    }
}

fn cleanup_snapshot_for_transaction(
    path: &Path,
    transaction: &TransactionPaths,
) -> Result<StableSnapshot, FileServiceError> {
    snapshot_for_transaction(path, transaction, StableSnapshotMode::CleanupArtifact)
}

fn no_delete_snapshot_for_transaction(
    path: &Path,
    transaction: &TransactionPaths,
) -> Result<StableSnapshot, FileServiceError> {
    snapshot_for_transaction(path, transaction, StableSnapshotMode::NoDelete)
}

fn snapshot_for_transaction(
    path: &Path,
    transaction: &TransactionPaths,
    mode: StableSnapshotMode,
) -> Result<StableSnapshot, FileServiceError> {
    match open_stable_snapshot(path, mode) {
        Ok(snapshot) => Ok(snapshot),
        Err(source) if is_sharing_violation(&source) => Err(FileServiceError::ConcurrentWriter {
            artifacts: transaction.surviving(),
        }),
        Err(source) => Err(FileServiceError::ReplacementUncertain {
            artifacts: transaction.surviving(),
            source,
        }),
    }
}

fn classify_failure(transaction: &TransactionPaths, source: io::Error) -> FileServiceError {
    let mut stable_snapshots = Vec::new();
    for path in transaction.all() {
        match path.try_exists() {
            Ok(false) => continue,
            Ok(true) => {}
            Err(classification_error) => {
                return FileServiceError::ReplacementUncertain {
                    artifacts: transaction.surviving(),
                    source: classification_error,
                };
            }
        }
        match open_stable_snapshot(path, StableSnapshotMode::NoDelete) {
            Ok(snapshot) => stable_snapshots.push(snapshot),
            Err(error) if is_sharing_violation(&error) => {
                return FileServiceError::ConcurrentWriter {
                    artifacts: transaction.surviving(),
                };
            }
            Err(error) => {
                return FileServiceError::ReplacementUncertain {
                    artifacts: transaction.surviving(),
                    source: error,
                };
            }
        }
    }
    let artifacts = transaction.surviving();
    FileServiceError::ReplacementUncertain { artifacts, source }
}

fn replacement_race(transaction: &TransactionPaths) -> FileServiceError {
    FileServiceError::ReplacementRace {
        artifacts: transaction.surviving(),
    }
}

fn is_sharing_violation(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(32 | 33))
}
