# AndroidSignTool 线上一键发布：版本收敛 → 签名凭据预检 → 提交 → 打 tag → 推送触发 Actions → 盯构建 → 校验产物。
# 用法:
#   powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Version 0.1.1
#   powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Version 0.1.1 -DryRun        # 只看计划
#   powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Version 0.1.1 -SetupSecrets  # 同时配 GitHub Secrets（口令交互式输入，不回显）
#   powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Version 0.1.1 -Note "修复对齐"
#   powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Version 0.1.0 -Retag        # CI 失败修复后，同号重推
#   powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Version 0.1.0 -SetupSecrets  # 重设签名凭据：先本地试签验口令，通过才写 Secret（口令打错时用这条，2 秒出结论，不必烧 CI）
# 纪律: 私钥/口令只经管道与进程参数传递，不打印、不落盘、不写入日志。
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Repo = 'ws1993/AndroidSignTool',
    [string]$Branch = 'main',
    [string]$Note = 'Android APK 签名工具 Windows 版',
    [switch]$DryRun,
    [switch]$SetupSecrets,
    [switch]$Force,
    [switch]$Retag,
    [switch]$SecretsOnly
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# 出口规则：GitHub 属境外，本机直连 git/gh 易卡凭据或超时（实测 ls-remote 直连会挂住），故先探测本机代理并会话级注入
if (Test-NetConnection 127.0.0.1 -Port 25378 -InformationLevel Quiet -WarningAction SilentlyContinue) {
    $env:HTTP_PROXY = 'http://127.0.0.1:25378';  $env:HTTPS_PROXY = 'http://127.0.0.1:25378'
    $env:http_proxy = 'http://127.0.0.1:25378';  $env:https_proxy = 'http://127.0.0.1:25378'
    $env:NO_PROXY = '127.0.0.1,localhost,::1';   $env:no_proxy = '127.0.0.1,localhost,::1'
    "已注入会话级代理 127.0.0.1:25378（NO_PROXY 含回环，不影响本地服务）"
} else {
    "本机代理 25378 未监听，本次 git/gh 走直连"
}

$Tag = "v$Version"
$KeyFile = Join-Path $env:USERPROFILE '.tauri\android-sign-tool-updater.key'

function Step($msg) { "`n=== $msg ==="; }

# 外部命令包装：PowerShell 5.1 在 $ErrorActionPreference='Stop' 下会把原生命令的 stderr（git/gh 的正常进度输出）
# 判为 NativeCommandError 而中断脚本，故两类调用统一降 EAP 后再取退出码。
function Native {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Cmd
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $out = & $Exe @Cmd 2>&1 } finally { $ErrorActionPreference = $prev }
    $script:NativeCode = $LASTEXITCODE
    foreach ($l in @($out)) {
        if ($null -eq $l) { continue }
        if ($l -is [System.Management.Automation.ErrorRecord]) { [string]$l.Exception.Message } else { [string]$l }
    }
}

# 需要实时输出（push / watch / commit）时用 Stream：直接透传，不缓冲
function Stream([scriptblock]$Cmd) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Cmd | Out-Host } finally { $ErrorActionPreference = $prev }
    $LASTEXITCODE
}

# 推送退避重试：本机代理对 GitHub 的 TLS 隧道会随机重置（实测 SSL_ERROR_SYSCALL），push 本身幂等可安全重试
function PushRetry([string[]]$GitArgs, [int]$Tries = 4, [int]$DelaySec = 8) {
    for ($n = 1; $n -le $Tries; $n++) {
        if ($n -gt 1) { "  第 $n 次重试推送（等待 ${DelaySec}s）..." }
        $code = Stream { git push @GitArgs }
        if ($code -eq 0) { return 0 }
        Start-Sleep -Seconds $DelaySec
    }
    return $code
}

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "版本号格式非法: $Version（要求 x.y.z）" }

Step '0/5 工作区状态'
if (-not (Test-Path (Join-Path $Root '.github\workflows\release.yml'))) { throw '发布 workflow 缺失' }
$dirty = @(Native git status --porcelain)
if ($dirty) {
    "工作区存在未提交改动:"
    $dirty | ForEach-Object { "  $_" }
    if (-not $Force) { throw '为避免把无关改动带进 Release，请先自行提交或还原；确需连带提交加 -Force' }
}

