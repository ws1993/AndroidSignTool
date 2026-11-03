//! 引擎层端到端集成测试：直接调用生产代码路径，不用命令行复刻。
//! 覆盖：keytool 建钥 → 别名回读 → zipalign 对齐 → apksigner 签名 + verify 自检
//!       → 密码临时文件销毁 → 签名产物再次对齐校验与 manifest 解析。
//!
//! 前置：`npm run prepare:tools` 已生成 `src-tauri/resources`（jre / apksigner.jar / zipalign.exe）。
//! 资源或夹具缺失时打印 SKIP 并跳过，不制造假失败。
use std::fs;
use std::path::{Path, PathBuf};

use super::{apksigner, axml, flags_for_strategy, keytool, zipalign};
use apksigner::IdentityRef;

fn manifest_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn resources() -> PathBuf {
    manifest_dir().join("resources")
}

fn fixture_apk() -> PathBuf {
    manifest_dir().join("tests").join("fixtures").join("base.apk")
}

fn scratch_dir() -> PathBuf {
    let p = std::env::temp_dir().join(format!("androidsign-e2e-{}", std::process::id()));
    let _ = fs::create_dir_all(&p);
    p
}

fn tools_ready(res: &Path) -> bool {
    res.join("jre").join("bin").join("java.exe").is_file()
        && res.join("jre").join("bin").join("keytool.exe").is_file()
        && res.join("lib").join("apksigner.jar").is_file()
        && res.join("zipalign.exe").is_file()
}

fn quiet(_: &str) {}

/// 手写 AXML 解析器对真实二进制 manifest（aapt 产物）的字段提取。
#[test]
fn manifest_info_from_real_binary_axml() {
    let fx = fixture_apk();
    if !fx.is_file() {
        eprintln!("SKIP: 缺少夹具 {}", fx.display());
        return;
    }
    let info = axml::read_manifest_from_zip(&fx).expect("解析夹具 manifest 失败");
    assert_eq!(info.package.as_deref(), Some("com.example.signtool"));
    // versionCode / minSdk / targetSdk 在 AXML 里是 INT_DEC 而非字符串，必须被解码
    assert_eq!(info.version_code.as_deref(), Some("1"));
    assert_eq!(info.version_name.as_deref(), Some("1.0"));
    assert_eq!(info.min_sdk.as_deref(), Some("21"));
    assert_eq!(info.target_sdk.as_deref(), Some("35"));
}

