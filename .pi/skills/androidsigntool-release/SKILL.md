---
name: androidsigntool-release
description: AndroidSignTool 版本收敛与线上打包发布闭环。用户说「帮我更新到 X.Y.Z」「发版」「发布新版本」「打 tag 走 Actions」时使用；本 skill 同时约束版本号六点位一致性与 GitHub Actions 触发方式。
---

# AndroidSignTool 发布流程（版本号一致性 + GitHub Actions）

仓库：`ws1993/AndroidSignTool`（Tauri v2 + React，Windows NSIS 产物，GitHub Release + Tauri updater 热更新）

## 单一入口纪律

**版本号禁止手改单点。** 改版本只走脚本，发布只走 release.ps1：

| 脚本 | 职责 |
|---|---|
| `scripts/bump-version.ps1` | 六点位同步 + 逐点回读校验（`-Verify` 只读体检） |
| `scripts/release.ps1` | 收敛 → 预检 → 提交 → 打 tag → 推送触发 Actions → 盯构建 → 产物断言 |

**新增任何硬编码版本号 = 违规**。若将来某处必须写死版本，必须同步登记到 `bump-version.ps1` 的 `$Sites` 表，否则体检不过。

## 版本承载六位（真值清单，2026-11 现状均为 0.1.0）

1. `package.json` → 顶层 `"version"`
2. `package-lock.json` → 顶层 `"version"`（锚点：紧邻 `"lockfileVersion"`）**和** `packages[""]` 块内 `"version"`，共两处
3. `src-tauri/tauri.conf.json` → 顶层 `"version"`
4. `src-tauri/Cargo.toml` → `[package]` 的 `version`
5. `src-tauri/Cargo.lock` → `name = "android-sign-tool"` 块的 `version`
6. `src/App.tsx` → 顶栏字标 `<span className="ver">vX.Y.Z</span>`（UI 显示位，最易漏改）

> `design-demos/*.md` 里的 `v0.1.0` 是设计快照记录，**不追改**。

## 触发 GitHub Actions 的两种机制

workflow = `.github/workflows/release.yml`：
- `push: tags: 'v*'` → **正式发版**：tag 推上去即触发 构建→minisign 签名→Release+latest.json
- `workflow_dispatch` → **手动试跑**：网页 Actions → release → Run workflow，或 `gh workflow run release.yml --repo ws1993/AndroidSignTool --ref main`

## 标准动作：用户说「帮我更新到 X.Y.Z」

```powershell
# 1) 体检（必做，确认起点一致、tag 未占用）
powershell -ExecutionPolicy Bypass -File scripts/bump-version.ps1 -Verify
git tag --list "vX.Y.Z"; git ls-remote --tags origin "refs/tags/vX.Y.Z"

# 2) 六点位收敛（一次写全 + 回读校验）
powershell -ExecutionPolicy Bypass -File scripts/bump-version.ps1 -Version X.Y.Z

# 3) 发布（含提交/tag/推送/盯构建/产物断言）；Secrets 齐备时全自动
powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Version X.Y.Z -Note "发布说明"
```

同一步重复执行安全；tag 已存在时脚本直接拒跑（同版本号不可重发）。

## 一次性前置（缺则构建在签名阶段红）

`tauri.conf.json` 中 `createUpdaterArtifacts: true` → Actions 必须有：

| Secret | 值来源 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `%USERPROFILE%\.tauri\android-sign-tool-updater.key` 全文 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥口令（本机这把已确认**带口令**） |

- 检查：`gh secret list --repo ws1993/AndroidSignTool --json name --jq '.[].name'`
- 补配（口令不回显，由人在终端交互输入）：`gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo ws1993/AndroidSignTool`
- 私钥半段可代设：`Get-Content "$env:USERPROFILE\.tauri\android-sign-tool-updater.key" -Raw | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo ws1993/AndroidSignTool`
- **凭据纪律**：私钥/口令只走管道或交互隐藏输入，不进聊天记录、不落仓库文件、不写日志。

## 失败分诊

