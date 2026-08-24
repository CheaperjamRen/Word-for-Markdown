use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolveTargetRequest {
    #[serde(rename = "basePath")]
    pub base_path: String,
    pub href: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind")]
pub enum ResolvedTarget {
    #[serde(rename = "anchor")]
    Anchor {
        #[serde(rename = "headingId")]
        heading_id: String,
    },
    #[serde(rename = "web")]
    Web { url: String },
    #[serde(rename = "markdown")]
    Markdown {
        #[serde(rename = "canonicalPath")]
        canonical_path: String,
    },
    #[serde(rename = "preview")]
    Preview {
        #[serde(rename = "canonicalPath")]
        canonical_path: String,
        #[serde(rename = "mediaType")]
        media_type: String,
    },
    #[serde(rename = "directory")]
    Directory {
        #[serde(rename = "canonicalPath")]
        canonical_path: String,
    },
    #[serde(rename = "system")]
    System {
        #[serde(rename = "canonicalPath")]
        canonical_path: String,
    },
    #[serde(rename = "dangerous")]
    Dangerous {
        #[serde(rename = "canonicalPath")]
        canonical_path: String,
        reason: String,
    },
    #[serde(rename = "blocked")]
    Blocked { reason: String },
}

fn path_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

fn dangerous_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("exe" | "cmd" | "bat" | "ps1" | "js" | "vbs" | "lnk")
    )
}

fn media_type(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg") => Some("image"),
        Some("pdf") => Some("pdf"),
        _ => None,
    }
}

fn percent_decode_path(value: &str) -> String {
    fn hex(value: u8) -> Option<u8> {
        match value {
            b'0'..=b'9' => Some(value - b'0'),
            b'a'..=b'f' => Some(value - b'a' + 10),
            b'A'..=b'F' => Some(value - b'A' + 10),
            _ => None,
        }
    }

    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut changed = false;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                decoded.push((high << 4) | low);
                index += 3;
                changed = true;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    if !changed {
        return value.to_string();
    }
    String::from_utf8(decoded).unwrap_or_else(|_| value.to_string())
}

