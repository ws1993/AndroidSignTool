# AndroidSignTool 版本号单点入口：一次性同步全部硬编码位并校验一致性。
# 用法:
#   powershell -ExecutionPolicy Bypass -File scripts/bump-version.ps1 -Version 0.1.1
#   powershell -ExecutionPolicy Bypass -File scripts/bump-version.ps1 -Verify        # 只读体检
# 规则: 禁止手改单点版本号；改版本只走本脚本（见 .pi/skills/androidsigntool-release/SKILL.md）。
[CmdletBinding()]
param(
    [string]$Version,
    [switch]$Verify
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

# 版本硬编码位（新增页面/组件禁止再写死版本号，必须从这里取值）
$Sites = @(
    @{ Path = 'package.json';               Kind = 'json-root'    },
    @{ Path = 'package-lock.json';          Kind = 'lock-root'    },
    @{ Path = 'src-tauri\tauri.conf.json';  Kind = 'json-root'    },
    @{ Path = 'src-tauri\Cargo.toml';       Kind = 'toml-crate'   },
    @{ Path = 'src-tauri\Cargo.lock';       Kind = 'lock-crate'   },
    @{ Path = 'src\App.tsx';                Kind = 'ui-badge'     }
)
$CrateName = 'android-sign-tool'

function Get-Detect([string]$Text, [string]$Kind) {
    switch ($Kind) {
        'json-root'  { if ($Text -match '(?m)^  "version":\s*"([^"]+)"') { return $Matches[1] } }
        'lock-root'  { if ($Text -match ('(?m)^  "version":\s*"([^"]+)",\s*\r?\n  "lockfileVersion"')) { return $Matches[1] } }
        'toml-crate' { if ($Text -match '(?m)^version\s*=\s*"([^"]+)"') { return $Matches[1] } }
        'lock-crate' { if ($Text -match ('(?m)^name = "' + [regex]::Escape($CrateName) + '"\s*\r?\nversion = "([^"]+)"')) { return $Matches[1] } }
        'ui-badge'   { if ($Text -match '<span className="ver">v([0-9][^<]*)</span>') { return $Matches[1] } }
    }
    return $null
}

function Set-Site([string]$Text, [string]$Kind, [string]$Old, [string]$New) {
    $e = [regex]::Escape($Old)
    # 注意：PowerShell 中 -replace 与 + / , 的优先级混用会静默不替换，必须先组装 $pat/$rep 再调用
    $pat = ''; $rep = ''
    switch ($Kind) {
        'json-root' {
            $pat = '(?m)^  "version":\s*"' + $e + '"'
            $rep = '  "version": "' + $New + '"'
        }
        'lock-root' {
            # 按行定位文件头区（顶层 version + packages[""] 根块 version），避开正则引号歧义
            $nl = if ($Text.Contains("`r`n")) { "`r`n" } else { "`n" }
            $lines = $Text -split "`r`n|`n"
            $limit = [Math]::Min(25, $lines.Count)
            $vp = '^(\s*"version":\s*")' + $e + '("(\s*,)?)$'
            for ($i = 0; $i -lt $limit; $i++) {
                if ($lines[$i] -match $vp) { $lines[$i] = ($Matches[1] + $New + $Matches[2]) }
            }
            return ($lines -join $nl)
        }
        'toml-crate' {
            $pat = '(?m)^version\s*=\s*"' + $e + '"'
            $rep = 'version = "' + $New + '"'
        }
        'lock-crate' {
            $pat = '(?m)(^name = "' + [regex]::Escape($CrateName) + '"\s*\r?\nversion = )"' + $e + '"'
            $rep = '${1}"' + $New + '"'
            $cm = [regex]::Matches($Text, $pat)
            if ($cm.Count -ne 1) { throw "Cargo.lock 中 $CrateName 的 version 锚点命中 $($cm.Count) 处（应为 1），已中止" }
            return [regex]::Replace($Text, $pat, $rep)
        }
        'ui-badge' {
            $pat = '<span className="ver">v' + $e + '</span>'
            $rep = '<span className="ver">v' + $New + '</span>'
        }
        default { return $Text }
    }
    return [regex]::Replace($Text, $pat, $rep)
}

$Texts = @{}
$HasBom = @{}
foreach ($s in $Sites) {
    $full = Join-Path $Root $s.Path
    if (-not (Test-Path $full)) { throw "缺少版本承载文件: $($s.Path)" }
    $bytes = [IO.File]::ReadAllBytes($full)
    $HasBom[$s.Path] = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $Texts[$s.Path] = [IO.File]::ReadAllText($full)
}
$Detected = @{}
foreach ($s in $Sites) {
    $v = Get-Detect $Texts[$s.Path] $s.Kind
    if (-not $v) { throw "解析失败，未能从 $($s.Path) 定位版本锚点（文件结构可能已变，请先更新本脚本锚点）" }
    $Detected[$s.Path] = $v
}
$Distinct = @($Detected.Values | Select-Object -Unique)

if ($Verify) {
    "当前版本位读取结果:"
    foreach ($k in $Detected.Keys) { "  {0,-28} {1}" -f $k, $Detected[$k] }
    if ($Distinct.Count -eq 1) { "PASS  全点一致 = $($Distinct[0])"; exit 0 }
    "FAIL  版本位不一致: $($Distinct -join ' | ')  → 用 -Version 指定目标版本执行本脚本以收敛"
    exit 1
}

if (-not $Version) { throw '必须提供 -Version x.y.z，或使用 -Verify 做只读体检' }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "版本号格式非法: $Version（要求 x.y.z，如 0.1.1）" }

