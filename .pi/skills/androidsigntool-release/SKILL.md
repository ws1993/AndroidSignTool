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

