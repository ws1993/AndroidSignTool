use serde::Serialize;
use std::path::Path;
use tauri::AppHandle;

use crate::engine::{apksigner, axml};
use crate::tool_paths;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApkInfo {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub package: Option<String>,
    pub version_code: Option<String>,
    pub version_name: Option<String>,
    pub min_sdk: Option<String>,
    pub target_sdk: Option<String>,
    pub max_sdk: Option<String>,
    /// apksigner verify 是否通过（已签名且验签成功）
    pub verified: bool,
    /// 已生效的签名方案，例如 ["V1","V2"]
    pub schemes: Vec<String>,
    pub cert_dn: Option<String>,
    pub cert_sha256: Option<String>,
    pub signer_count: Option<String>,
    /// 原始 verify -v 输出，供前端折叠展示
    pub verify_output: Vec<String>,
    pub error: Option<String>,
}

fn pick(lines: &[String], needle: &str) -> Option<String> {
    lines
        .iter()
        .find(|l| l.contains(needle))
        .map(|l| l.splitn(2, ':').nth(1).unwrap_or("").trim().to_string())
        .filter(|s| !s.is_empty())
}

fn parse_schemes(lines: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for (tag, label) in [
        ("Verified using v1 scheme", "V1"),
        ("Verified using v2 scheme", "V2"),
        ("Verified using v3.1 scheme", "V3.1"),
        ("Verified using v3 scheme", "V3"),
        ("Verified using v4 scheme", "V4"),
    ] {
        if let Some(l) = lines.iter().find(|l| l.contains(tag)) {
            if l.trim_end().ends_with(": true") {
                out.push(label.to_string());
            }
        }
    }
    out
}

#[tauri::command]
pub fn apk_info(app: AppHandle, apk_path: String) -> ApkInfo {
    let path = apk_path.trim().to_string();
    let p = Path::new(&path);
    let file_name = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    let base = ApkInfo {
        path: path.clone(),
        file_name,
        size_bytes: 0,
        package: None,
        version_code: None,
        version_name: None,
        min_sdk: None,
        target_sdk: None,
        max_sdk: None,
        verified: false,
        schemes: Vec::new(),
        cert_dn: None,
        cert_sha256: None,
        signer_count: None,
        verify_output: Vec::new(),
        error: None,
    };

    if !p.is_file() {
        return ApkInfo {
            error: Some(format!("文件不存在：{path}")),
            ..base
        };
    }
    let mut info = base;
    info.size_bytes = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);

    // 1) AndroidManifest.xml（AXML）→ 包名 / 版本 / SDK
    match axml::read_manifest_from_zip(p) {
        Ok(m) => {
            info.package = m.package;
            info.version_code = m.version_code;
            info.version_name = m.version_name;
            info.min_sdk = m.min_sdk;
            info.target_sdk = m.target_sdk;
        }
        Err(e) => info.error = Some(format!("Manifest 解析失败: {e}")),
    }

    // 2) apksigner verify -v → 现有签名方案与证书
    match (|| -> Result<Vec<String>, String> {
        let java = tool_paths::java_exe(&app)?;
        let jar = tool_paths::apksigner_jar(&app)?;
        Ok(apksigner::inspect(&java, &jar, p)?)
    })() {
        Ok(lines) => {
            info.schemes = parse_schemes(&lines);
            info.verified = !info.schemes.is_empty();
            info.cert_dn = pick(&lines, "certificate DN:");
            info.cert_sha256 = pick(&lines, "certificate SHA-256 digest:");
            info.signer_count = pick(&lines, "Number of signers:");
            info.verify_output = lines;
        }
        Err(e) => {
            // 未签名的 APK：apksigner verify 以非 0 退出，不当作致命错误
            info.verify_output = vec![e.clone()];
        }
    }

    info
}