| 症状 | 根因 | 处方 |
|---|---|---|
| Actions 挂在 Build 步、报缺 private key / public key 不匹配 | Secrets 未配或与 pubkey 不同源 | 核对 `tauri.conf.json > plugins > updater > pubkey` 与私钥配对，重设 Secret |
| `gh secret set` 后仍读不到 | repo 名拼错 / gh 未登录 | `gh auth status`；`--repo ws1993/AndroidSignTool` |
| prepare-tools 步红 | ANDROID_HOME / JAVA_HOME 由 actions 提供 | 查 workflow 的 setup-android / setup-java 版本 |
| Release 缺 `latest.json`/`.exe`/`.sig` | updaterJson 或签名产物未生成 | release.ps1 已做产物断言并抛错；`gh run view <id> --log-failed` |
| 构建成功但客户端不弹更新 | endpoint/pubkey 或 tag 版本高于本地 | 核对 `releases/latest/download/latest.json` 可访问 |

排查入口：`gh run list --repo ws1993/AndroidSignTool --workflow release.yml --limit 5` → `gh run view <RunId> --repo ws1993/AndroidSignTool --log-failed`

## 验收口径（发布完成的定义）

`scripts/release.ps1` 已内建断言，全绿才算发完：
1. Run 退出码 0；
2. `gh release view vX.Y.Z` 存在，且资产含 `*.exe` + `*.sig` + `latest.json`；
3. 六点位回读一致（bump 阶段已校验）。

## 落地要点（本项目实测踩过的坑，勿回退）

1. **.ps1 必须 UTF-8 with BOM**：本机 Windows PowerShell 5.1 无 BOM 时按 ANSI/GBK 解码，含中文的脚本直接语法炸。脚本内中文注释是审计资产，不许为省事改英文。
2. **读项目文件禁止用 `Get-Content -Raw`**（5.1 同理会按 GBK 解 UTF-8，写回即污染中文）。一律 `[IO.File]::ReadAllText` + `[IO.File]::WriteAllText($p, $s, (New-Object Text.UTF8Encoding($保留原BOM)))`。
3. **`-replace` 与 `+` / `,` 混用会静默不替换**（不报错、原文返回）。所有 pattern/replacement 先赋值给变量再调用，或直接用 `[regex]::Replace`。
4. **`$ErrorActionPreference='Stop'` 下 git/gh 的 stderr 进度会抛 NativeCommandError**：git push/commit、gh run watch 正常输出就走 stderr。脚本已用 `Native`（捕获）/`Stream`（`Out-Host` 实时透传并只返回退出码）两个包装解决；新增外部命令调用必须走这两个包装，且用返回码判断成败，不要裸用 `$LASTEXITCODE`（子脚本未显式 `exit` 时它是陈旧值）。
5. **守卫是内存式的**：`bump-version.ps1` 写入前留快照，写后逐行比对改动行数（`package-lock.json` 必须 2 行、其余各 1 行），超出即判定编码/锚点污染并**自动回滚六个文件**；不依赖 git，因此可以连续 bump，但 `release.ps1` 仍要求工作区干净（无关改动先自行提交，或加 `-Force` 连带提交）。
6. **`release.ps1 -SetupSecrets` 会先做密钥配对预检**：用私钥+口令本地试签，再读 `.sig` 头部 keyId 与 `tauri.conf.json > plugins > updater > pubkey` 的 `9966...` 比对；口令错或密钥不同源都会**在写任何 Secret 之前**中止。
7. **口令只能由人在真实终端输入**：`release.ps1 -SetupSecrets` 用 `Read-Host -AsSecureString` 取口令，Agent 的非交互 shell 里会卡住。首次发版请在自己终端跑：
   ```powershell
   cd F:\AI\AndroidSignTool
   powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Version 0.1.0 -SetupSecrets
   ```
   或只补口令这一半（口令全程不回显、不进聊天记录）：
   ```powershell
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo ws1993/AndroidSignTool
   ```
   之后 Agent 侧即可无人值守跑完：`scripts\release.ps1 -Version 0.1.0`。
   已代设的一半：`TAURI_SIGNING_PRIVATE_KEY`（由本地私钥文件管道写入，值未回显）。
8. **出口必须走本机代理**：GitHub 属境外，实测直连 `git ls-remote` 会挂住（凭据/TCP 超时），曾因此把"查询失败"误判成"标签已存在"。`release.ps1` 现已在开头自动探测 `127.0.0.1:25378` 并会话级注入 `HTTP(S)_PROXY` + `NO_PROXY=127.0.0.1,localhost,::1`；标签存在性判定也已改为**退出码门控**（`ls-remote` 非 0 直接中止且不做任何远端写入）。手动敲 gh/git 排查时同样先设这几个变量。