Step '1/5 版本一致性收敛（六点位单入口）'
& (Join-Path $PSScriptRoot 'bump-version.ps1') -Version $Version
if ($LASTEXITCODE -ne 0) { throw "bump-version 退出码 $LASTEXITCODE" }

Step '2/5 GitHub 鉴权与签名 Secrets 预检'
$AuthCode = Stream { gh auth status }
if ($AuthCode -ne 0) { throw 'gh CLI 未登录，先执行: gh auth login' }
$SecretList = @(Native gh secret list --repo $Repo --json name --jq '.[].name')
$Need = @('TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD')
$Missing = @($Need | Where-Object { $SecretList -notcontains $_ })
if ($Missing) { "缺失 Secrets: $($Missing -join ', ')" } else { 'Secrets 齐备' }

# 零口令前置校验：本地 .pub 侧车必须与 tauri.conf.json 配置的 pubkey 一致
# （不一致意味着换了私钥却忘了更新公钥，签出的更新客户端必然验签失败；此项无需口令即可判定）
$PubSidecar = "$KeyFile.pub"
if (Test-Path $PubSidecar) {
    $confPubNow = ([IO.File]::ReadAllText((Join-Path $Root 'src-tauri\tauri.conf.json')) | ConvertFrom-Json).plugins.updater.pubkey
    $sideRaw = ([IO.File]::ReadAllText($PubSidecar)).Trim()
    $sideSame = ($sideRaw -eq $confPubNow)
    if (-not $sideSame) {
        try {
            $sideTxt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($sideRaw)).Trim()
            $confTxt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($confPubNow)).Trim()
            $sideSame = ($sideTxt -eq $confTxt)
        } catch { }
    }
    if ($sideSame) { '本地密钥对与 tauri.conf.json 公钥一致（零口令校验通过）' }
    else { throw '本地 .pub 侧车与 tauri.conf.json 的 pubkey 不一致 → 该私钥签出的更新客户端验签必失败。请重新生成密钥并同步公钥，或改回原密钥。已中止，未做任何远端写入' }
}