pub fn resolve_target(request: ResolveTargetRequest) -> ResolvedTarget {
    let href = request.href.trim();
    if href.is_empty() {
        return ResolvedTarget::Blocked {
            reason: "链接为空".into(),
        };
    }
    if let Some(fragment) = href.strip_prefix('#') {
        return if fragment.is_empty() {
            ResolvedTarget::Blocked {
                reason: "锚点为空".into(),
            }
        } else {
            ResolvedTarget::Anchor {
                heading_id: fragment.to_string(),
            }
        };
    }
    if href.starts_with("http://") || href.starts_with("https://") || href.starts_with("mailto:") {
        return ResolvedTarget::Web {
            url: href.to_string(),
        };
    }
    let lowered = href.to_ascii_lowercase();
    if lowered.starts_with("javascript:")
        || lowered.starts_with("data:")
        || lowered.starts_with("vbscript:")
        || lowered.starts_with("file:")
    {
        return ResolvedTarget::Blocked {
            reason: "不允许打开此链接".into(),
        };
    }
    let (raw_path, fragment) = href
        .split_once('#')
        .map_or((href, None), |(path, fragment)| (path, Some(fragment)));
    if raw_path.is_empty() {
        return fragment.filter(|value| !value.is_empty()).map_or(
            ResolvedTarget::Blocked {
                reason: "锚点为空".into(),
            },
            |value| ResolvedTarget::Anchor {
                heading_id: value.to_string(),
            },
        );
    }
    let raw_path = raw_path.split_once('?').map_or(raw_path, |(path, _)| path);
    let raw_path = percent_decode_path(raw_path);
    let requested = PathBuf::from(raw_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    let requested_is_absolute = requested.is_absolute();
    let joined = if requested_is_absolute {
        requested.clone()
    } else {
        Path::new(&request.base_path)
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(&requested)
    };
    let mut candidates = vec![joined];
    // A few Markdown knowledge bases are authored from their project root but
    // later moved into the directory they name (for example
    // `知识手册/知识手册/节点.md`). Keep normal relative resolution first, then
    // accept that narrow, deterministic duplicate-directory spelling when the
    // primary target is absent. Do not fuzzy-search or guess arbitrary files.
    if !requested_is_absolute {
        let parent = Path::new(&request.base_path).parent();
        let first_component = requested.components().find_map(|component| {
            if let std::path::Component::Normal(value) = component {
                Some(value)
            } else {
                None
            }
        });
        let parent_name = parent.and_then(Path::file_name);
        let duplicate_directory = match (first_component, parent_name) {
            (Some(first), Some(parent_name)) => first
                .to_string_lossy()
                .eq_ignore_ascii_case(&parent_name.to_string_lossy()),
            _ => false,
        };
        if duplicate_directory {
            if let Some(project_root) = parent.and_then(Path::parent) {
                candidates.push(project_root.join(&requested));
            }
        }
    }
    let canonical = match candidates
        .into_iter()
        .find_map(|candidate| candidate.canonicalize().ok())
    {
        Some(path) => path,
        None => {
            return ResolvedTarget::Blocked {
                reason: "目标不存在".into(),
            }
        }
    };
    let canonical_path = path_string(canonical.clone());
    let metadata = match fs::metadata(&canonical) {
        Ok(value) => value,
        Err(_) => {
            return ResolvedTarget::Blocked {
                reason: "无法读取目标".into(),
            }
        }
    };
    if metadata.is_dir() {
        return ResolvedTarget::Directory { canonical_path };
    }
    if dangerous_extension(&canonical)
        || (canonical_path.starts_with("\\\\") && !canonical_path.starts_with("\\\\?\\"))
    {
        return ResolvedTarget::Dangerous {
            canonical_path,
            reason: "此文件可能执行程序或访问网络位置".into(),
        };
    }
    if canonical
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("md") || value.eq_ignore_ascii_case("markdown")
        })
    {
        return ResolvedTarget::Markdown { canonical_path };
    }
    if let Some(media_type) = media_type(&canonical) {
        return ResolvedTarget::Preview {
            canonical_path,
            media_type: media_type.into(),
        };
    }
    ResolvedTarget::System { canonical_path }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn resolves_local_markdown_and_rejects_executable() {
        let dir = tempdir().unwrap();
        let base = dir.path().join("note.md");
        let markdown = dir.path().join("next.md");
        let script = dir.path().join("run.ps1");
        fs::write(&base, "# note").unwrap();
        fs::write(&markdown, "# next").unwrap();
        fs::write(&script, "Write-Host nope").unwrap();
        let markdown_target = resolve_target(ResolveTargetRequest {
            base_path: base.to_string_lossy().into(),
            href: "./next.md".into(),
        });
        let script_target = resolve_target(ResolveTargetRequest {
            base_path: base.to_string_lossy().into(),
            href: "./run.ps1".into(),
        });
        assert!(matches!(markdown_target, ResolvedTarget::Markdown { .. }));
        assert!(matches!(script_target, ResolvedTarget::Dangerous { .. }));
    }

    #[test]
    fn accepts_a_duplicate_current_directory_prefix_without_fuzzy_search() {
        let root = tempdir().unwrap();
        let handbook = root.path().join("知识手册");
        fs::create_dir_all(&handbook).unwrap();
        let base = handbook.join("目录与面经覆盖检查.md");
        let target = handbook.join("AI产品岗位知识手册-V2-总纲.md");
        fs::write(&base, "# base").unwrap();
        fs::write(&target, "# target").unwrap();

        let resolved = resolve_target(ResolveTargetRequest {
            base_path: base.to_string_lossy().into(),
            href: "./知识手册/AI产品岗位知识手册-V2-总纲.md".into(),
        });

        assert!(matches!(resolved, ResolvedTarget::Markdown { .. }));

        let encoded = resolve_target(ResolveTargetRequest {
            base_path: base.to_string_lossy().into(),
            href: "./%E7%9F%A5%E8%AF%86%E6%89%8B%E5%86%8C/AI%E4%BA%A7%E5%93%81%E5%B2%97%E4%BD%8D%E7%9F%A5%E8%AF%86%E6%89%8B%E5%86%8C-V2-%E6%80%BB%E7%BA%B2.md".into(),
        });
        assert!(matches!(encoded, ResolvedTarget::Markdown { .. }));
    }
}