## 冒烟测试清单（改动脚本后必跑，均已在 2026-11 验证通过）

```powershell
powershell -File scripts\bump-version.ps1 -Verify              # 六点位一致
powershell -File scripts\bump-version.ps1 -Version 0.9.9       # 写入 + 行数守卫
powershell -File scripts\bump-version.ps1 -Version 0.1.0       # 回退，git diff 须为空
powershell -File scripts\release.ps1 -Version 0.1.0 -DryRun    # 全链路预演，不写远端
```

`-DryRun` 的正确终态：代理注入提示 → 版本 SKIP/收敛 → 打印缺失 Secrets → `[DryRun] 计划: ...` → `DryRun 结束：未做任何远端写入`，退出码 0。


## CI 侧踩坑（2026-11-06 v0.1.0 首发实测）

9. **`android-actions/setup-android@v3` 在 windows-latest 已不可用**：它会安装 Google 已下架的 `tools` 包 → `Warning: Failed to find package 'tools'` → 退出码 1，后续步骤全部 skipped。已从 workflow 移除，改为 `Ensure Android build-tools 35.0.0` 步骤：先探测 runner 自带 SDK（`ANDROID_HOME`/`ANDROID_SDK_ROOT`/`C:\Android\android-sdk`，递归找 `sdkmanager.bat`），探不到才用官方直链 `commandlinetools-win-11076708_latest.zip` 兜底，然后 `--licenses`（`Get-Content yes.txt | & $mgr --sdk_root=$sdk --licenses` 喂 y）+ `--install "build-tools;35.0.0"`，末尾**硬断言** `lib\apksigner.jar` 与 `zipalign.exe` 存在。该步 `EAP='Continue'`（sdkmanager 大量 Warning 走 stderr），成败只由产物断言决定。
10. **JDK 必须前置于 sdkmanager**：`sdkmanager.bat` 自身要 java，故 `Setup JDK 21` 已上移到 Android 步骤之前。
11. **workflow 是从 tag 指向的那个提交读取的**：改了 `.github/workflows/release.yml` 之后，旧 tag 仍指向旧提交，重跑不会用新逻辑。必须 `release.ps1 -Version X.Y.Z -Retag`（回收本地+远端同名标签、在新 HEAD 重打再推）。若该 tag 已产生 Release，`-Retag` 会**拒绝**并要求你先 `gh release delete X.Y.Z --yes`（删标签会连带删 Release，故必须显式确认）。

### 失败重发标准动作

```powershell
gh run view <RunId> --repo ws1993/AndroidSignTool --log-failed   # 定位
git checkout -- .; 修 workflow/代码 → 提交 → push origin main
powershell -File scripts\release.ps1 -Version 0.1.0 -Retag        # 同号重发
```
12. **签名阶段 `Wrong password for that key` ≠ 流水线坏**：v0.1.0 第二次发版（Run 42160977471）中 `Build + sign + release` 已产出 `AndroidSignTool_0.1.0_x64-setup.exe (34.95 MiB)`，只在最后签名一步因口令解不开私钥而失败。这类问题**绝不要用 CI 重试来试口令**（一轮 15 分钟），改跑：
    ```powershell
    powershell -File scripts\release.ps1 -Version 0.1.0 -SetupSecrets -SecretsOnly
    ```
    它会先本地试签验口令，通过才写 Secret，写完即退出（不推标签），再由 `release.ps1 -Version 0.1.0` 触发发布。失败会在**写任何 Secret 之前**中止，故可反复输入直到通过。
    > 注：该本地试签同时完成**两件事**——口令能解开私钥 + 试签产物的 keyId 与 `tauri.conf.json` 配置的 pubkey（`99660971DE1397D0`）同源。故 `-SetupSecrets` 一次通过即代表签名链完整可用。私钥是 `ed25sk…` 加密格式，armor 首行不含 keyId，因此无法在不知道口令的情况下静态验配对，只能靠这条试签。