if (($Missing -or $SetupSecrets) -and -not $DryRun) {
    if (-not $SetupSecrets) {
        throw '缺少 updater 签名 Secrets，直接推 tag 会让 Actions 在签名阶段失败。加 -SetupSecrets 由本脚本补配（私钥走管道、口令交互式不回显）。'
    }
    if (-not (Test-Path $KeyFile)) { throw "找不到 updater 私钥: $KeyFile" }
    $Pwd = Read-Host "updater 私钥口令（输入不回显，仅用于设置 GitHub Secret）" -AsSecureString
    $Plain = $null
    try {
        $Ptr = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($Pwd)
        try { $Plain = [Runtime.InteropServices.Marshal]::PtrToStringUni($Ptr) }
        finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($Ptr) }

        # 本地试签：验证口令能解开这把私钥（口令错误则立刻中止，不污染远端 Secret）
        $ProbeDir = if ($env:PI_SCRATCH_DIR -and (Test-Path $env:PI_SCRATCH_DIR)) { $env:PI_SCRATCH_DIR } else { $env:TEMP }; $Probe = Join-Path $ProbeDir "rel-probe-$Tag.txt"
        'probe' | Set-Content $Probe -Encoding ascii
        $SignCode = Stream { & npx tauri signer sign $Probe --private-key-path $KeyFile --password $Plain }
        if ($SignCode -ne 0) { throw '口令无法解开 updater 私钥（或私钥与 tauri.conf.json 的 pubkey 不匹配），已中止，未写入任何 Secret' }
        "本地试签通过（口令与私钥匹配）"
        # 配对校验：试签产物 .sig 的 untrusted comment 带 keyId，必须等于 tauri.conf.json 里配置的 pubkey keyId
        $SigFile = "$Probe.sig"
        if (-not (Test-Path $SigFile)) { throw '试签未生成 .sig，无法校验密钥配对，已中止' }
        # 真实格式：.sig = 单层 base64 包裹的 armor 文本；签名行解出 74 字节 = ["ED" 2字节][keyId 8字节 小端][签名 64字节]
        $sigArmor = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(([IO.File]::ReadAllText($SigFile)).Trim())) -split "`r?`n"
        $sigId = $null
        foreach ($ln in $sigArmor) {
            $cand = "$ln".Trim()
            if ($cand.Length -lt 24) { continue }
            try { $raw = [Convert]::FromBase64String($cand) } catch { continue }
            if ($raw.Length -ge 10 -and $raw[0] -eq 0x45 -and $raw[1] -eq 0x44) {
                $rev = $raw[2..9]; [Array]::Reverse($rev)
                $sigId = ($rev | ForEach-Object { $_.ToString('X2') }) -join ''
                break
            }
        }
        # 兜底：armor 注释里直接写明的 16 位 hex keyId
        if (-not $sigId) { foreach ($ln in $sigArmor) { if ("$ln" -match '([0-9A-Fa-f]{16})') { $sigId = $Matches[1].ToUpper(); break } } }
        $confJson = [IO.File]::ReadAllText((Join-Path $Root 'src-tauri\tauri.conf.json')) | ConvertFrom-Json
        $confPub = $confJson.plugins.updater.pubkey
        $pubText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($confPub))
        $pubId = if ($pubText -match 'minisign public key:\s*([0-9A-Fa-f]{16})') { $Matches[1].ToUpper() } else { $null }
        if ($sigId -and $pubId) {
            if ($sigId -ne $pubId) { throw "密钥不配对：试签 keyId=$sigId 而应用配置 pubkey=$pubId → 客户端 updater 验签必然失败，已中止且未写入任何 Secret" }
            "密钥配对校验通过：试签 keyId 与 tauri.conf.json pubkey 同源（$pubId）"
        } else {
            "告警：未能解析出可比对的 keyId（sig=[$sigId] conf=[$pubId]），跳过配对预检；口令已验证可用，若密钥不同源会在 CI 构建阶段暴露"
        }

        $KeyCode = Stream { [IO.File]::ReadAllText($KeyFile) | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo $Repo }
        if ($KeyCode -ne 0) { throw '设置 TAURI_SIGNING_PRIVATE_KEY 失败' }
        $PwdCode = Stream { gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo $Repo --body $Plain }
        if ($PwdCode -ne 0) { throw '设置 TAURI_SIGNING_PRIVATE_KEY_PASSWORD 失败' }
        "Secrets 已写入仓库 $Repo（值未回显）"
    }
    finally {
        if ($Plain) { $Plain = $null }
        Remove-Variable Plain -ErrorAction SilentlyContinue
        Get-ChildItem $ProbeDir -Filter "rel-probe-$Tag.txt*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    }
    $After = @(Native gh secret list --repo $Repo --json name --jq '.[].name')
    foreach ($n in $Need) { if ($After -notcontains $n) { throw "写入后复查仍缺 $n" } }
    'Secrets 复查通过'
    if ($SecretsOnly) { "凭据已重设并通过本地试签验证。发布请再跑: scripts\release.ps1 -Version $Version$(if ($Retag) { ' -Retag' })"; exit 0 }
}

Step '3/5 提交与标签'
$changed = @(Native git status --porcelain | ForEach-Object { ($_ -split '\s+',2)[-1] })
if ($changed.Count -gt 0) {
    "将提交文件: $($changed -join ' ')"
    if ($DryRun) { '[DryRun] 跳过写入' } else {
        $AddCode = Stream { git add -A }
        $CommitCode = Stream { git commit -m "chore(release): $Tag" }
        if ($AddCode -ne 0 -or $CommitCode -ne 0) { throw "提交失败 (add=$AddCode commit=$CommitCode)" }
    }
} else { "无版本改动，只推 tag" }

