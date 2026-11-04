/**
 * 「检查更新」网络代理配置。
 *
 * 背景与约束（已对照 @tauri-apps/plugin-updater 2.14.1 源码核实）：
 *  - 前端 `check(options)` 的 CheckOptions 支持 `proxy?: string`；
 *  - Rust 侧 `plugin:updater|check` 收到 proxy 后执行 `Url::parse` +
 *    `UpdaterBuilder::proxy(url)`；
 *  - 生成的 `Update` 结构体会携带同一个 proxy（updater.rs `proxy: self.proxy.clone()`），
 *    而 `download` / `download_and_install` 只是 clone 该 Update，
 *    因此「检查阶段的代理会自动沿用到下载安装阶段」——无需第二次配置。
 *  - 插件默认启用了 `system-proxy` 特性，不传 proxy 时自动读取 Windows 系统代理。
 *
 * 由此可用的语义只有两种，本模块据此建模：
 *  - system：不传 proxy，跟随 Windows 系统代理（默认）；
 *  - custom：显式传入代理 URL，覆盖系统代理。
 */

import { api } from "./api";

export type ProxyMode = "system" | "custom";

export type ProxyConfig = {
  mode: ProxyMode;
  url: string;
};

export const DEFAULT_PROXY: ProxyConfig = { mode: "system", url: "" };

export const PRESET_PROXIES = [
  { label: "Clash (7890)", url: "http://127.0.0.1:7890" },
  { label: "v2rayN (10809)", url: "http://127.0.0.1:10809" },
  { label: "Privoxy (8118)", url: "http://127.0.0.1:8118" },
  { label: "Fiddler (8888)", url: "http://127.0.0.1:8888" },
];

const STORAGE_KEY = "asts.update.proxy";

/**
 * 仅允许 http / https。
 * 原因：插件的 reqwest 依赖只开启了 json/stream 特性，未启用 `socks`，
 * SOCKS 代理会在运行时由 `reqwest::Proxy::all` 直接报错。
 * 在输入阶段就拦下，比让用户在「检查失败」里猜要清楚得多。
 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export function loadProxyConfig(): ProxyConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PROXY;
    const parsed = JSON.parse(raw) as Partial<ProxyConfig> | null;
    if (!parsed || (parsed.mode !== "system" && parsed.mode !== "custom")) {
      return DEFAULT_PROXY;
    }
    return { mode: parsed.mode, url: typeof parsed.url === "string" ? parsed.url : "" };
  } catch {
    // 私密模式 / 存储被禁用 / 内容损坏 —— 一律回落默认值，不影响主流程
    return DEFAULT_PROXY;
  }
}

export function saveProxyConfig(cfg: ProxyConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // 写不进去只是不记忆，本次会话内配置依然生效
  }
}

export type ProxyCheck = { ok: true; url: string } | { ok: false; error: string };

/**
 * 规范化并校验用户输入的代理地址。
 * 允许省略协议（补 http://），最终产出可直接交给插件 `check({ proxy })` 的字符串。
 */
export function normalizeProxyUrl(raw: string): ProxyCheck {
  const input = raw.trim();
  if (!input) return { ok: false, error: "请填写代理地址，例如 http://127.0.0.1:25378" };

  // 省略协议时按 HTTP 代理处理（本地代理软件最常见形态）
  const withScheme = input.includes("://") ? input : `http://${input}`;

  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return { ok: false, error: "地址格式无法解析，请检查主机名与端口" };
  }

  if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
    return {
      ok: false,
      error: `仅支持 http / https 代理，当前为 ${u.protocol.replace(":", "")}`,
    };
  }
  if (!u.hostname) return { ok: false, error: "缺少代理主机名" };
  if (u.pathname !== "/" || u.search || u.hash) {
    return { ok: false, error: "代理地址不应包含路径、查询参数或锚点" };
  }

  return { ok: true, url: u.origin };
}

/** 把界面配置转成插件 `check()` 的 proxy 取值；system 模式返回 undefined。 */
export function toCheckProxy(cfg: ProxyConfig): string | undefined {
  if (cfg.mode === "system") return undefined;
  const r = normalizeProxyUrl(cfg.url);
  return r.ok ? r.url : undefined;
}

/**
 * 展示用脱敏：代理 URL 可能内嵌 用户名:口令@host。
 * 卡片、日志与提示中一律使用该函数，避免凭据出现在界面上。
 */
export function maskProxyUrl(url: string): string {
  try {
    const u = new URL(url.includes("://") ? url : `http://${url}`);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "";
    }
    return u.origin;
  } catch {
    return url;
  }
}

/** 检查更新出错时的可读提示：代理类失败要给下一步动作，而不是只回显英文栈。 */
export function explainUpdateError(err: unknown, cfg: ProxyConfig): string {
  const text = String(err instanceof Error ? err.message : err);
  const usingProxy = cfg.mode === "custom" && !!toCheckProxy(cfg);
  const looksLikeNetwork = /request|connect|network|timed? ?out|dns|tls|http|fetch/i.test(text);

  if (looksLikeNetwork) {
    return usingProxy
      ? `网络请求失败（代理 ${maskProxyUrl(cfg.url)}）：${text}。请确认代理已启动且端口可访问，或切换为「跟随系统代理」重试。`
      : `网络请求失败：${text}。若本机需要通过代理访问 GitHub，请在「网络代理」中选择「自定义代理」并填写代理地址。`;
  }
  return `检查更新失败：${text}`;
}

/** 测试代理连通性并返回握手信息 */
export async function testProxyConnection(rawUrl: string): Promise<string> {
  const chk = normalizeProxyUrl(rawUrl);
  if (!chk.ok) {
    throw new Error(chk.error);
  }
  return await api.testProxy(chk.url);
}
