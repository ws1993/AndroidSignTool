#requires -Version 5.1
<#
prepare-tools.ps1 — 抽取签名工具链到 src-tauri/resources，供 Tauri 打包分发
  1) apksigner.jar  ← Android SDK build-tools/lib/apksigner.jar
  2) zipalign.exe   ← Android SDK build-tools/zipalign.exe
  3) jre/           ← jlink 裁剪的运行时（含 keytool.exe）
幂等：已存在且版本一致时跳过；-Force 强制重建。
#>
[CmdletBinding()]
param(
    [string]$BuildTools,      # 指定 build-tools 版本，如 34.0.0；缺省取最高版本
    [string]$JdkHome,         # 指定 JDK 目录（含 bin/jlink.exe）
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$res  = Join-Path $repo 'src-tauri\resources'
Write-Host "== AndroidSignTool 工具链准备 ==" -ForegroundColor Cyan
Write-Host "仓库: $repo"

# ---------- 1. 定位 Android SDK build-tools ----------
function Find-Sdk {
    $cands = @()
    foreach ($v in 'ANDROID_HOME','ANDROID_SDK_ROOT') {
        if (Test-Path "env:$v") { $cands += (Get-Item "env:$v").Value }
    }
    $cands += (Join-Path $env:LOCALAPPDATA 'Android\Sdk')
    $cands += (Join-Path $env:LOCALAPPDATA 'Android\sdk')
    $cands += 'C:\Android\Sdk'
    foreach ($c in $cands) {
        if ($c -and (Test-Path (Join-Path $c 'build-tools'))) { return $c }
    }
    return $null
}

$sdk = Find-Sdk
if (-not $sdk) { throw "未找到 Android SDK（可设置 ANDROID_HOME）。build-tools 是 apksigner/zipalign 的来源。" }
$btRoot = Join-Path $sdk 'build-tools'
$versions = Get-ChildItem $btRoot -Directory | ForEach-Object { $_.Name }
if (-not $BuildTools) {
    $BuildTools = $versions | Sort-Object { [version]($_ -replace '[^0-9.].*$','') } -Descending | Select-Object -First 1
}
$bt = Join-Path $btRoot $BuildTools
if (-not (Test-Path $bt)) { throw "build-tools 不存在: $bt（可用版本: $($versions -join ', ')）" }
Write-Host "SDK build-tools: $bt" -ForegroundColor Green

# ---------- 2. 拷贝 apksigner.jar / zipalign.exe ----------
New-Item -ItemType Directory -Force -Path (Join-Path $res 'lib') | Out-Null

$jarSrc = Join-Path $bt 'lib\apksigner.jar'
if (-not (Test-Path $jarSrc)) { throw "缺少 apksigner.jar: $jarSrc" }
Copy-Item $jarSrc (Join-Path $res 'lib\apksigner.jar') -Force
Write-Host "apksigner.jar  ->  $((Get-Item (Join-Path $res 'lib\apksigner.jar')).Length / 1MB) MB"

$zaSrc = Join-Path $bt 'zipalign.exe'
if (-not (Test-Path $zaSrc)) { throw "缺少 zipalign.exe: $zaSrc" }
Copy-Item $zaSrc (Join-Path $res 'zipalign.exe') -Force
Write-Host "zipalign.exe   ->  $((Get-Item (Join-Path $res 'zipalign.exe')).Length / 1KB) KB"

# zipalign/java 可能依赖的运行时 dll（白名单，避免把 clang/LLVM 等打进安装包）
$dllWhitelist = @('libwinpthread-1.dll','zlib1.dll','libstdc++6.dll','libgcc_s_dw2-1.dll')
foreach ($d in $dllWhitelist) {
    $src = Join-Path $bt $d
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $res $d) -Force
        Write-Host "附带 dll: $d"
    }
}

# ---------- 3. 定位 JDK（jlink / jmods） ----------
function Find-Jdk {
    $cands = @()
    if ($JdkHome) { $cands += $JdkHome }
    if (Test-Path 'env:JAVA_HOME') { $cands += (Get-Item 'env:JAVA_HOME').Value }
    foreach ($mv in '21','17','25','24','23','22','20','19','18') {
        $cands += "D:\DevOps\Java\jdk_$mv"
        $cands += "C:\Program Files\Java\jdk-$mv"
    }
    $cmd = Get-Command java -ErrorAction SilentlyContinue
    if ($cmd) {
        $home2 = Split-Path -Parent (Split-Path -Parent $cmd.Source)
        $cands += $home2
    }
    foreach ($c in $cands) {
        if ($c -and (Test-Path (Join-Path $c 'bin\jlink.exe')) -and (Test-Path (Join-Path $c 'jmods'))) { return $c }
    }
    return $null
}