if ($Retag) {
    "Retag 模式：回收 $Tag 后重推（CI 失败已修复、需同号重发时使用）"
    if (@(Native git tag --list $Tag).Count -gt 0) { Stream { git tag -d $Tag } | Out-Null }
    $rmOut = @(Native git ls-remote --tags origin "refs/tags/$Tag")
    $rmCode = $script:NativeCode
    if ($rmCode -ne 0) { throw "无法确认远端标签（git ls-remote 退出码 $rmCode）：$($rmOut -join ' | ') → 已中止，未做任何远端写入" }
    if ($rmOut.Count -gt 0) {
        $relView = @(Native gh release view $Tag --repo $Repo)
        if ($script:NativeCode -eq 0) { throw "远端已存在 $Tag 的 Release。请先用 gh release delete $Tag --yes 删除（Release 随标签删除而消失，故必须显式确认）" }
        $delCode = PushRetry @('origin', ":refs/tags/$Tag")
        if ($delCode -ne 0) { throw "删除远端标签 $Tag 失败（退出码 $delCode），已中止" }
        "远端旧标签已回收"
    }
} else {
    if (@(Native git tag --list $Tag).Count -gt 0) { throw "本地标签 $Tag 已存在，发新版请递增版本号，或加 -Retag 重推同号。" }
    $remoteOut = @(Native git ls-remote --tags origin "refs/tags/$Tag")
    $remoteCode = $script:NativeCode
    if ($remoteCode -ne 0) { throw "无法确认远端标签（git ls-remote 退出码 $remoteCode，多为网络或凭据问题）：$($remoteOut -join ' | ') → 已中止，未做任何远端写入" }
    if ($remoteOut.Count -gt 0) { throw "远端已存在标签 $Tag（可能已发布过），发新版请递增版本号，或加 -Retag 重推同号。" }
}
if ($DryRun) { "[DryRun] 计划: tag $Tag -> push origin $Branch -> push origin $Tag -> gh run watch" }

Step '4/5 推送触发 Actions'
if ($DryRun) { "DryRun 结束：未做任何远端写入。" ; exit 0 }
$PushCode = PushRetry @('origin', $Branch)
if ($PushCode -ne 0) { throw "推送 $Branch 失败，未推 tag，可安全重试" }
Stream { git tag -a $Tag -m $Note } | Out-Null
$TagPushCode = PushRetry @('origin', $Tag)
if ($TagPushCode -ne 0) { throw "推送 tag $Tag 失败（远端分支已更新）。修正后重试: git push origin $Tag" }
"已推送 $Tag，Actions 应已启动"

Step '5/5 盯构建与产物校验'
$RunId = $null
Start-Sleep -Seconds 10
$RunIdRaw = @(Native gh run list --repo $Repo --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId'); $RunId = if ($RunIdRaw.Count -ge 1) { "$($RunIdRaw[0])".Trim() } else { $null }
if (-not $RunId) { throw '推送 tag 后 10 秒内未见到 Actions 运行记录；检查 Actions 是否被禁用或 tag 过滤未命中：gh run list --limit 5' }
Native gh run list --repo $Repo --workflow release.yml --limit 3
$Watch = Stream { gh run watch $RunId --repo $Repo --exit-status }
$Watch = [int]$Watch
"构建监控退出码 = $Watch（0 为成功）  RunId = $RunId"
if ($Watch -ne 0) {
    "失败排查: gh run view $RunId --repo $Repo --log-failed"
    "回收标签以便同号重试: git tag -d $Tag; git push origin `":refs/tags/$Tag`""
    Stream { git tag -d $Tag } | Out-Null
    PushRetry @('origin', ":refs/tags/$Tag") | Out-Null
    "注意：GitHub 上可能残留同名 Draft Release，请在页面删除后重推 tag。"
    throw 'Actions 未成功，Release 产物不完整；tag 已回收，修复后重跑本脚本即可'
}
$Assets = @(Native gh release view $Tag --repo $Repo --json assets --jq '.assets[].name')
"Release 产物: $($Assets -join ' | ')"
foreach ($need in @('latest.json')) { if ($Assets -notcontains $need) { throw "缺少关键产物 $need（updater 热更新会失效）" } }
if (-not ($Assets | Where-Object { $_ -like '*.exe' })) { throw '缺少 NSIS 安装包产物 .exe' }
if (-not ($Assets | Where-Object { $_ -like '*.sig' })) { throw '缺少 updater 签名产物 .sig（签名环节未生效）' }
Native gh release view $Tag --repo $Repo
"发布完成: https://github.com/$Repo/releases/tag/$Tag"
