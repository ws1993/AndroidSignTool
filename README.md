# AndroidSignTool · Android APK 签名工具（Windows 桌面端）

面向 Android 应用分发环节的本地签名工作台：图形化完成 **keystore 生成 → APK 对齐 → 多方案签名 → 验签自检 → 历史记录** 全链路，并把 Java 运行时与 Android 签名工具链一起打进安装包，**装机即用，无需用户自备 JDK / Android SDK**。

- 技术形态：Tauri v2（Rust 后端）+ React 19 + TypeScript + antd 5
- 运行平台：Windows 10/11 x64（NSIS 安装包）
- 更新方式：GitHub Release + Tauri updater 应用内热更新
- 数据形态：全本地，不上传任何 APK、口令或签名材料

---

## 目录

- [核心能力](#核心能力)
- [签名策略](#签名策略)
- [工具链装配](#工具链装配免装-jdk--android-sdk-的关键)
- [环境要求](#环境要求)
- [本地开发与构建](#本地开发与构建)
- [测试](#测试)
- [项目结构](#项目结构)
- [数据存储与安全设计](#数据存储与安全设计)
- [发布新版本](#发布新版本)
- [自动更新与产物校验](#自动更新与产物校验)
- [常见问题](#常见问题)

---

## 核心能力

应用顶栏为四个页签，后端命令注册见 [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs)。

| 页签 | 能力 | 关键命令（Tauri `invoke`） |
| :--- | :--- | :--- |
| **APK 签名** | 选择 APK 与签名配置执行签名；实时逐行回显 `zipalign` / `apksigner` 输出；结束后自动验签自检并给出证书摘要 | `sign_apk`、`list_strategies`、`check_tools` |
| **生成签名文件** | 新建 keystore（别名、DN 字段、有效期、密钥长度可配）；已存在文件探测与别名枚举；可顺手存为签名配置 | `generate_keystore`、`keystore_exists`、`probe_keystore` |
| **签名历史** | 记录每次签名的输入/输出、策略、成败、耗时与证书信息；支持清空与导出 CSV（导出不含任何口令字段） | `history_list`、`history_clear`、`history_export` |
| **设置** | 签名配置（profile）增删改查；工具链就绪状态；数据目录定位与打开；代理连通性测试 | `list_profiles`、`save_profile`、`delete_profile`、`data_paths`、`test_proxy`、`open_in_explorer` |

另外提供 **APK 体检**：直接从 zip 中解析二进制 `AndroidManifest.xml`（自研 AXML 解析器，不依赖 `aapt`），读出包名、`versionCode/Name`、`minSdk/targetSdk/maxSdk`，并结合 `apksigner verify` 给出已存在的签名方案与证书信息（`apk_info`）。

签名过程中若 targetSdk 与所选策略不兼容，会在执行前给出明确告警而不是静默产出装不上的包，详见下节。

---

## 签名策略

策略代码 → v1/v2/v3 开关的映射与兼容性判定集中在 [`src-tauri/src/engine/mod.rs`](src-tauri/src/engine/mod.rs)。

| 策略代码 | 显示名称 | V1 | V2 | V3 |
| :--- | :--- | :---: | :---: | :---: |
| `v2_with_v1`（默认） | V2 (APK Signature Scheme v2, 包含V1) | ✓ | ✓ | |
| `v1` | 仅 V1 (JAR 签名) | ✓ | | |
| `v1v2` | V1+V2 | ✓ | ✓ | |
| `v1v2v3` | V1+V2+V3 | ✓ | ✓ | ✓ |
| `v3_rotation` | V3 (密钥轮换, 包含V1+V2) | ✓ | ✓ | ✓ |

V4 签名独立于上表，由请求参数 `v4` 开关控制。

两条已内建的正确性守则：

1. **targetSdk ≥ 30 只签 V1 会安装失败**（`INSTALL_PARSE_FAILED_NO_CERTIFICATES`）。工具在选择仅 V1 策略且 APK 的 `targetSdkVersion ≥ 30` 时主动告警并建议改用 V2 及以上。
2. **仅 V1 产物自检时把 verify 的 SDK 窗口钉到 18**。否则 `apksigner` 会因 targetSdk 断言 V2 存在而报错，掩盖「V1 签名本身是否有效」这个真正要验证的问题。

执行顺序为 **先 `zipalign` 对齐（可开关）、后 `apksigner` sign + verify**：对齐产物写入应用缓存目录的临时文件再作为签名输入，签名后再对齐会破坏 V2/V3 校验，因此顺序不可颠倒；关闭对齐时直接签名原文件。产物命名规则为 `原名-signed.apk`，输出目录可选，缺省与源文件同目录。

---

## 工具链装配（免装 JDK / Android SDK 的关键）

`src-tauri/resources/` 下的运行时代码**不入库**（见 [`.gitignore`](.gitignore)），由 [`scripts/prepare-tools.ps1`](scripts/prepare-tools.ps1) 在本地/CI 现场抽取，再由 Tauri `bundle.resources` 打进安装包：

| 产物 | 来源 | 用途 |
| :--- | :--- | :--- |
| `lib/apksigner.jar` | Android SDK `build-tools/<ver>/lib/` | V1–V4 签名与验签 |
| `zipalign.exe` | Android SDK `build-tools/<ver>/` | APK 4 字节对齐 |
| 白名单运行库 dll | `build-tools/<ver>/` | `zipalign`/`java` 依赖（仅收 `libwinpthread` 等，避免把 LLVM 工具链打进包） |
| `jre/` | `jlink` 现场裁剪的运行时 | 承载 `apksigner.jar`，并提供 `keytool.exe` 生成 keystore |

裁剪逻辑：以保底模块集（`java.base`、`java.logging`、`java.xml`、`java.desktop`、`java.sql`、`java.naming`、`jdk.unsupported`、`jdk.crypto.ec`、`jdk.crypto.cryptoki`、`jdk.charsets`）并上 `jdeps --print-module-deps` 对 `apksigner.jar` 的实测推导结果，用 `jlink` 生成最小 JRE。脚本末尾还会自检 `java -jar apksigner.jar version` / `keytool -list` / `zipalign` 是否真的能跑起来——**模块缺漏在这一步就暴露，而不是等用户装机后失败**。

脚本幂等：`jre/` 已存在时跳过，`-Force` 强制重建；`-BuildTools` 与 `-JdkHome` 可显式指定版本。

---

## 环境要求

**开发机（构建时）**

| 依赖 | 要求 |
| :--- | :--- |
| Node.js | LTS（本仓库 CI 固定 22） |
| Rust | stable toolchain（Tauri 2） |
| JDK | 含 `jlink` + `jmods`（JDK 17/21 均可；CI 用 Temurin 21） |
| Android SDK | `build-tools`（含 `lib/apksigner.jar` 与 `zipalign.exe`），通过 `ANDROID_HOME` / `ANDROID_SDK_ROOT` 或默认路径探测 |
| Windows SDK / MSVC | Tauri 在 Windows 上的标准构建前置 |
| WebView2 | 目标机器运行时依赖（Win10/11 一般已内置） |

**最终用户机器**：只需 Windows x64。JDK、Android SDK、`apksigner`、`zipalign` 全部随安装包自带。

---

## 本地开发与构建

```powershell
# 1) 安装前端依赖
npm ci

# 2) 抽取签名工具链到 src-tauri/resources（首次或换 build-tools 版本后必做）
npm run prepare:tools

# 3) 热更新开发模式（Vite devUrl: http://localhost:9420）
npm run tauri:dev

# 4) 生产构建：tsc 类型检查 + vite build + Tauri 打包 NSIS
npm run build
npm run tauri:build
```

安装包产物输出在 `src-tauri/target/release/bundle/nsis/`。

常用 npm 脚本一览见 [`package.json`](package.json)：`dev` / `build` / `preview` / `tauri` / `tauri:dev` / `tauri:build` / `test` / `prepare:tools`。

---

## 测试

```powershell
# Rust 侧单元测试 + 引擎级集成测试
npm test

# 集成测试用例共用临时目录，必须单线程跑
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1
```

引擎集成测试位于 [`src-tauri/src/engine/e2e_tests.rs`](src-tauri/src/engine/e2e_tests.rs)，基于 [`src-tauri/tests/fixtures/base.apk`](src-tauri/tests/fixtures/base.apk) 走真实的「对齐 → 签名 → 验签」闭环。前端 TypeScript 侧无独立测试运行器，类型检查由 `npm run build` 的 `tsc` 承担。

---

## 项目结构

```text
.
├── src/                      前端（React + antd）
│   ├── pages/                SignPage / KeystorePage / HistoryPage / SettingsPage
│   ├── components/           Layout、LogConsole（流式日志面板）
│   └── lib/                  api.ts（invoke 契约与类型）、proxy.ts
├── src-tauri/                Rust 后端
│   ├── src/commands/         Tauri 命令层：sign / profile / keystore / apkinfo / history / system
│   ├── src/engine/           外部工具编排：apksigner / keytool / zipalign / axml / proc
│   ├── src/store/            持久化：profile_store、history_db(SQLite)、dpapi(Windows DPAPI)
│   ├── src/tool_paths.rs     打包资源的定位与存在性校验
│   ├── resources/            工具链装配输出（多数不入库，见上节）
│   └── tauri.conf.json       窗口、bundle、updater 配置
├── scripts/                  prepare-tools.ps1 / bump-version.ps1 / release.ps1
├── .github/workflows/        release.yml（构建 + minisign 签名 + 发 Release + latest.json）
├── brand/                    品牌资产与规范（logo、图标、预览）
├── design-demos/             历史设计稿快照（不随版本追改）
└── .pi/skills/               仓库内维护的发布流程 skill
```

---

## 数据存储与安全设计

运行时数据落在 Tauri 的 `app_data_dir`（Windows 下为 `%APPDATA%\<identifier>` 形态，具体路径请在应用内「设置 → 数据目录」查看，程序也提供「打开目录」入口）：

| 文件 | 内容 |
| :--- | :--- |
| `profiles.json` | 签名配置（keystore 路径、别名、默认策略）与**加密后的口令字段** |
| `history.db` | 签名历史（SQLite，`rusqlite` bundled） |

安全取舍：

- **口令不落明文**：keystore 口令经 Windows DPAPI（`CryptProtectData` / `CryptUnprotectData`）加密后入库，绑定当前 Windows 用户，因此 `profiles.json` 换机或换用户后不可解（属预期设计，不提供口令导出）。
- **日志脱敏**：外部工具的输出在进入日志流前经 [`engine/proc.rs`](src-tauri/src/engine/proc.rs) 的 `redact` 处理，避免口令出现在界面与历史里。
- **导出不含口令**：历史 CSV 明确排除任何凭据字段。
- **无网络上报**：签名链路不发起任何业务请求；网络能力仅用于应用内更新检查与设置页的代理连通性自测。

---

## 发布新版本

版本号**禁止手改单点**。仓库内 [`.pi/skills/androidsigntool-release/SKILL.md`](.pi/skills/androidsigntool-release/SKILL.md) 是唯一权威流程，两个脚本承担全部动作：

| 脚本 | 职责 |
| :--- | :--- |
| `scripts/bump-version.ps1` | 把版本号同步到六处承载点并逐点回读校验；`-Verify` 为只读体检 |
| `scripts/release.ps1` | 收敛版本 → 预检 → 提交 → 打 tag → 推送触发 Actions → 盯构建 → 产物断言；`-DryRun` 全程不写远端 |

```powershell
# 体检：六点位是否一致、目标 tag 是否被占用
powershell -ExecutionPolicy Bypass -File scripts/bump-version.ps1 -Verify

# 收敛版本号（一次写全 + 行数守卫 + 越界自动回滚）
powershell -ExecutionPolicy Bypass -File scripts/bump-version.ps1 -Version X.Y.Z

# 发布（工作区需干净）
powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Version X.Y.Z -Note "发布说明"
```

> 本 README 刻意**不写死版本号**，避免成为 `bump-version.ps1` 之外的第七个版本承载点。发布说明、CHANGELOG 等一次性文本请走 `release.ps1 -Note`。

**GitHub Actions 前置 Secrets**（缺失则构建在签名阶段失败，只需配一次）：

| Secret | 值 |
| :--- | :--- |
| `TAURI_SIGNING_PRIVATE_KEY` | 本地 updater 私钥文件全文 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥口令（必须由人在真实终端输入，非交互 shell 会卡住） |

```powershell
gh secret list --repo ws1993/AndroidSignTool --json 'name' --jq '.[].name'
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo ws1993/AndroidSignTool
```

私钥与口令**只走管道或交互隐藏输入**，不进聊天记录、不落仓库文件、不写日志。

触发机制：推送 `v*` tag → `.github/workflows/release.yml` 自动「构建 → minisign 签名 → 发布 Release + `latest.json`」。`workflow_dispatch` 手动触发同样会以当前 `tauri.conf.json` 版本建标签并发布，纯试跑请用 `-DryRun`。

Workflow 的关键工程约束（踩坑实录，勿回退）：

- **不使用** `android-actions/setup-android@v3`（其安装的 `tools` 包已被 Google 下架 → 退出码 1、后续全 skip），改为显式探测 `sdkmanager` 并安装 `build-tools;35.0.0`，末尾**硬断言** `apksigner.jar` / `zipalign.exe` 存在。
- **JDK 前置于 sdkmanager**：`sdkmanager.bat` 自身需要 java。
- **必须显式给 `tagName` / `releaseName`**：`tauri-action` 缺这两者会打印 `skipping all uploads...` 且 **Run 仍然绿**，造成没有 Release 的假成功。
- **CI 绿灯不等于发版成功**：`release.ps1` 末尾的产物断言（`.exe` + `.sig` + `latest.json` 齐备）才是判定口径。
- **改 workflow 后同号重发要 `-Retag`**：workflow 从 tag 指向的提交读取，旧 tag 不会用新逻辑。

---

## 自动更新与产物校验

客户端通过 `tauri-plugin-updater` 检查：

```text
https://github.com/ws1993/AndroidSignTool/releases/latest/download/latest.json
```

安装包由 minisign 签名，公钥硬编码在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`；客户端只接受能用该公钥验证的更新包。构建侧要求 `bundle.createUpdaterArtifacts: true`，因此 Secrets 不齐时流水线会在签名步失败（属预期的快速失败）。

装机包与更新包同源，均产自 Actions 的 `windows-latest` 构建，本地 `npm run tauri:build` 的产物不带更新签名，不能用于验证更新链路。

---

## 常见问题

| 现象 | 原因与处置 |
| :--- | :--- |
| 打开应用后状态灯为红，提示工具缺失 | `resources/` 未装配。构建场景跑 `npm run prepare:tools`；用户侧请用官方安装包，勿直接跑 `tauri dev` 的裸二进制 |
| `prepare-tools` 报未找到 Android SDK | 设置 `ANDROID_HOME`，或用 `-BuildTools` 指定已装的 build-tools 版本 |
| `prepare-tools` 报未找到含 `jmods` 的 JDK | 需完整 JDK（非 JRE）；可用 `-JdkHome` 指定，或用 `JAVA_HOME` 指向 |
| apksigner 在裁剪 JRE 上运行失败 | jlink 模块集缺漏：把 `jdeps` 报出的缺失模块补进 `prepare-tools.ps1` 的保底列表后 `-Force` 重建 |
| 签名成功但设备提示安装失败 | 多为仅 V1 且 targetSdk ≥ 30；改用 V2 及以上策略（工具已会事前告警） |
| keystore 口令在其他机器/其他 Windows 用户下解不开 | DPAPI 绑定当前用户，属设计。请迁移 `.keystore` 文件本身与对应口令 |
| Actions 挂在签名步 `Wrong password for that key` | 私钥口令不对，**不要用 CI 重试试口令**（一轮十几分钟）：跑 `release.ps1 -Version X.Y.Z -SetupSecrets -SecretsOnly`，它先本地试签验口令再写 Secret |
| 构建绿了但 Release 不存在 | 检查 `tagName` / `releaseName` 是否在 workflow 中被改动；以 `gh release view vX.Y.Z` 与资产清单为准 |
| 客户端不弹更新 | 核对 `latest.json` 可访问、`pubkey` 与签名私钥同源、tag 版本高于本地已装版本 |
| 境外网络导致 `git ls-remote` 挂住 | 走本机代理并务必设 `NO_PROXY=127.0.0.1,localhost,::1`；`release.ps1` 已在开头自动探测与注入。注意 tag 存在性判定必须由**退出码门控**，网络失败不可误判为「标签已存在」 |

---

## 许可与品牌资产

品牌源文件（logo SVG、多尺寸图标、品牌规范）保存在 [`brand/`](brand)；应用图标由 `brand/` 输出后落到 `src-tauri/icons/`。[`design-demos/`](design-demos) 为历史设计快照，仅作决策留档，内容不随版本追改。

本仓库当前未声明开源许可证，代码按私有项目对待。
