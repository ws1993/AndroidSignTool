use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::proc::run_and_stream;
use super::StrategyFlags;
/// 强制 JVM 以 UTF-8 写 stdout/stderr，避免中文 Windows 下 GBK 字节污染日志
/// （verify 的证书摘要行需要被稳定解析；proc.rs 侧另有 ACP 回退兜底）。
const JVM_UTF8: [&str; 2] = ["-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8"];

/// 一次签名所需的身份材料（明文密码仅驻内存，用后即焚）
pub struct IdentityRef<'a> {
    pub keystore_path: &'a str,
    pub alias: &'a str,
    pub store_pass: &'a str,
    pub key_pass: &'a str,
}

pub struct SignOutcome {
    pub verify_cert_sha256: Option<String>,
}

/// apksigner 的 `--ks-pass file:<f>` / `--key-pass file:<f>` 语义：**文件内容就是裸密码本身**
/// （一行，末尾换行会被去掉）。注意不是 `pass:<密码>`——`pass:` 是 source 类型前缀，
/// 写进文件会变成密码的一部分，导致 "keystore password was incorrect"。
///
/// 取子进程输出里最有诊断价值的尾段：apksigner 把真正的失败原因写在最后几行，
/// 而前面往往是无关的 JVM 警告。空输出时给出明确占位，避免错误信息悬空。
fn tail_of(lines: &[String]) -> String {
    let tail: Vec<&str> = lines
        .iter()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if tail.is_empty() {
        "apksigner 未输出任何诊断信息".to_string()
    } else {
        tail.join(" | ")
    }
}
fn write_pass_file(dir: &Path, tag: &str, pw: &str) -> Result<PathBuf, String> {
    let path = dir.join(format!(".ast-{tag}-pw"));
    fs::write(&path, format!("{pw}\n")).map_err(|e| format!("写入密码临时文件失败: {e}"))?;
    Ok(path)
}

/// apksigner sign + verify 自检。
pub fn sign_and_verify(
    java_exe: &Path,
    signer_jar: &Path,
    input_apk: &Path,
    output_apk: &Path,
    id: &IdentityRef,
    flags: &StrategyFlags,
    v4: bool,
    // Some(n)：verify 时把 SDK 窗口钉到 n（仅 V1 这类低方案产物的自检需要）
    verify_sdk: Option<u32>,
    tmp_dir: &Path,
    emit: &mut dyn FnMut(&str),
) -> Result<SignOutcome, String> {
    let ks_pass_file = write_pass_file(tmp_dir, "ks", id.store_pass)?;
    // 必须是两个独立文件：apksigner 对同一个 file: 源按行顺序消费，
    // 复用同一文件时第二次读取会撞到 EOF（"end of file reached in <file>"），
    // 即使 ks 密码与 key 密码相同也要各写一份。
    let key_pass_file = write_pass_file(tmp_dir, "key", id.key_pass)?;

    let mut cmd = Command::new(java_exe);
    cmd.args(JVM_UTF8)
        .arg("-jar")
        .arg(signer_jar)
        .arg("sign")
        .arg("--ks")
        .arg(id.keystore_path)
        .arg("--ks-key-alias")
        .arg(id.alias)
        .arg("--ks-pass")
        .arg(format!("file:{}", ks_pass_file.display()))
        .arg("--key-pass")
        .arg(format!("file:{}", key_pass_file.display()))
        .arg("--v1-signing-enabled")
        .arg(flags.v1.to_string())
        .arg("--v2-signing-enabled")
        .arg(flags.v2.to_string())
        .arg("--v3-signing-enabled")
        .arg(flags.v3.to_string())
        .arg("--v4-signing-enabled")
        .arg(v4.to_string())
        .arg("--out")
        .arg(output_apk)
        .arg(input_apk);

    emit(&format!(
        "$ apksigner sign --v1={} --v2={} --v3={} --v4={}  (密码经 file: 临时文件传递，已用后删除)",
        flags.v1, flags.v2, flags.v3, v4
    ));

    let sign_result = run_and_stream(cmd, &mut *emit);

    let _ = fs::remove_file(&key_pass_file);
    let _ = fs::remove_file(&ks_pass_file);

    let (code, out) = sign_result?;
    if code != 0 {
        // 失败时必须带上 apksigner 自己的诊断行：只回一个退出码，
        // 用户和排障者都无从判断是密码错、keystore 类型不支持还是输出路径不可写。
        return Err(format!(
            "apksigner sign 失败（退出码 {code}）：{}",
            tail_of(&out)
        ));
    }
    emit(&format!("[apksigner] 签名完成 → {}", output_apk.display()));

    // verify 自检：确认策略确实生效
    let mut verify = Command::new(java_exe);
    verify
        .args(JVM_UTF8)
        .arg("-jar")
        .arg(signer_jar)
        .arg("verify")
        .arg("-v")
        .arg("--print-certs");
    if let Some(sdk) = verify_sdk {
        verify
            .arg("--min-sdk-version")
            .arg(sdk.to_string())
            .arg("--max-sdk-version")
            .arg(sdk.to_string());
    }
    // apksigner 在第一个非选项参数处停止选项解析：APK 路径必须排在所有选项之后，
    // 否则 --min-sdk-version 会被当成额外的待验文件路径（表现为 verify 退出码 1）。
    verify.arg(output_apk);
    emit(&format!(
        "$ apksigner verify -v --print-certs{}",
        verify_sdk
            .map(|s| format!(" --min-sdk-version {s} --max-sdk-version {s}"))
            .unwrap_or_default()
        ));
    let (code, out) = run_and_stream(verify, &mut *emit)?;
    if code != 0 {
        return Err(format!(
            "apksigner verify 校验失败（退出码 {code}）：{}",
            tail_of(&out)
        ));
    }
    let cert = out
        .iter()
        .find(|l| l.contains("certificate SHA-256"))
        .map(|l| l.trim().to_string());
    emit("[apksigner] verify 通过 ✓");
    Ok(SignOutcome {
        verify_cert_sha256: cert,
    })
}

/// 读取 APK 现有签名状态（verify -v，不改动文件）
pub fn inspect(java_exe: &Path, signer_jar: &Path, apk: &Path) -> Result<Vec<String>, String> {
    let mut cmd = Command::new(java_exe);
    cmd.args(JVM_UTF8)
        .arg("-jar")
        .arg(signer_jar)
        .arg("verify")
        .arg("-v")
        .arg("--print-certs")
        .arg(apk);
    let (_code, out) = run_and_stream(cmd, &mut |_| {})?;
    Ok(out)
}