/// 完整签名链路（V1+V2+V3）。
#[test]
fn full_sign_pipeline_v1v2v3() {
    let res = resources();
    if !tools_ready(&res) {
        eprintln!("SKIP: resources 未就绪，请先执行 npm run prepare:tools");
        return;
    }
    let fx = fixture_apk();
    if !fx.is_file() {
        eprintln!("SKIP: 缺少夹具 {}", fx.display());
        return;
    }

    let dir = scratch_dir();
    let java = res.join("jre").join("bin").join("java.exe");
    let keytool_exe = res.join("jre").join("bin").join("keytool.exe");
    let signer_jar = res.join("lib").join("apksigner.jar");
    let zipalign_exe = res.join("zipalign.exe");

    // 注意：故意让 ks 密码与 key 密码相同，用来守住「两个独立密码临时文件」这条修复
    // （apksigner 对同一 file: 源按行消费，复用同一文件会 EOF）
    let pass = "E2eTestPass123";
    let alias = "release";

    // 1) 内置 JRE 的 keytool 建钥
    let ks = dir.join("release.keystore");
    let _ = fs::remove_file(&ks);
    let req = keytool::KeyGenReq {
        keystore_path: ks.clone(),
        alias: alias.to_string(),
        store_pass: pass.to_string(),
        key_pass: pass.to_string(),
        validity_days: 9125,
        key_size: 2048,
        common_name: "AndroidSignTool E2E".to_string(),
        org_unit: "QA".to_string(),
        org: "Local".to_string(),
        city: "City".to_string(),
        state: "State".to_string(),
        country: "cn".to_string(),
        tmp_dir: dir.clone(),
    };
    keytool::generate(&keytool_exe, &req, &mut quiet).expect("keytool 建钥失败");
    assert!(ks.is_file(), "keystore 未生成");

    // 2) 别名回读 = 同时校验密码可用
    let aliases = keytool::list_aliases(&keytool_exe, &ks, pass, &dir, &mut quiet)
        .expect("keytool -list 失败（密码或 keystore 不可用）");
    assert!(
        aliases.iter().any(|a| a == alias),
        "别名列表异常: {aliases:?}"
    );

    // 3) zipalign
    let input = dir.join("in.apk");
    fs::copy(&fx, &input).expect("复制夹具失败");
    let aligned = dir.join("aligned.apk");
    let _ = fs::remove_file(&aligned);
    zipalign::align(&zipalign_exe, &input, &aligned, &mut quiet).expect("zipalign 失败");
    assert!(
        zipalign::check(&zipalign_exe, &aligned, &mut quiet).unwrap(),
        "对齐结果未通过 zipalign -c"
    );

    // 4) apksigner sign + verify 自检
    let out = dir.join("out-signed.apk");
    let _ = fs::remove_file(&out);
    let flags = flags_for_strategy("v1v2v3");
    let id = IdentityRef {
        keystore_path: ks.to_str().unwrap(),
        alias,
        store_pass: pass,
        key_pass: pass,
    };
    let mut lines: Vec<String> = Vec::new();
    let outcome = apksigner::sign_and_verify(
        &java,
        &signer_jar,
        &aligned,
        &out,
        &id,
        &flags,
        false,
        None,
        &dir,
        &mut |l| lines.push(l.to_string()),
    )
    .expect("apksigner 签名或自检失败");

    assert!(out.is_file(), "签名产物不存在");
    assert!(
        outcome.verify_cert_sha256.is_some(),
        "verify 未回显证书 SHA-256；日志: {lines:?}"
    );
    assert!(
        lines.iter().any(|l| l.contains("verify 通过")),
        "未见 verify 通过日志: {lines:?}"
    );

    // 5) 明文密码临时文件必须已销毁
    for tag in ["ks", "key"] {
        assert!(
            !dir.join(format!(".ast-{tag}-pw")).exists(),
            "apksigner 密码临时文件未清理: {tag}"
        );
    }
    for tag in ["store", "key", "list"] {
        assert!(
            !dir.join(format!(".ast-keytool-{tag}")).exists(),
            "keytool 密码临时文件未清理: {tag}"
        );
    }

    // 6) 签名产物仍需满足对齐要求，且 manifest 依然可解析
    assert!(
        zipalign::check(&zipalign_exe, &out, &mut quiet).unwrap(),
        "签名产物未通过 zipalign -c"
    );
    let info = axml::read_manifest_from_zip(&out).expect("签名产物 manifest 解析失败");
    assert_eq!(info.package.as_deref(), Some("com.example.signtool"));

    // 7) inspect() 只读不写
    let report = apksigner::inspect(&java, &signer_jar, &out).expect("inspect 失败");
    assert!(
        report.iter().any(|l| l.contains("Verified using v3 scheme")),
        "inspect 输出缺少 v3 行"
    );
}

/// 仅 V1 策略：apksigner 对无 dex 的最小 APK 也应产出 V1 签名。
#[test]
fn sign_v1_only_strategy() {
    let res = resources();
    if !tools_ready(&res) {
        eprintln!("SKIP: resources 未就绪");
        return;
    }
    let dir = scratch_dir();
    let ks = dir.join("release.keystore");
    if !ks.is_file() {
        eprintln!("SKIP: 依赖 full_sign_pipeline_v1v2v3 生成的 keystore");
        return;
    }
    let aligned = dir.join("aligned.apk");
    let out = dir.join("v1-only.apk");
    let _ = fs::remove_file(&out);
    let flags = flags_for_strategy("v1");
    let id = IdentityRef {
        keystore_path: ks.to_str().unwrap(),
        alias: "release",
        store_pass: "E2eTestPass123",
        key_pass: "E2eTestPass123",
    };
    apksigner::sign_and_verify(
        &res.join("jre").join("bin").join("java.exe"),
        &res.join("lib").join("apksigner.jar"),
        &aligned,
        &out,
        &id,
        &flags,
        false,
        // 夹具 targetSdk=35，按默认窗口校验必然报 "requires a minimum of signature scheme v2"；
        // 钉到 V1 时代窗口，验证的才是本次真正写入的 JAR 签名
        Some(super::V1_ONLY_VERIFY_SDK),
        &dir,
        &mut quiet,
    )
    .expect("V1 签名失败");
    assert!(out.is_file(), "V1 签名产物不存在");

    // 策略 × targetSdk 兼容性判定（夹具 targetSdk=35 ≥ 30 → 必须告警）
    assert!(
        super::strategy_compat_warning("v1", Some(35)).is_some(),
        "仅 V1 + targetSdk=35 应给出兼容性告警"
    );
    assert!(super::strategy_compat_warning("v1v2v3", Some(35)).is_none());
    assert!(super::strategy_compat_warning("v1", Some(28)).is_none());
    assert!(super::strategy_compat_warning("v1", None).is_none());
}
