use crate::lifecycle::{
    deserialize_required_option, open_document_at, DesktopFailure, DesktopFailureCode,
};
use notify::{
    event::{ModifyKind, RenameMode},
    Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileChangedKind {
    Content,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileChangedEvent {
    pub watch_id: String,
    pub canonical_path: String,
    pub kind: FileChangedKind,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub new_canonical_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchDocumentResult {
    pub watch_id: String,
    pub canonical_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchDocumentRequest {
    pub canonical_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnwatchDocumentRequest {
    pub watch_id: String,
}

struct ActiveWatch {
    watcher: RecommendedWatcher,
    parent: PathBuf,
    active: Arc<Mutex<bool>>,
}

pub struct WatchRegistry {
    active: HashMap<String, ActiveWatch>,
}

pub struct EventClassifier {
    watch_id: String,
    watched: PathBuf,
    pending_rename_from: Option<PathBuf>,
}

impl EventClassifier {
    pub fn new(watch_id: impl Into<String>, watched: PathBuf) -> Self {
        Self {
            watch_id: watch_id.into(),
            watched,
            pending_rename_from: None,
        }
    }

    pub fn classify(&mut self, event: &Event) -> Vec<FileChangedEvent> {
        match event.kind {
            EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
                self.pending_rename_from = event
                    .paths
                    .iter()
                    .find(|path| same_path(path, &self.watched))
                    .cloned();
                vec![]
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
                let Some(from) = self.pending_rename_from.take() else {
                    return vec![];
                };
                let Some(to) = event.paths.first() else {
                    return vec![];
                };
                if !same_path(&from, &self.watched) {
                    return vec![];
                }
                if is_internal_replaced_backup(&self.watched, to) {
                    return vec![FileChangedEvent {
                        watch_id: self.watch_id.clone(),
                        canonical_path: self.watched.to_string_lossy().into_owned(),
                        kind: FileChangedKind::Content,
                        new_canonical_path: None,
                    }];
                }
                vec![FileChangedEvent {
                    watch_id: self.watch_id.clone(),
                    canonical_path: self.watched.to_string_lossy().into_owned(),
                    kind: FileChangedKind::Renamed,
                    new_canonical_path: Some(display_path(to)),
                }]
            }
            _ => {
                self.pending_rename_from = None;
                classify_event(&self.watch_id, &self.watched, event)
            }
        }
    }
}

impl WatchRegistry {
    pub fn new() -> Self {
        Self {
            active: HashMap::new(),
        }
    }

    pub fn watch(
        &mut self,
        path: &Path,
        listener: impl Fn(FileChangedEvent) + Send + Sync + 'static,
    ) -> Result<WatchDocumentResult, DesktopFailure> {
        let opened = open_document_at(path).map_err(|mut failure| {
            failure.code = DesktopFailureCode::WatchFailed;
            failure
        })?;
        let canonical = PathBuf::from(&opened.canonical_path);
        let parent = canonical
            .parent()
            .ok_or_else(|| watch_failed(path))?
            .to_path_buf();
        let watch_id = Uuid::new_v4().to_string();
        let callback_id = watch_id.clone();
        let callback_path = canonical.clone();
        let classifier = Arc::new(Mutex::new(EventClassifier::new(callback_id, callback_path)));
        let callback_classifier = Arc::clone(&classifier);
        let listener = Arc::new(listener);
        let active = Arc::new(Mutex::new(true));
        let callback_active = Arc::clone(&active);
        let mut watcher = RecommendedWatcher::new(
            move |result: notify::Result<Event>| {
                let Ok(event) = result else {
                    return;
                };
                let Ok(active) = callback_active.lock() else {
                    return;
                };
                if !*active {
                    return;
                }
                let Ok(mut classifier) = callback_classifier.lock() else {
                    return;
                };
                for fact in classifier.classify(&event) {
                    listener(fact);
                }
            },
            Config::default(),
        )
        .map_err(|_| watch_failed(&canonical))?;
        watcher
            .watch(&parent, RecursiveMode::NonRecursive)
            .map_err(|_| watch_failed(&canonical))?;
        self.active.insert(
            watch_id.clone(),
            ActiveWatch {
                watcher,
                parent,
                active,
            },
        );
        Ok(WatchDocumentResult {
            watch_id,
            canonical_path: opened.canonical_path,
        })
    }

    pub fn unwatch(&mut self, watch_id: &str) -> Result<(), DesktopFailure> {
        let Some(mut active) = self.active.remove(watch_id) else {
            return Ok(());
        };
        *active
            .active
            .lock()
            .map_err(|_| watch_failed(&active.parent))? = false;
        active
            .watcher
            .unwatch(&active.parent)
            .map_err(|_| watch_failed(&active.parent))
    }
}

impl Default for WatchRegistry {
    fn default() -> Self {
        Self::new()
    }
}

pub fn classify_event(watch_id: &str, watched: &Path, event: &Event) -> Vec<FileChangedEvent> {
    let canonical_path = watched.to_string_lossy().into_owned();
    if let EventKind::Modify(ModifyKind::Name(RenameMode::Both)) = event.kind {
        if event.paths.len() >= 2 && same_path(&event.paths[0], watched) {
            if is_internal_replaced_backup(watched, &event.paths[1]) {
                return vec![FileChangedEvent {
                    watch_id: watch_id.to_owned(),
                    canonical_path,
                    kind: FileChangedKind::Content,
                    new_canonical_path: None,
                }];
            }
            return vec![FileChangedEvent {
                watch_id: watch_id.to_owned(),
                canonical_path,
                kind: FileChangedKind::Renamed,
                new_canonical_path: Some(display_path(&event.paths[1])),
            }];
        }
        return vec![];
    }

    if !event.paths.iter().any(|path| same_path(path, watched)) {
        return vec![];
    }
    let kind = match event.kind {
        EventKind::Remove(_) => FileChangedKind::Deleted,
        EventKind::Modify(ModifyKind::Name(_)) => return vec![],
        EventKind::Modify(_) | EventKind::Create(_) => FileChangedKind::Content,
        _ => return vec![],
    };
    vec![FileChangedEvent {
        watch_id: watch_id.to_owned(),
        canonical_path,
        kind,
        new_canonical_path: None,
    }]
}

fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn is_internal_replaced_backup(watched: &Path, renamed: &Path) -> bool {
    let (Some(watched_parent), Some(renamed_parent), Some(file_name)) = (
        watched.parent(),
        renamed.parent(),
        renamed.file_name().and_then(|name| name.to_str()),
    ) else {
        return false;
    };
    if !same_path(watched_parent, renamed_parent) {
        return false;
    }
    let Some(id) = file_name
        .strip_prefix(".markdown-spike-")
        .and_then(|value| value.strip_suffix(".replaced-backup"))
    else {
        return false;
    };
    id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn display_path(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn watch_failed(path: &Path) -> DesktopFailure {
    DesktopFailure::new(DesktopFailureCode::WatchFailed).with_affected(path)
}
