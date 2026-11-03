pub mod apksigner;
pub mod axml;
pub mod keytool;
pub mod proc;
pub mod zipalign;

// 引擎级集成测试（跑法：cargo test -- --test-threads=1，两个用例共用临时目录）
#[cfg(test)]
mod e2e_tests;

/// 签名策略 → v1/v2/v3/v4 开关映射
#[derive(Debug, Clone, Copy)]
pub struct StrategyFlags {
    pub v1: bool,
    pub v2: bool,
    pub v3: bool,
}

/// 签名策略代码（前端下拉选项 value）：
/// - v1            仅 V1
/// - v1v2          V1+V2
/// - v2_with_v1    V2 (包含V1)   ← 默认
/// - v1v2v3        V1+V2+V3
/// - v3_rotation   V3 (密钥轮换, 包含V1+V2)
pub fn flags_for_strategy(strategy: &str) -> StrategyFlags {
    match strategy {
        "v1" => StrategyFlags { v1: true, v2: false, v3: false },
        "v1v2" => StrategyFlags { v1: true, v2: true, v3: false },
        "v1v2v3" => StrategyFlags { v1: true, v2: true, v3: true },
        "v3_rotation" => StrategyFlags { v1: true, v2: true, v3: true },
        // 默认与 v2_with_v1
        _ => StrategyFlags { v1: true, v2: true, v3: false },
    }
}
/// Android 11（API 30）起，targetSdk ≥ 30 的 APK 必须带 V2 及以上签名方案，
/// 只有 V1 的包在这些设备上直接安装失败（INSTALL_PARSE_FAILED_NO_CERTIFICATES）。
pub const MIN_TARGET_SDK_REQUIRING_V2: u32 = 30;

/// 仅 V1 产物自检时把 verify 的 SDK 窗口钉到 V1 时代：
/// 否则 apksigner 会按 targetSdk 断言 V2 存在而报 "requires a minimum of signature scheme v2"，
/// 掩盖了「V1 签名本身是否有效」这个真正要验证的问题。
pub const V1_ONLY_VERIFY_SDK: u32 = 18;

/// 策略与 targetSdk 的兼容性告警；None = 无风险。
pub fn strategy_compat_warning(strategy: &str, target_sdk: Option<u32>) -> Option<String> {
    let f = flags_for_strategy(strategy);
    if f.v2 || f.v3 {
        return None;
    }
    let sdk = target_sdk?;
    if sdk < MIN_TARGET_SDK_REQUIRING_V2 {
        return None;
    }
    Some(format!(
        "该 APK 的 targetSdkVersion={sdk} ≥ {MIN_TARGET_SDK_REQUIRING_V2}，仅 V1 签名的安装包在 Android 11+ 设备上会安装失败（INSTALL_PARSE_FAILED_NO_CERTIFICATES）；建议改用 V2 及以上策略。本次仍按 V1 方案（SDK 窗口 {V1_ONLY_VERIFY_SDK}）自检。"
    ))
}

pub fn strategy_label(strategy: &str) -> String {
    match strategy {
        "v1" => "仅 V1 (JAR 签名)",
        "v1v2" => "V1+V2",
        "v1v2v3" => "V1+V2+V3",
        "v3_rotation" => "V3 (密钥轮换, 包含V1+V2)",
        _ => "V2 (APK Signature Scheme v2, 包含V1)",
    }
    .to_string()
}

pub const STRATEGIES: &[(&str, &str)] = &[
    ("v2_with_v1", "V2 (APK Signature Scheme v2, 包含V1)"),
    ("v1", "仅 V1 (JAR 签名)"),
    ("v1v2", "V1+V2"),
    ("v1v2v3", "V1+V2+V3"),
    ("v3_rotation", "V3 (密钥轮换, 包含V1+V2)"),
];