$jdk = Find-Jdk
if (-not $jdk) { throw "未找到含 jmods 的 JDK（需要 JDK 9+，用于 jlink 裁剪运行时）。" }
Write-Host "JDK: $jdk" -ForegroundColor Green

$jlink = Join-Path $jdk 'bin\jlink.exe'
$jdeps = Join-Path $jdk 'bin\jdeps.exe'
$jreOut = Join-Path $res 'jre'

# ---------- 4. 由 jdeps 推导模块集，再并上保底模块 ----------
$base = @('java.base','java.logging','java.xml','java.desktop','java.sql','java.naming',
          'jdk.unsupported','jdk.crypto.ec','jdk.crypto.cryptoki','jdk.charsets')
$detected = @()
if (Test-Path $jdeps) {
    Write-Host "jdeps 分析 apksigner.jar 依赖模块..."
    $raw = & $jdeps --multi-release 21 --print-module-deps --ignore-missing-deps (Join-Path $res 'lib\apksigner.jar') 2>$null
    if ($LASTEXITCODE -ne 0) {
        $raw = & $jdeps --print-module-deps --ignore-missing-deps (Join-Path $res 'lib\apksigner.jar') 2>$null
    }
    if ($raw) {
        $detected = ($raw -join ',') -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
        Write-Host ("jdeps: " + ($detected -join ' ')) -ForegroundColor DarkGray
    }
}
$mods = @($base + $detected | Sort-Object -Unique)
Write-Host "jlink 模块: $($mods -join ', ')"

# ---------- 5. jlink 生成裁剪运行时 ----------
if ((Test-Path (Join-Path $jreOut 'bin\java.exe')) -and -not $Force) {
    Write-Host "jre 已存在，跳过（-Force 可重建）" -ForegroundColor Yellow
} else {
    if (Test-Path $jreOut) { Remove-Item $jreOut -Recurse -Force }
    & $jlink `
        --add-modules ($mods -join ',') `
        --output $jreOut `
        --strip-debug `
        --no-header-files `
        --no-man-pages `
        --compress=zip-6
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $jreOut 'bin\java.exe'))) {
        throw "jlink 生成失败（退出码 $LASTEXITCODE）"
    }
}

# ---------- 6. 自检 ----------
Write-Host "`n== 自检 ==" -ForegroundColor Cyan
$java = Join-Path $jreOut 'bin\java.exe'
$jar  = Join-Path $res 'lib\apksigner.jar'
$kt   = Join-Path $jreOut 'bin\keytool.exe'
$za   = Join-Path $res 'zipalign.exe'

$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'   # 原生命令向 stderr 输出用法提示，不应视为终止错误
& $java -jar $jar version 2>&1 | ForEach-Object { Write-Host "apksigner version: $_" }
$apksignerCode = $LASTEXITCODE
& $kt -list 2>&1 | Select-Object -First 1 | ForEach-Object { Write-Host "keytool: $_" }
$ktCode = $LASTEXITCODE
& $za 2>&1 | Select-Object -First 2 | ForEach-Object { Write-Host "zipalign: $_" }
$zaCode = $LASTEXITCODE
$ErrorActionPreference = $prev

if ($apksignerCode -ne 0) { throw "apksigner 在裁剪 JRE 上运行失败（退出码 $apksignerCode）—— 请把缺失模块加入保底模块列表" }
if ($ktCode -ne 0 -and $ktCode -ne 1) { throw "keytool 不可用（退出码 $ktCode）" }
Write-Host "自检退出码 → apksigner:$apksignerCode  keytool:$ktCode  zipalign:$zaCode（无参数/缺参时为 1，属用法提示）"

$size = (Get-ChildItem $jreOut -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("`nJRE 体积: {0:N1} MB" -f ($size/1MB)) -ForegroundColor Green
Write-Host "resources 就绪: $res" -ForegroundColor Green