13. **tauri-action 缺 `tagName` 会「静默不上传」且 Run 仍然绿**：v0.1.0 第三次发版（Run 42172519310）口令已对、`.exe`(34.95 MiB) 与 `.exe.sig` 都已产出，日志里却是 `No releaseId or tagName provided, skipping all uploads...` → **没有 Release**，退出码却为 0。已在 `with:` 补 `tagName: 'v__VERSION__'` 与 `releaseName`。教训：**不能只看 CI 绿灯判定发版成功**，必须断言 Release 资产——`release.ps1` 步骤 5 的产物断言正是为此而设（缺 `latest.json`/`.exe`/`.sig` 任一即抛错）。
14. **注意 `workflow_dispatch` 现在也会发布**：`tagName` 用了 `__VERSION__` 占位符，手动触发时会以当前 `tauri.conf.json` 版本建/复用标签并发布 Release。想纯试跑流水线请用 `release.ps1 -Version X.Y.Z -DryRun`（全程不写远端）。

## 口令从哪来（v0.1.0 首发实测结论）

15. **口令不是"生成"出来的，也不能从私钥反推**：它是当初 `tauri signer generate` 那一步**由人输入**的解锁密码。填一个新随机 GUID 必然 `Wrong password for that key`（GUID 永不重复）。
16. **本机原口令有留档**：`%USERPROFILE%\.tauri\android-sign-tool-updater.key.password`（32 字符、无尾部换行，与 `.key`/`.key.pub` 同批生成）。已用该值设好 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，并经本地试签确认口令可解锁、签名 keyId 与配置公钥同源。
    - hygiene 提醒：这是**明文落盘**的口令文件，在 `~/.tauri` 下（不在仓库内，未被提交），建议尽快导入密码管理器后删档或改口令。
    - 若真丢了：`npx tauri signer generate -w ~/.tauri/android-sign-tool-updater.key -f` 重新生成（`-f` 覆盖，同时产出 `.pub`），把新 pubkey 写进 `tauri.conf.json > plugins > updater > pubkey`，再 `-SetupSecrets` 重设两个 Secret。**注意**：若已有用户装了旧版，旧版永远收不到新版更新，只能引导重装；v0.1.0 是首个发布，无此负担。
17. **`.sig` 真实格式与 keyId 提取**（写解析前必须先取证，别照抄规范）：`tauri signer sign` 产出的 `.sig` 是**单行 base64 包裹的 armor 文本**，解包后签名行再 base64 解出 74 字节 = `["E" "D"][keyId 8字节 小端][签名 64字节]`。要点：算法字节是 `0x45 0x44`（**不是** `0xED`），且 keyId **小端存储**，需 `[Array]::Reverse` 后才等于 `minisign public key: 99660971DE1397D0` 这种大写十六进制。零口令的快速判据：`.key.pub` 与 `tauri.conf.json` 的 `pubkey` 字符串应完全相同（`release.ps1` 步骤 2 已内置该检查）。
18. **PowerShell 逗号 = 数组运算符**：`--json status,conclusion` 会被拆成两个参数，经 `Native`/`@splatting` 转发后 gh 报 `Unknown JSON field: "status conclusion"` 或 `accepts at most 1 arg(s)`。**凡逗号列表必须加引号** `--json 'status,conclusion'`。
19. **`gh run watch` 退出码非零 ≠ 构建失败**：实测 API 端点 `/actions/runs/{id}` 会随机 `EOF` 而 `gh run list` 正常。曾据此误删本地标签（远端删除被 TLS 重置挡住才没造成实际损失）。现步骤 5 已改为：watch 退出码仅供参考，**必须回查真实 `status/conclusion`（view 与 list 双通道互备）**；结论未知时**绝不回收标签**，而是抛错要求人工复核。
20. **本机代理对 GitHub 的 TLS 隧道会随机重置**（`OpenSSL SSL_connect: SSL_ERROR_SYSCALL`，以及 gh 的 `unexpected EOF`），同一命令重试即可通过。凡幂等的远端写操作一律走 `PushRetry`（默认 4 次、8 秒退避）；读操作在各处带回重试循环。**发版前先 `curl.exe -x http://127.0.0.1:25378 -s -o NUL -w "%{http_code}" https://api.github.com/zen` 探一下**，非 200 就等网络平稳再发，否则会被误判成流水线故障。
