use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

use crate::engine::keytool::{self, KeyGenReq};
use crate::store::profile_store;
use crate::tool_paths;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateKeystoreReq {
    /// 前端任务标识，日志事件按此归组
    pub task_id: String,
    pub keystore_path: String,
    pub alias: String,
    pub store_pass: String,
    #[serde(default)]
    pub key_pass: Option<String>,
    #[serde(default)]
    pub validity_days: Option<u32>,
    #[serde(default)]
    pub key_size: Option<u32>,
    pub common_name: String,
    #[serde(default)]
    pub org_unit: String,
    #[serde(default)]
    pub org: String,
    #[serde(default)]
    pub city: String,
    #[serde(default)]
    pub state: String,
    pub country: String,
    /// 生成后顺带写入签名配置（可选）
    #[serde(default)]
    pub save_profile_name: Option<String>,
    #[serde(default)]
    pub strategy: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateResult {
    pub ok: bool,
    pub keystore_path: Option<String>,
    pub error: Option<String>,
    pub profile_saved: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogLine<'a> {
    task_id: &'a str,
    line: &'a str,
}

fn log(app: &AppHandle, task_id: &str, line: &str) {
    let _ = app.emit(
        "sign-log",
        LogLine { task_id, line },
    );
}

#[tauri::command]
pub fn generate_keystore(app: AppHandle, req: GenerateKeystoreReq) -> GenerateResult {
    let outcome = do_generate(&app, &req);
    match &outcome {
        Ok(path) => GenerateResult {
            ok: true,
            keystore_path: Some(path.display().to_string()),
            error: None,
            profile_saved: req.save_profile_name.is_some(),
        },
        Err(e) => {
            log(&app, &req.task_id, &format!("[错误] {e}"));
            GenerateResult {
                ok: false,
                keystore_path: None,
                error: Some(e.clone()),
                profile_saved: false,
            }
        }
    }
}

fn do_generate(app: &AppHandle, req: &GenerateKeystoreReq) -> Result<PathBuf, String> {
    let ks = req.keystore_path.trim().to_string();
    if ks.is_empty() {
        return Err("请选择要生成的签名文件路径".to_string());
    }
    let ks_path = PathBuf::from(&ks);
    if let Some(parent) = ks_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }

    let alias = req.alias.trim().to_string();
    if alias.is_empty() {
        return Err("密钥别名 alias 不能为空".to_string());
    }
    if req.store_pass.is_empty() {
        return Err("密钥库密码不能为空".to_string());
    }
    if req.store_pass.len() < 6 {
        return Err("密钥库密码至少 6 位（keytool 强制要求）".to_string());
    }
    let key_pass = if req.key_pass.as_deref().unwrap_or("").is_empty() {
        req.store_pass.clone()
    } else {
        req.key_pass.clone().unwrap()
    };

    let keytool_bin = tool_paths::keytool_exe(app)?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("无法定位缓存目录: {e}"))?;
    std::fs::create_dir_all(&cache).map_err(|e| format!("创建缓存目录失败: {e}"))?;

    let mut emit = |line: &str| log(app, &req.task_id, line);

    let gen_req = KeyGenReq {
        keystore_path: ks_path.clone(),
        alias: alias.clone(),
        store_pass: req.store_pass.clone(),
        key_pass: key_pass.clone(),
        validity_days: req.validity_days.unwrap_or(9125).max(1),
        key_size: match req.key_size.unwrap_or(2048) {
            4096 => 4096,
            _ => 2048,
        },
        common_name: req.common_name.clone(),
        org_unit: req.org_unit.clone(),
        org: req.org.clone(),
        city: req.city.clone(),
        state: req.state.clone(),
        country: req.country.clone(),
        tmp_dir: cache.clone(),
    };
    keytool::generate(&keytool_bin, &gen_req, &mut emit)?;

    // 生成后立即自检：确认 alias 可读
    let aliases = keytool::list_aliases(&keytool_bin, &ks_path, &req.store_pass, &cache, &mut |_| {})?;
    if !aliases.iter().any(|a| *a == alias) {
        return Err(format!(
            "keystore 已生成但别名校验失败，实际别名：{}",
            aliases.join(", ")
        ));
    }
    emit(&format!("[自检] 别名 {alias} 校验通过 ✓"));

    // 顺带保存为签名配置
    if let Some(name) = req
        .save_profile_name
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        let meta = profile_store::upsert(
            app,
            profile_store::NewProfileInput {
                name: name.clone(),
                keystore_path: ks.clone(),
                alias: alias.clone(),
                store_pass: req.store_pass.clone(),
                key_pass: key_pass.clone(),
                strategy: req
                    .strategy
                    .clone()
                    .unwrap_or_else(|| "v2_with_v1".to_string()),
            },
        )?;
        emit(&format!("[配置] 已保存签名配置「{}」", meta.name));
    }

    Ok(ks_path)
}

/// 供前端做「别名是否已存在」提示：读取已有 keystore 的别名列表
#[tauri::command]
pub fn keystore_exists(path: String) -> bool {
    Path::new(path.trim()).is_file()
}
