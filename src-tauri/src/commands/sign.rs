use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

use crate::engine::{self, apksigner, axml, zipalign};
use crate::store::{history_db, profile_store};
use crate::tool_paths;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignRequest {
    /// 前端生成的任务标识，用于日志事件归组
    pub task_id: String,
    pub apk_path: String,
    #[serde(default)]
    pub out_dir: Option<String>,
    pub strategy: String,
    #[serde(default)]
    pub v4: bool,
    #[serde(default)]
    pub zipalign_enabled: bool,
    // —— 使用指定文件签名 ——
    #[serde(default)]
    pub keystore_path: Option<String>,
    #[serde(default)]
    pub alias: Option<String>,
    #[serde(default)]
    pub store_pass: Option<String>,
    #[serde(default)]
    pub key_pass: Option<String>,
    // —— 使用已配置签名 ——
    #[serde(default)]
    pub profile_id: Option<u64>,
    // —— 保存签名复选框 ——
    #[serde(default)]
    pub save_profile_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignResult {
    pub ok: bool,
    pub output_apk: Option<String>,
    pub error: Option<String>,
    pub duration_ms: u64,
    pub strategy: String,
    pub cert: Option<String>,
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
        LogLine {
            task_id,
            line: &line.to_string(),
        },
    );
}

fn history_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| {
            let _ = std::fs::create_dir_all(&d);
            d.join("history.db")
        })
}

struct Inner {
    output_apk: String,
    cert: Option<String>,
}

#[tauri::command]
pub fn sign_apk(app: AppHandle, req: SignRequest) -> SignResult {
    let started = Instant::now();
    let label = engine::strategy_label(&req.strategy);

    let outcome = do_sign(&app, &req);

    // 成功与失败都进历史
    if let Some(db) = history_path(&app) {
        if let Ok(conn) = history_db::open(&db) {
            let rec = history_db::NewRecord {
                apk: &req.apk_path,
                output: outcome.as_ref().map(|o| o.output_apk.as_str()).unwrap_or(""),
                strategy: &req.strategy,
                ok: outcome.is_ok(),
                error: outcome.as_ref().err().map(|e| e.as_str()),
                duration_ms: started.elapsed().as_millis() as u64,
                cert: outcome.as_ref().ok().and_then(|o| o.cert.as_deref()),
            };
            let _ = history_db::insert(&conn, &rec);
        }
    }

    let duration_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok(v) => SignResult {
            ok: true,
            output_apk: Some(v.output_apk),
            error: None,
            duration_ms,
            strategy: label,
            cert: v.cert,
        },
        Err(e) => SignResult {
            ok: false,
            output_apk: None,
            error: Some(e),
            duration_ms,
            strategy: label,
            cert: None,
        },
    }
}

