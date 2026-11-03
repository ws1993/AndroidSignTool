use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::Manager;

use super::dpapi;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProfileFile {
    pub next_id: u64,
    pub profiles: Vec<Profile>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Profile {
    pub id: u64,
    pub name: String,
    pub keystore_path: String,
    pub alias: String,
    pub store_pass_enc: String,
    pub key_pass_enc: String,
    pub strategy: String,
    pub created_at: String,
}

/// 对前端展示的脱敏副本（不含密码）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProfileMeta {
    pub id: u64,
    pub name: String,
    pub keystore_path: String,
    pub alias: String,
    pub strategy: String,
    pub created_at: String,
}

impl From<&Profile> for ProfileMeta {
    fn from(p: &Profile) -> Self {
        ProfileMeta {
            id: p.id,
            name: p.name.clone(),
            keystore_path: p.keystore_path.clone(),
            alias: p.alias.clone(),
            strategy: p.strategy.clone(),
            created_at: p.created_at.clone(),
        }
    }
}

pub fn profiles_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建应用数据目录: {e}"))?;
    Ok(dir.join("profiles.json"))
}

pub fn load(app: &tauri::AppHandle) -> Result<ProfileFile, String> {
    let path = profiles_path(app)?;
    if !path.exists() {
        return Ok(ProfileFile::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取签名配置失败: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("签名配置文件损坏: {e}"))
}

pub fn save(app: &tauri::AppHandle, file: &ProfileFile) -> Result<(), String> {
    let path = profiles_path(app)?;
    let json =
        serde_json::to_string_pretty(file).map_err(|e| format!("序列化签名配置失败: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("写入签名配置失败: {e}"))
}

pub fn metas(file: &ProfileFile) -> Vec<ProfileMeta> {
    file.profiles.iter().map(ProfileMeta::from).collect()
}

/// 按 id 找配置并解密出明文密码（仅驻留内存，绝不回传前端/日志）。
pub struct DecryptedIdentity {
    pub name: String,
    pub keystore_path: String,
    pub alias: String,
    pub store_pass: String,
    pub key_pass: String,
    pub strategy: String,
}

pub fn decrypt_profile(app: &tauri::AppHandle, id: u64) -> Result<DecryptedIdentity, String> {
    let file = load(app)?;
    let p = file
        .profiles
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "签名配置不存在".to_string())?;
    let store_pass = dpapi::unprotect_text(&p.store_pass_enc)?;
    let key_pass = dpapi::unprotect_text(&p.key_pass_enc)?;
    Ok(DecryptedIdentity {
        name: p.name.clone(),
        keystore_path: p.keystore_path.clone(),
        alias: p.alias.clone(),
        store_pass,
        key_pass,
        strategy: p.strategy.clone(),
    })
}

pub struct NewProfileInput {
    pub name: String,
    pub keystore_path: String,
    pub alias: String,
    pub store_pass: String,
    pub key_pass: String,
    pub strategy: String,
}

/// 新建/更新（name 相同则覆盖）一条签名配置，密码 DPAPI 加密落盘。
pub fn upsert(app: &tauri::AppHandle, input: NewProfileInput) -> Result<ProfileMeta, String> {
    let mut file = load(app)?;
    let now = now_str();
    // name 唯一：重名即覆盖
    if let Some(existing) = file.profiles.iter_mut().find(|p| p.name == input.name) {
        existing.keystore_path = input.keystore_path.clone();
        existing.alias = input.alias.clone();
        existing.store_pass_enc = dpapi::protect_text(&input.store_pass)?;
        existing.key_pass_enc = dpapi::protect_text(&input.key_pass)?;
        existing.strategy = input.strategy.clone();
        let meta = ProfileMeta::from(&*existing);
        save(app, &file)?;
        return Ok(meta);
    }
    let id = file.next_id + 1;
    file.next_id = id;
    let store_pass_enc = dpapi::protect_text(&input.store_pass)?;
    let key_pass_enc = dpapi::protect_text(&input.key_pass)?;
    let profile = Profile {
        id,
        name: input.name,
        keystore_path: input.keystore_path,
        alias: input.alias,
        store_pass_enc,
        key_pass_enc,
        strategy: input.strategy,
        created_at: now,
    };
    let meta = ProfileMeta::from(&profile);
    file.profiles.push(profile);
    save(app, &file)?;
    Ok(meta)
}

pub fn delete(app: &tauri::AppHandle, id: u64) -> Result<(), String> {
    let mut file = load(app)?;
    file.profiles.retain(|p| p.id != id);
    save(app, &file)
}

pub fn now_str() -> String {
    // 轻量 ISO 时间：SystemTime → 格式化，避免引入 chronso 全量依赖
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days as i64);
    let (hh, mi, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    format!("{y:04}-{m:02}-{d:02} {hh:02}:{mi:02}:{ss:02}")
}

/// Howard Hinnant 算法：unix 天数 → 儒略日期
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