if ($Distinct.Count -ne 1) {
    throw "检测到现有版本位不一致（$($Distinct -join ' | ')）。先人工确认哪一处是真值，再收敛，避免把错值带进 Release。"
}
$Old = $Distinct[0]

if ($Old -eq $Version) {
    "SKIP  所有版本位已是 $Version，无需改动"
    exit 0
}

# 每类版本位的预期变更行数（写后内存守卫用）
$Expect = @{ 'json-root' = 1; 'lock-root' = 2; 'toml-crate' = 1; 'lock-crate' = 1; 'ui-badge' = 1 }
# 写前快照，用于污染时的内存回滚
$OrigTexts = @{}
foreach ($s in $Sites) { $OrigTexts[$s.Path] = $Texts[$s.Path] }
foreach ($s in $Sites) {
    $new = Set-Site $Texts[$s.Path] $s.Kind $Old $Version
    $check = Get-Detect $new $s.Kind
    if ($check -ne $Version) { throw "写入 $($s.Path) 后回读失败（读到 '$check'），已中止，未落盘任何文件" }
    if ($s.Kind -eq 'lock-root') {
        $hits = ([regex]::Matches($new, ('"version": "' + [regex]::Escape($Version) + '"'))).Count
        if ($hits -lt 2) { throw "package-lock.json 新版本只命中 $hits 处（应为 2：顶层 + packages 根块），已中止" }
    }
    $Texts[$s.Path] = $new
}

foreach ($s in $Sites) {
    $full = Join-Path $Root $s.Path
    $enc = New-Object System.Text.UTF8Encoding([bool]$HasBom[$s.Path])
    [IO.File]::WriteAllText($full, $Texts[$s.Path], $enc)
}

"已同步版本 $Old -> $Version，逐点回读校验:"
foreach ($s in $Sites) {
    $back = Get-Detect ([IO.File]::ReadAllText((Join-Path $Root $s.Path))) $s.Kind
    if ($back -ne $Version) { throw "落盘后校验失败: $($s.Path) = $back" }
    "  OK {0,-28} {1}" -f $s.Path, $back
}

# 编码/锚点污染守卫：写入前后逐行比对，只允许预期行数发生变化（不依赖 git）
$GuardFail = $null
foreach ($s in $Sites) {
    $before = $OrigTexts[$s.Path] -split "`r`n|`n"
    $after  = ([IO.File]::ReadAllText((Join-Path $Root $s.Path)) -split "`r`n|`n")
    if ($before.Count -ne $after.Count) { $GuardFail = "$($s.Path) 行数由 $($before.Count) 变为 $($after.Count)，判定结构污染"; break }
    $dc = 0
    for ($j = 0; $j -lt $before.Count; $j++) { if ($before[$j] -ne $after[$j]) { $dc++ } }
    if ($dc -ne $Expect[$s.Kind]) { $GuardFail = "$($s.Path) 实际改动 $dc 行，预期 $($Expect[$s.Kind]) 行，判定编码/锚点污染"; break }
}
if ($GuardFail) {
    foreach ($s in $Sites) {
        $enc = New-Object System.Text.UTF8Encoding([bool]$HasBom[$s.Path])
        [IO.File]::WriteAllText((Join-Path $Root $s.Path), $OrigTexts[$s.Path], $enc)
    }
    throw "$GuardFail → 六个版本位文件已整体回滚到写入前状态，本次未留下任何改动"
}
"行数守卫通过：每处改动行数与预期一致（无编码污染）"
"下一步: powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Version $Version"
exit 0
