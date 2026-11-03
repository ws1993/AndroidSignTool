use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::proc::run_and_stream;

/// keytool.exe 是原生启动器，`-J` 前缀把参数转交 JVM。
/// 强制 UTF-8 输出，避免中文 Windows 下 GBK 字节污染日志（proc.rs 侧另有 ACP 回退兜底）。
const JVM_UTF8: [&str; 2] = ["-J-Dstdout.encoding=UTF-8", "-J-Dstderr.encoding=UTF-8"];
pub struct KeyGenReq {
    pub keystore_path: PathBuf,
    pub alias: String,
    pub store_pass: String,
    pub key_pass: String,
    pub validity_days: u32,
    pub key_size: u32, // 2048 / 4096
    pub common_name: String,
    pub org_unit: String,
    pub org: String,
    pub city: String,
    pub state: String,
    pub country: String, // 两位国家码
    pub tmp_dir: PathBuf,
}

fn write_raw_pass_file(dir: &Path, tag: &str, pw: &str) -> Result<PathBuf, String> {
    let path = dir.join(format!(".ast-keytool-{tag}"));
    fs::write(&path, pw).map_err(|e| format!("写入密码临时文件失败: {e}"))?;
    Ok(path)
}

/// keytool -genkeypair。storetype 固定 PKCS12（apksigner 原生支持，且为 JDK9+ 默认）。
/// 密码走 `-storepass:file <file>`（JDK9+ 语法），不出现在进程命令行中。
pub fn generate(keytool_exe: &Path, req: &KeyGenReq, emit: &mut dyn FnMut(&str)) -> Result<(), String> {
    if req.keystore_path.exists() {
        return Err("目标 keystore 文件已存在，请换个路径或文件名".to_string());
    }
    if req.common_name.trim().is_empty() {
        return Err("CN（通用名称）不能为空".to_string());
    }
    if req.country.trim().len() != 2 {
        return Err("国家码必须是两位字母（例如 CN）".to_string());
    }
    let dname = format!(
        "CN={}, OU={}, O={}, L={}, ST={}, C={}",
        req.common_name.trim(),
        req.org_unit.trim(),
        req.org.trim(),
        req.city.trim(),
        req.state.trim(),
        req.country.trim().to_uppercase()
    );

    let store_file = write_raw_pass_file(&req.tmp_dir, "store", &req.store_pass)?;
    let key_file = if req.key_pass == req.store_pass {
        store_file.clone()
    } else {
        write_raw_pass_file(&req.tmp_dir, "key", &req.key_pass)?
    };

    let mut cmd = Command::new(keytool_exe);
    cmd.args(JVM_UTF8)
        .arg("-genkeypair")
        .arg("-storetype")
        .arg("PKCS12")
        .arg("-keystore")
        .arg(&req.keystore_path)
        .arg("-alias")
        .arg(&req.alias)
        .arg("-keyalg")
        .arg("RSA")
        .arg("-keysize")
        .arg(req.key_size.to_string())
        .arg("-validity")
        .arg(req.validity_days.to_string())
        .arg("-dname")
        .arg(dname)
        .arg("-storepass:file")
        .arg(&store_file)
        .arg("-keypass:file")
        .arg(&key_file);

    emit(&format!(
        "$ keytool -genkeypair -storetype PKCS12 -alias {} -keyalg RSA -keysize {} -validity {}  (密码经 file: 临时文件传递)",
        req.alias, req.key_size, req.validity_days
    ));
    let result = run_and_stream(cmd, &mut *emit);

    if key_file != store_file {
        let _ = fs::remove_file(&key_file);
    }
    let _ = fs::remove_file(&store_file);

    let (code, _) = result?;
    if code != 0 {
        return Err(format!("keytool 生成失败（退出码 {code}）"));
    }
    emit(&format!("[keytool] 生成成功 → {}", req.keystore_path.display()));
    Ok(())
}

/// 列出 keystore 中的别名（用于保存配置前校验密码是否正确）
pub fn list_aliases(
    keytool_exe: &Path,
    keystore: &Path,
    store_pass: &str,
    tmp_dir: &Path,
    emit: &mut dyn FnMut(&str),
) -> Result<Vec<String>, String> {
    let store_file = write_raw_pass_file(tmp_dir, "list", store_pass)?;
    let mut cmd = Command::new(keytool_exe);
    cmd.args(JVM_UTF8)
        .arg("-list")
        .arg("-keystore")
        .arg(keystore)
        .arg("-storepass:file")
        .arg(&store_file);
    let result = run_and_stream(cmd, &mut *emit);
    let _ = fs::remove_file(&store_file);
    let (code, out) = result?;
    if code != 0 {
        return Err("keytool -list 失败，keystore 路径或密钥库密码不正确".to_string());
    }
    // 输出行形如：  alias, 2026-01-01, PrivateKeyEntry,
    let aliases = out
        .iter()
        .filter_map(|l| {
            let l = l.trim();
            if l.ends_with("PrivateKeyEntry,") || l.contains("PrivateKeyEntry") {
                l.split(',').next().map(|a| a.trim().to_string())
            } else {
                None
            }
        })
        .filter(|a| !a.is_empty())
        .collect();
    Ok(aliases)
}