fn do_sign(app: &AppHandle, req: &SignRequest) -> Result<Inner, String> {
    let input = PathBuf::from(&req.apk_path);
    if !input.is_file() {
        return Err(format!("APK 文件不存在：{}", req.apk_path));
    }

    // 解析签名身份（已配置签名优先；否则用表单里的指定文件）
    let (ks, alias, store_pass, key_pass) = match req.profile_id {
        Some(id) => {
            let d = profile_store::decrypt_profile(app, id)?;
            log(
                app,
                &req.task_id,
                &format!(
                    "[配置] 使用已保存签名配置「{}」（该配置保存时的默认策略：{}）",
                    d.name,
                    engine::strategy_label(&d.strategy)
                ),
            );
            (d.keystore_path, d.alias, d.store_pass, d.key_pass)
        }
        None => {
            let ks = req
                .keystore_path
                .clone()
                .filter(|s| !s.trim().is_empty())
                .ok_or("未选择签名文件（keystore）")?;
            let alias = req
                .alias
                .clone()
                .filter(|s| !s.trim().is_empty())
                .ok_or("未填写密钥别名 alias")?;
            let sp = req
                .store_pass
                .clone()
                .filter(|s| !s.is_empty())
                .ok_or("未填写密钥库密码")?;
            let kp = req
                .key_pass
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| sp.clone());
            (ks, alias, sp, kp)
        }
    };
    if !Path::new(&ks).is_file() {
        return Err(format!("签名文件不存在：{ks}"));
    }

    // 保存签名（勾选后写入本地配置，密码 DPAPI 加密）
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
                store_pass: store_pass.clone(),
                key_pass: key_pass.clone(),
                strategy: req.strategy.clone(),
            },
        )?;
        log(
            app,
            &req.task_id,
            &format!("[配置] 已保存签名配置「{}」，下次可在「使用已配置签名」中选择", meta.name),
        );
    }

    let java = tool_paths::java_exe(app)?;
    let jar = tool_paths::apksigner_jar(app)?;
    let zipalign_bin = tool_paths::zipalign_exe(app)?;

    let out_path = derive_output(&input, req.out_dir.as_deref())?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("无法定位缓存目录: {e}"))?;
    std::fs::create_dir_all(&cache).map_err(|e| format!("创建缓存目录失败: {e}"))?;

    let mut emit = |line: &str| log(app, &req.task_id, line);

    emit(&format!("目标 APK：{}", input.display()));
    emit(&format!(
        "策略：{}   zipalign：{}",
        engine::strategy_label(&req.strategy),
        if req.zipalign_enabled { "开" } else { "关" }
    ));

    // 读取 manifest：回显包信息，并做「策略 × targetSdk」兼容性判定
    let mut verify_sdk: Option<u32> = None;
    let target_sdk = match axml::read_manifest_from_zip(&input) {
        Ok(info) => {
            emit(&format!(
                "[manifest] package={} versionCode={} versionName={} minSdk={} targetSdk={}",
                info.package.as_deref().unwrap_or("?"),
                info.version_code.as_deref().unwrap_or("?"),
                info.version_name.as_deref().unwrap_or("?"),
                info.min_sdk.as_deref().unwrap_or("?"),
                info.target_sdk.as_deref().unwrap_or("?")
            ));
            info.target_sdk.and_then(|s| s.parse::<u32>().ok())
        }
        Err(e) => {
            emit(&format!("[manifest] 读取失败（不影响签名）：{e}"));
            None
        }
    };
    if let Some(warn) = engine::strategy_compat_warning(&req.strategy, target_sdk) {
        emit(&format!("[警告] {warn}"));
        verify_sdk = Some(engine::V1_ONLY_VERIFY_SDK);
    }

    // 1) zipalign（可选，先对齐再签名）
    let sign_input: PathBuf;
    let mut tmp_aligned: Option<PathBuf> = None;
    if req.zipalign_enabled {
        let tmp = cache.join(format!("aligned-{}.apk", req.task_id));
        if let Err(e) = zipalign::align(&zipalign_bin, &input, &tmp, &mut emit) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
        tmp_aligned = Some(tmp.clone());
        sign_input = tmp;
    } else {
        emit("已关闭 zipalign，直接签名原文件");
        sign_input = input.clone();
    }

    // 2) apksigner sign + verify
    let flags = engine::flags_for_strategy(&req.strategy);
    let idr = apksigner::IdentityRef {
        keystore_path: &ks,
        alias: &alias,
        store_pass: &store_pass,
        key_pass: &key_pass,
    };
    let res = apksigner::sign_and_verify(
        &java,
        &jar,
        &sign_input,
        &out_path,
        &idr,
        &flags,
        req.v4,
        verify_sdk,
        &cache,
        &mut emit,
    );
    if let Some(t) = tmp_aligned {
        let _ = std::fs::remove_file(t);
    }
    let outcome = res?;

    // V4 附带 .idsig
    if req.v4 {
        let idsig = PathBuf::from(format!("{}.idsig", out_path.display()));
        if idsig.exists() {
            emit(&format!("[apksigner] 已生成 V4 增量签名文件 {}", idsig.display()));
        }
    }

    Ok(Inner {
        output_apk: out_path.display().to_string(),
        cert: outcome.verify_cert_sha256,
    })
}

fn derive_output(input: &Path, out_dir: Option<&str>) -> Result<PathBuf, String> {
    let stem = input.file_stem().and_then(|s| s.to_str()).unwrap_or("app");
    let dir: PathBuf = match out_dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => input
            .parent()
            .ok_or_else(|| "无法确定输出目录".to_string())?
            .to_path_buf(),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建输出目录失败: {e}"))?;
    let out = dir.join(format!("{stem}-signed.apk"));
    if std::fs::canonicalize(&out).ok() == std::fs::canonicalize(input).ok() {
        return Err("输出文件与输入 APK 相同，请指定其他输出目录".to_string());
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyOption {
    pub value: String,
    pub label: String,
}

#[tauri::command]
pub fn list_strategies() -> Vec<StrategyOption> {
    engine::STRATEGIES
        .iter()
        .map(|(v, l)| StrategyOption {
            value: v.to_string(),
            label: l.to_string(),
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub java: bool,
    pub keytool: bool,
    pub apksigner: bool,
    pub zipalign: bool,
    pub java_path: Option<String>,
}

#[tauri::command]
pub fn check_tools(app: AppHandle) -> ToolStatus {
    let java = tool_paths::java_exe(&app).ok();
    ToolStatus {
        java: java.is_some(),
        keytool: tool_paths::keytool_exe(&app).is_ok(),
        apksigner: tool_paths::apksigner_jar(&app).is_ok(),
        zipalign: tool_paths::zipalign_exe(&app).is_ok(),
        java_path: java.map(|p| p.display().to_string()),
    }
}
