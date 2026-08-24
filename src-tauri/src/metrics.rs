use serde::{Deserialize, Serialize};
use std::{
    fs::OpenOptions,
    io::{self, Write},
    path::Path,
    time::Instant,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UiContractSnapshot {
    pub ui_font_size: String,
    pub status_font_size: String,
    pub document_font_size: String,
    pub document_line_height: String,
    pub toolbar_icon_width: String,
    pub icon_button_height: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordFirstReadablePaintRequest {
    pub path: String,
    pub application_network_requests: u32,
    pub ui_contract: UiContractSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PaintMetric<'a> {
    path: &'a str,
    first_readable_paint_ms: u64,
    application_network_requests: u32,
    ui_contract: UiContractSnapshot,
}

pub(crate) struct AppClock {
    started_at: Instant,
}

impl AppClock {
    pub(crate) fn new() -> Self {
        Self {
            started_at: Instant::now(),
        }
    }

    pub(crate) fn record(
        &self,
        path: &str,
        application_network_requests: u32,
        ui_contract: UiContractSnapshot,
        metrics_path: Option<&Path>,
    ) -> io::Result<u64> {
        let elapsed_ms = self.started_at.elapsed().as_millis().min(u64::MAX as u128) as u64;

        if let Some(metrics_path) = metrics_path {
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(metrics_path)?;
            let metric = PaintMetric {
                path,
                first_readable_paint_ms: elapsed_ms,
                application_network_requests,
                ui_contract,
            };
            serde_json::to_writer(&mut file, &metric).map_err(io::Error::other)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
        }

        Ok(elapsed_ms)
    }
}

#[cfg(test)]
impl UiContractSnapshot {
    fn expected_for_test() -> Self {
        Self {
            ui_font_size: "12px".into(),
            status_font_size: "11px".into(),
            document_font_size: "16px".into(),
            document_line_height: "28px".into(),
            toolbar_icon_width: "20px".into(),
            icon_button_height: "32px".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AppClock, UiContractSnapshot};
    use std::{fs, time::Instant};
    use tempfile::tempdir;

    #[test]
    fn appends_runtime_ui_contract_to_an_injected_jsonl_path() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("paint.jsonl");
        let clock = AppClock {
            started_at: Instant::now(),
        };
        let ui = UiContractSnapshot::expected_for_test();

        clock
            .record("C:\\docs\\a.md", 0, ui.clone(), Some(&path))
            .unwrap();
        clock.record("C:\\docs\\b.md", 0, ui, Some(&path)).unwrap();

        let lines: Vec<serde_json::Value> = fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["uiContract"]["uiFontSize"], "12px");
        assert_eq!(lines[0]["uiContract"]["toolbarIconWidth"], "20px");
    }

    #[test]
    fn actual_ui_contract_wire_type_rejects_unknown_fields() {
        let wire: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/contracts/desktop-wire.json"))
                .unwrap();
        let mut ui = wire["paintInvoke"]["request"]["uiContract"].clone();
        ui["unexpected"] = serde_json::json!("16px");
        assert!(serde_json::from_value::<UiContractSnapshot>(ui).is_err());
    }
}
