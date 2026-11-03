use std::path::PathBuf;
use tauri::Manager;

/// 定位随安装包分发的工具资源（jre / apksigner.jar / zipalign.exe）。
///
/// 生产环境 `BaseDirectory::Resource` 解析为安装目录下的 `resources/…`；
/// 开发环境解析为 `src-tauri/resources/…`，两种情形均由 `resource_file` 统一处理。
fn resource_file(app: &tauri::AppHandle, rel: &str) -> Option<PathBuf> {
    app.path()
        .resolve(&format!("resources/{rel}"), tauri::path::BaseDirectory::Resource)
        .ok()
}

/// 带存在性校验的资源定位；再失败则回退到 exe 同级 `resources/`（绿色便携版）。
pub fn resource_file_checked(app: &tauri::AppHandle, rel: &str) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(p) = resource_file(app, rel) {
        candidates.push(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("resources").join(rel));
        }
    }
    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }
    Err(format!(
        "未找到内置工具 {rel}。开发环境请先执行 npm run prepare:tools 生成 src-tauri/resources 下的工具集"
    ))
}

pub fn java_exe(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    resource_file_checked(app, "jre/bin/java.exe")
}

pub fn keytool_exe(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    resource_file_checked(app, "jre/bin/keytool.exe")
}

pub fn apksigner_jar(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    resource_file_checked(app, "lib/apksigner.jar")
}

pub fn zipalign_exe(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    resource_file_checked(app, "zipalign.exe")
}
