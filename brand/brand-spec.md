# AndroidSignTool · 火漆标识规范（Brand Spec）

选定方向：**A · 火漆 WAX SEAL**（用户原话选定：「A」）。
母题：一枚压在文件上的封缄——八瓣浅缺的火漆、压印内圈、严格 45° 硬角验收勾。
语义：签名的原始物理形态就是「封缄 + 认证」：内容不被改动、来源可追责。

## 1 · 色板（全部取自应用既有资产）

| 角色 | 色值 | 来源 |
|---|---|---|
| 火漆主色 | `#1F6FEB` | `src/styles.css` `--accent` |
| 压印暗腔 | `#0B3D8A` | 主色加深（圈线，透明度 55–65%） |
| 勾 / 凹痕 | `#DCE9FB`（浅底）· `#F2F8FF`（深底） | 主色提亮 |
| 纸板 | `#F1F3F6` | 近 `--bg-subtle` |
| 石墨描边 | `#14181D` | 近 `--ink` |
| 墨板（深底态） | `#151B23` + 描边 `#33414F` | 近 `--bar` `#10161F` |

## 2 · 几何规则（96 基准网格）

- 底板：`rect 2,2,92,92 rx21`，描边 1.8
- 火漆：8 瓣正多角封缄，外径 r31 / 底径 r27（深度 ≈14%），fill+同色 stroke 2.6、`stroke-linejoin=round`
- 压印内圈：`circle 48,48 r16.5` stroke 1.8
- 验收勾：两段**严格 45°**（短臂 Δ7,7 / 长臂 Δ13,13，比 7:13），`stroke-width 5.6`、`linejoin miter`、butt 端头
- 中心 (48,48)；勾包络中心与火漆中心重合
- 硬约束（用户品味，逐字：「中间的符号意义不明确，像个毛毛虫一样，可以搞个规则点的图形」）：**禁止自由曲线笔迹**；一切符号只用 45°/90° 硬角与网格交点

## 3 · 文件清单

| 文件 | 用途 |
|---|---|
| `brand/logo/mark-light.svg` | 浅底标准态（应用图标母版） |
| `brand/logo/mark-dark.svg` | 深底态 |
| `brand/logo/mark-mono.svg` | 单色态：印刷 / 钢印 / 凸版（mask 镂空） |
| `brand/logo/mark-knockout.svg` | 反白态：压任意深色（mask 镂空） |
| `brand/logo/mark-bare.svg` | 无底板纯母题：水印 / favicon / 顶栏小图 |
| `brand/logo/horizontal-lockup.svg` | 横版锁定（字标为活动文本，印刷前须转曲） |
| `brand/icons/app-icon-{1024,512,256,128,64,48,32,16}.png` | 图标阶梯，透明底 |
| `brand/icons/mark-{dark,mono,knockout,bare}-256.png` | 各态位图 |
| `brand/previews/delivery-board.png` | 交付确认板（1024 主标 / 阶梯 / 四态 / 20px 实景） |
| `src-tauri/icons/*` | 已由 `npx tauri icon` 从 app-icon-1024.png 重建（17 个桌面文件） |
| `public/app-icon.svg` | 浏览器 favicon（bare 版） |
| `brand/tauri-icons-default-backup/` | 原 Tauri 默认图标备份（16 个文件），可随时还原 |

## 4 · 使用规则

- **最小尺寸**：带板态 ≥20px；bare 态 ≥12px；16px 下压印圈允许糊化（轮廓 + 蓝 + 白点三要素保住即成立）
- **安全边距**：≥ 底板边长的 1/8，不得与页缘、其他元素粘连
- **深浅底选择**：浅色界面用 light；终端/深色壁纸用 dark 或 knockout；单色印刷用 mono
- **禁止**：勾改圆角、火漆换非品牌色、底板拉伸变形、给主标加投影/玻璃拟态、字标与母题间距小于母题半宽
- **字标**：`APK SIGN TOOL` 等宽族（Cascadia Mono → JetBrains Mono → Consolas），weight 600，letter-spacing ≈0.5–1.2px——与应用顶栏 `.wordmark` 同源（`src/App.tsx`）

## 5 · 再生成流程

改几何后：编辑 `brand/logo/mark-light.svg` → 重新渲染 `brand/icons/app-icon-1024.png`（内联 SVG 截图，勿用 file:// 子资源，见交付脚本注释）→ `npx tauri icon brand\icons\app-icon-1024.png`（会附带生成 android/ios 目录，项目仅 Windows NSIS，删除之）→ 桌面 17 文件覆盖 `src-tauri/icons/`。
