use std::path::PathBuf;
use tauri::Manager;

/// 把 Windows verbatim 路径（`\\?\C:\...`）还原成普通路径。
///
/// Tauri v2 的 `path().resolve(BaseDirectory::Resource)` 内部走 `std::fs::canonicalize`，
/// 在 Windows 上产出带 `\\?\` 前缀的 verbatim 路径。这个前缀 **JVM 完全不认**：
///   - `java -jar \\?\...\apksigner.jar` → `ClassNotFoundException`（jar 根本没被打开）
///   - `--out \\?\...\x.apk`            → `java.io.IOException: Bad pathname`
/// 表现为 apksigner 数百毫秒内退出码 1，且不打印任何签名相关错误——极难从日志反推。
/// 因此所有交给子进程（尤其 JVM）的路径都必须先去掉这个前缀。
///
/// 注意 `\\?\UNC\server\share` 要还原成 `\\server\share`，不能简单截 4 个字符。
pub fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        // UNC：\\?\UNC\srv\share → \\srv\share
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest.to_string());
    }
    p
}

/// 定位随安装包分发的工具资源（jre / apksigner.jar / zipalign.exe）。
///
/// 生产环境 `BaseDirectory::Resource` 解析为安装目录下的 `resources/…`；
/// 开发环境解析为 `src-tauri/resources/…`，两种情形均由 `resource_file` 统一处理。
fn resource_file(app: &tauri::AppHandle, rel: &str) -> Option<PathBuf> {
    app.path()
        .resolve(&format!("resources/{rel}"), tauri::path::BaseDirectory::Resource)
        .ok()
        .map(strip_verbatim)
}

/// 带存在性校验的资源定位；再失败则回退到 exe 同级 `resources/`（绿色便携版）。
pub fn resource_file_checked(app: &tauri::AppHandle, rel: &str) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(p) = resource_file(app, rel) {
        candidates.push(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(strip_verbatim(dir.join("resources").join(rel)));
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

#[cfg(test)]
mod tests {
    use super::strip_verbatim;
    use std::path::PathBuf;

    #[test]
    fn strips_verbatim_drive_prefix() {
        let p = PathBuf::from(r"\\?\F:\AI\AndroidSignTool\src-tauri\resources\lib\apksigner.jar");
        assert_eq!(
            strip_verbatim(p),
            PathBuf::from(r"F:\AI\AndroidSignTool\src-tauri\resources\lib\apksigner.jar")
        );
    }

    #[test]
    fn keeps_plain_path_untouched() {
        let p = PathBuf::from(r"C:\keys\release.keystore");
        assert_eq!(strip_verbatim(p.clone()), p);
    }

    #[test]
    fn restores_unc_form() {
        let p = PathBuf::from(r"\\?\UNC\server\share\apksigner.jar");
        assert_eq!(strip_verbatim(p), PathBuf::from(r"\\server\share\apksigner.jar"));
    }

    #[test]
    fn handles_relative_and_empty() {
        assert_eq!(strip_verbatim(PathBuf::from("resources")), PathBuf::from("resources"));
        assert_eq!(strip_verbatim(PathBuf::from("")), PathBuf::from(""));
    }
}
