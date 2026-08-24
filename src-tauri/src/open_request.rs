use serde::Deserialize;
use std::{
    collections::HashSet,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub fn collect_markdown_paths<I, S>(args: I, cwd: &Path) -> Vec<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut seen = HashSet::new();
    args.into_iter()
        .skip(1)
        .filter_map(|value| {
            let raw = PathBuf::from(value.into());
            if raw.as_os_str().to_string_lossy().starts_with('-') {
                return None;
            }
            let candidate = if raw.is_absolute() {
                raw
            } else {
                cwd.join(raw)
            };
            let extension = candidate
                .extension()?
                .to_string_lossy()
                .to_ascii_lowercase();
            if extension != "md" && extension != "markdown" {
                return None;
            }
            let canonical = candidate.canonicalize().ok()?;
            if !canonical.is_file() || !seen.insert(canonical.clone()) {
                return None;
            }
            Some(canonical)
        })
        .collect()
}

#[derive(Default)]
pub struct PendingOpenRequests(Mutex<Vec<String>>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeOpenRequestsRequest {}

impl PendingOpenRequests {
    pub fn new(initial: Vec<String>) -> Self {
        Self(Mutex::new(initial))
    }

    pub fn push(&self, paths: Vec<String>) {
        self.0
            .lock()
            .expect("pending open requests poisoned")
            .extend(paths);
    }

    pub fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.lock().expect("pending open requests poisoned"))
    }
}

pub const OPEN_DOCUMENT_REQUESTS_EVENT: &str = "open-document-requests";

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn accepts_existing_md_and_markdown_files_only_once() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("报告.md");
        let second = dir.path().join("notes.markdown");
        fs::write(&first, "# 报告").unwrap();
        fs::write(&second, "notes").unwrap();
        let args: Vec<String> = vec![
            "app.exe".into(),
            first.to_string_lossy().into_owned(),
            second.to_string_lossy().into_owned(),
            first.to_string_lossy().into_owned(),
        ];

        let result = collect_markdown_paths(args, dir.path());

        assert_eq!(
            result,
            vec![
                first.canonicalize().unwrap(),
                second.canonicalize().unwrap()
            ]
        );
    }

    #[test]
    fn rejects_flags_directories_missing_files_and_non_markdown() {
        let dir = tempdir().unwrap();
        let text = dir.path().join("notes.txt");
        fs::write(&text, "notes").unwrap();
        let args: Vec<String> = vec![
            "app.exe".into(),
            "--inspect".into(),
            dir.path().to_string_lossy().into_owned(),
            text.to_string_lossy().into_owned(),
            "missing.md".into(),
        ];

        assert!(collect_markdown_paths(args, dir.path()).is_empty());
    }

    #[test]
    fn pending_queue_delivers_each_path_once() {
        let pending = PendingOpenRequests::new(vec!["C:\\docs\\first.md".into()]);
        pending.push(vec!["C:\\docs\\second.md".into()]);

        assert_eq!(
            pending.take(),
            vec!["C:\\docs\\first.md", "C:\\docs\\second.md"]
        );
        assert!(pending.take().is_empty());
    }

    #[test]
    fn empty_take_request_accepts_fixture_and_rejects_unknown_fields() {
        let wire: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/contracts/desktop-wire.json"))
                .unwrap();
        let request = wire["takeOpenRequestsInvoke"]["request"].clone();
        serde_json::from_value::<TakeOpenRequestsRequest>(request.clone()).unwrap();

        let mut unknown = request;
        unknown["unexpected"] = serde_json::json!(true);
        assert!(serde_json::from_value::<TakeOpenRequestsRequest>(unknown).is_err());
    }
}
