use serde::Deserialize;
use std::path::Path;
use tauri::{AppHandle, Manager};

use crate::engine::keytool;
use crate::store::profile_store::{self, NewProfileInput, ProfileMeta};
use crate::tool_paths;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProfileReq {
    pub name: String,
    pub keystore_path: String,
    pub alias: String,
    pub store_pass: String,
    #[serde(default)]
    pub key_pass: Option<String>,
    pub strategy: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasesResult {
    pub aliases: Vec<String>,
}

#[tauri::command]
pub fn list_profiles(app: AppHandle) -> Result<Vec<ProfileMeta>, String> {
    let file = profile_store::load(&app)?;
    Ok(profile_store::metas(&file))
}

/// 返回单条配置的脱敏信息（永不返回密码）
#[tauri::command]
pub fn get_profile(app: AppHandle, id: u64) -> Result<ProfileMeta, String> {
    let file = profile_store::load(&app)?;
    file.profiles
        .iter()
        .find(|p| p.id == id)
        .map(ProfileMeta::from)
        .ok_or_else(|| "签名配置不存在".to_string())
}

/// 校验 keystore 密码并列出其中的别名（用于前端 alias 下拉）
#[tauri::command]
pub fn probe_keystore(
    app: AppHandle,
    keystore_path: String,
    store_pass: String,
) -> Result<AliasesResult, String> {
    let ks = keystore_path.trim();
    if ks.is_empty() {
        return Err("请先选择签名文件".to_string());
    }
    if !Path::new(ks).is_file() {
        return Err(format!("签名文件不存在：{ks}"));
    }
    if store_pass.is_empty() {
        return Err("请填写密钥库密码".to_string());
    }
    let keytool_bin = tool_paths::keytool_exe(&app)?;
    let cache = crate::tool_paths::strip_verbatim(
        app.path()
            .app_cache_dir()
            .map_err(|e| format!("无法定位缓存目录: {e}"))?,
    );
    std::fs::create_dir_all(&cache).map_err(|e| format!("创建缓存目录失败: {e}"))?;

    let aliases = keytool::list_aliases(&keytool_bin, Path::new(ks), &store_pass, &cache, &mut |_| {})?;
    if aliases.is_empty() {
        return Err("该签名文件中没有私钥条目（PrivateKeyEntry）".to_string());
    }
    Ok(AliasesResult { aliases })
}

/// 新建/覆盖一条签名配置。落盘前用 keytool -list 验证密码，避免存入不可用配置。
#[tauri::command]
pub fn save_profile(app: AppHandle, req: SaveProfileReq) -> Result<ProfileMeta, String> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err("配置名称不能为空".to_string());
    }
    let ks = req.keystore_path.trim().to_string();
    if ks.is_empty() || !Path::new(&ks).is_file() {
        return Err("签名文件不存在，请重新选择".to_string());
    }
    let alias = req.alias.trim().to_string();
    if alias.is_empty() {
        return Err("密钥别名 alias 不能为空".to_string());
    }
    if req.store_pass.is_empty() {
        return Err("密钥库密码不能为空".to_string());
    }
    let key_pass = if req.key_pass.as_deref().unwrap_or("").is_empty() {
        req.store_pass.clone()
    } else {
        req.key_pass.clone().unwrap()
    };

    // 验证：密钥库密码可用 + alias 确实存在
    let keytool_bin = tool_paths::keytool_exe(&app)?;
    let cache = crate::tool_paths::strip_verbatim(
        app.path()
            .app_cache_dir()
            .map_err(|e| format!("无法定位缓存目录: {e}"))?,
    );
    std::fs::create_dir_all(&cache).map_err(|e| format!("创建缓存目录失败: {e}"))?;
    let aliases = keytool::list_aliases(&keytool_bin, Path::new(&ks), &req.store_pass, &cache, &mut |_| {})?;
    if !aliases.iter().any(|a| a == &alias) {
        return Err(format!(
            "别名「{alias}」不在该签名文件中。可用别名：{}",
            if aliases.is_empty() {
                "（无私钥条目）".to_string()
            } else {
                aliases.join(", ")
            }
        ));
    }

    let strategy = if req.strategy.trim().is_empty() {
        "v2_with_v1".to_string()
    } else {
        req.strategy.clone()
    };
    profile_store::upsert(
        &app,
        NewProfileInput {
            name,
            keystore_path: ks,
            alias,
            store_pass: req.store_pass,
            key_pass,
            strategy,
        },
    )
}

#[tauri::command]
pub fn delete_profile(app: AppHandle, id: u64) -> Result<(), String> {
    profile_store::delete(&app, id)
}
