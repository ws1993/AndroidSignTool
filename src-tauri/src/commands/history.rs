use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::store::history_db::{self, Record};

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建应用数据目录: {e}"))?;
    Ok(dir.join("history.db"))
}

fn conn(app: &AppHandle) -> Result<rusqlite::Connection, String> {
    history_db::open(&db_path(app)?)
}

#[tauri::command]
pub fn history_list(app: AppHandle, limit: Option<i64>) -> Result<Vec<Record>, String> {
    let c = conn(&app)?;
    history_db::list(&c, limit.unwrap_or(500).clamp(1, 5000))
}

#[tauri::command]
pub fn history_clear(app: AppHandle) -> Result<(), String> {
    let c = conn(&app)?;
    history_db::clear(&c)
}

/// 导出 CSV 到前端选定路径（不含任何密码字段）
#[tauri::command]
pub fn history_export(app: AppHandle, path: String) -> Result<usize, String> {
    let target = path.trim();
    if target.is_empty() {
        return Err("未选择导出路径".to_string());
    }
    let c = conn(&app)?;
    history_db::export_csv(&c, std::path::Path::new(target))
}

/// 前端展示存储位置用
#[tauri::command]
pub fn data_paths(app: AppHandle) -> Result<DataPaths, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    Ok(DataPaths {
        data_dir: dir.display().to_string(),
        profiles: dir.join("profiles.json").display().to_string(),
        history: dir.join("history.db").display().to_string(),
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataPaths {
    pub data_dir: String,
    pub profiles: String,
    pub history: String,
}
