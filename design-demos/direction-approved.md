# direction-approved.md — AndroidSignTool 标识设计

> Gate 文件：记录方向门（三方向门）的展示内容与**用户原话**。
> 本文件存在的意义：实现开工前必须有用户对方向的明确选择；本条记录 = 可追溯的决策链。

## 项目

- 目标：为 **AndroidSignTool**（Tauri 桌面端 APK 签名工具）设计应用 logo / 图标
- 工作区：`F:\AI\AndroidSignTool`
- 已有资产（设计从中长出，非凭空）：
  - 主色 `#1F6FEB`（`src/styles.css` `--accent`）
  - 终端底色 `#10161F`（`--bar`，应用唯一深色区域）
  - 等宽字体 `"Cascadia Mono", "JetBrains Mono", Consolas`（`--mono`）
  - 应用现有字标：`<b>APK SIGN TOOL</b>` + `v0.1.0` 标签（`src/App.tsx:40-42`，`.wordmark` 样式在 `src/styles.css`）
  - 现有图标全部是 Tauri 默认图标（`src-tauri/icons/*`）
- 用途：应用图标（小尺寸优先，需过 32 / 24 / 16 px）

## v1 — 已作废

- 展示内容：`design-demos/logo-directions-v2-actions.html` 的前一版
  `design-demos/logo-directions.html`（三方向 A 衔印 / B 压印 / C 徽记 + 四备选，主体均为字母 **M**）
- 截图：`design-demos/preview-full.png`
- **作废原因（用户质疑原文）**：「为什么主体是M，这代表什么？」
- 复核结论：M 无任何依据——`AndroidSignTool` 与 `APK SIGN TOOL` 中都不存在 M。
  M 只因左右对称、易排坐标、缩到 16px 不塌而被选中，属于「最容易画」而非「该画」的字形，
  是默认审美滑移，违反「设计要从题材里重新长出来」。
- **保留部分**：v1 的三套表面处理逻辑（纸与墨 / 终端压痕 / 黄铜封框）站得住，v2 继续沿用。

## v2 — 当前方向板

- 文件：`design-demos/logo-directions-v2-actions.html`
- 截图：`design-demos/v2-full.png`、`design-demos/zoom2-wax.png`、`design-demos/zoom2-stroke.png`、`design-demos/zoom2-split.png`
- 主体全部为**动作 / 物件**，零字母。

### 已确认的用户决策（asktool 原话）

| 问题 | 用户选择（原话） |
|---|---|
| 主体换成哪个？ | 「**不用字母，直接画动作**」 |
| 字标用哪个叫法？ | 「**APK SIGN TOOL —— 沿用应用现有顶栏**」 |

早期偏好（同样由 asktool 确认）：业务类型「软件 / SaaS / 开发者工具」；
气质倾向同时勾选了「科技锐利 · 深底光效」「手作温度 · 有机线条」「复古徽章 / 印章感」「极简几何 · 瑞士秩序感」；
主要用途「应用图标（小尺寸关键）」。

### 摆出的三个正式方向

- **A · 火漆 WAX SEAL** — 八瓣浅缺的封缄，中心压凹一笔带回环的签字；火漆用主色 `#1F6FEB` 而非传统暗红
- **B · 落笔 STROKE** — 终端深底 + 极淡机器网格 + 一笔不断的签名，起笔收成像素方块
- **C · 骑缝 SPLIT SEAL** — 两份文件并置，一枚蓝章跨压接缝；自带状态对（压合 / 拆开）

四个变体：白火漆 Emboss（A 的无色工艺版）、素笔 Pure（B 去网格）、骑缝分开 Open（C 的未签 / 被拆过态）、包角验收 File（APK 折角 + 越界勾）。

### 自检发现并已修的问题

1. C 的初稿用「榫卯咬合」，在深底上读作字母 **E** —— 违背「零字母」前提，已整体替换为骑缝章
2. A 的火漆初稿八瓣过深，读作促销爆炸贴 —— 缺口深度由 r27/r18.5 收敛到 r27/r23.5
3. A/B 的中心笔迹初稿是正弦波，不像签字 —— 改为带自交回环的一笔
4. 编辑事故两处：`PUT` 误打在 `</symbol>` 闭合行（B、B2 各一处），已补回并复核 7 定义 / 7 闭合 / 0 残留
5. 手工红线检查：无 emoji 图标、无箭头尾巴、无假编号、无紫渐变、无 SVG 画人、无占位文案；
   删除 1 条无用样式 `.colhead` 与页脚对中文无效的 `text-transform`
   （官方 `design_lint.py` 无法运行：沙箱禁止 Bash 触碰 `~/.agents/skills`，故用等价手工检查替代）

## 方向选定（用户原话）

- 「A」—— 选定 **A · 火漆 WAX SEAL**（八瓣浅缺封缄 + 压印内圈 + 45° 硬角验收勾）
- 选定时间：本会话；此后全部工作为对 A 的迭代，不再重复三方向门

## 品味反馈（用户原话，逐字记录）

- 「中间的符号意义不明确，像个毛毛虫一样，可以搞个规则点的图形」
  - 适用范围：本项目全部母题（后续交付也按此执行）——中心符号一律用严格几何（45°/90° 硬角、miter 转角、butt 端头、顶点钉在网格交点），禁用自由曲线笔迹
  - 落地：A 中心→硬角验收勾；B 主体→一长两短 45° 折线（量化签名）；C 章面→45° 菱形印纹；D 变体的勾同步 miter 化；A 删除与勾交叉的下缘反光弧
  - 备注：skill 的 `learn.py` 无法调用（沙箱禁止 Bash 触碰 `~/.agents/skills`），此条先落在本 gate 文件

## 状态

- ✅ 三方向门已展示（v2 方向板 + 20px 应用内实景三行对比）
- ✅ 完整版已交付：A 主标六件套 SVG、图标阶梯 PNG（1024–16）、四态、横版锁定；`src-tauri/icons` 全套重建（原图标备份于 `brand/tauri-icons-default-backup/`）；favicon 接入 `public/app-icon.svg`；规范见 `brand/brand-spec.md`
- 「用户说继续」授权的是进入下一步，不等于跳过本 gate
