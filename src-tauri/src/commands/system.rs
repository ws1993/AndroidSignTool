use std::path::Path;
use std::process::Command;

/// 在资源管理器中打开目录；传入文件时选中该文件。
/// 只接受本机已存在的路径，不接受任意 URL，避免前端误用。
#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("路径为空".to_string());
    }
    let target = Path::new(p);
    if !target.exists() {
        return Err(format!("路径不存在：{p}"));
    }
    let arg = if target.is_dir() {
        p.to_string()
    } else {
        format!("/select,{p}")
    };
    Command::new("explorer.exe")
        .arg(arg)
        .spawn()
        .map_err(|e| format!("打开资源管理器失败: {e}"))?;
    Ok(())
}
