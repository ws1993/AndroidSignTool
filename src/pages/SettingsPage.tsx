import { useCallback, useEffect, useMemo, useState } from "react";
import {
  App as AntApp,
  Button,
  Input,
  Popconfirm,
  Progress,
  Radio,
  Space,
  Table,
  Tag,
  Tooltip,
} from "antd";
import type { TableColumnsType } from "antd";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  api,
  baseName,
  type DataPaths,
  type ProfileMeta,
  type StrategyOption,
  type ToolStatus,
} from "../lib/api";
import { FieldPanel, Section } from "../components/Layout";
import {
  DEFAULT_PROXY,
  PRESET_PROXIES,
  explainUpdateError,
  loadProxyConfig,
  maskProxyUrl,
  normalizeProxyUrl,
  saveProxyConfig,
  testProxyConnection,
  type ProxyConfig,
} from "../lib/proxy";
import "./SettingsPage.css";

type SettingsCategory = "profiles" | "runtime" | "updater";

export default function SettingsPage({ onReload }: { onReload: () => void }) {
  const { message } = AntApp.useApp();
  const [category, setCategory] = useState<SettingsCategory>("profiles");
  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [paths, setPaths] = useState<DataPaths | null>(null);
  const [profiles, setProfiles] = useState<ProfileMeta[]>([]);
  const [strategies, setStrategies] = useState<StrategyOption[]>([]);
  const [version, setVersion] = useState("");

  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateMsg, setUpdateMsg] = useState("");
  const [progress, setProgress] = useState<number | null>(null);

  // —— 检查更新的网络代理配置 ——
  const [proxy, setProxy] = useState<ProxyConfig>(DEFAULT_PROXY);
  const [testingProxy, setTestingProxy] = useState(false);
  const [testProxyMsg, setTestProxyMsg] = useState<string | null>(null);
  const [testProxySuccess, setTestProxySuccess] = useState<boolean | null>(null);

  useEffect(() => {
    setProxy(loadProxyConfig());
  }, []);

  // 代理配置变更即持久化，避免用户填完忘了保存就得重填
  const applyProxy = useCallback((next: ProxyConfig) => {
    setProxy(next);
    saveProxyConfig(next);
    setTestProxyMsg(null);
    setTestProxySuccess(null);
  }, []);

  const proxyCheck = useMemo(
    () => (proxy.mode === "system" ? null : normalizeProxyUrl(proxy.url)),
    [proxy],
  );
  const proxyInvalid = proxyCheck !== null && !proxyCheck.ok;

  const loadProfiles = useCallback(() => {
    api
      .listProfiles()
      .then(setProfiles)
      .catch((e) => message.error(String(e)));
  }, [message]);

  const loadAll = useCallback(() => {
    api.checkTools().then(setTools).catch(() => setTools(null));
    api.dataPaths().then(setPaths).catch((e) => message.error(String(e)));
    api.listStrategies().then(setStrategies).catch(() => undefined);
    loadProfiles();
    getVersion().then(setVersion).catch(() => undefined);
  }, [message, loadProfiles]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Update 持有 Rust 侧资源，离开页面时释放，避免反复检查累积 RID 泄漏
  useEffect(() => {
    return () => {
      if (update) void update.close().catch(() => undefined);
    };
  }, [update]);

  const strategyLabel = useCallback(
    (v: string) => strategies.find((s) => s.value === v)?.label ?? v,
    [strategies],
  );

  async function reveal(path: string) {
    try {
      await api.openInExplorer(path);
    } catch (e) {
      message.error(String(e));
    }
  }

  // 连通性测试
  async function handleTestProxy() {
    if (proxy.mode !== "custom") return;
    const r = normalizeProxyUrl(proxy.url);
    if (!r.ok) {
      message.warning(r.error);
      setTestProxyMsg(r.error);
      setTestProxySuccess(false);
      return;
    }
    setTestingProxy(true);
    setTestProxyMsg("正在探测代理端口握手…");
    setTestProxySuccess(null);
    try {
      const res = await testProxyConnection(r.url);
      setTestProxySuccess(true);
      setTestProxyMsg(res);
      message.success(res);
    } catch (e) {
      const errText = String(e instanceof Error ? e.message : e);
      setTestProxySuccess(false);
      setTestProxyMsg(errText);
      message.error(errText);
    } finally {
      setTestingProxy(false);
    }
  }

  async function doCheck() {
    let proxyUrl: string | undefined;
    if (proxy.mode === "custom") {
      const r = normalizeProxyUrl(proxy.url);
      if (!r.ok) {
        message.warning(r.error);
        setUpdateMsg(`检查更新失败：${r.error}`);
        return;
      }
      proxyUrl = r.url;
    }

    setChecking(true);
    setUpdateMsg("正在检查最新版本…");
    setUpdate(null);
    setProgress(null);
    try {
      // proxy 只在这里传一次：插件解析出的 Update 会携带同一代理，
      // 后续 downloadAndInstall 自动复用，无需二次配置。
      const u = await check({ proxy: proxyUrl, timeout: 30_000 });
      if (!u) {
        setUpdateMsg(
          proxyUrl ? `当前已是最新版本（经代理 ${maskProxyUrl(proxyUrl)}）` : "当前已是最新版本",
        );
      } else {
        setUpdate(u);
        setUpdateMsg(`发现新版本 ${u.version}`);
      }
    } catch (e) {
      setUpdateMsg(explainUpdateError(e, proxy));
    } finally {
      setChecking(false);
    }
  }

  async function doInstall() {
    if (!update) return;
    setInstalling(true);
    setProgress(0);
    try {
      let total = 0;
      let done = 0;
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") {
          total = ev.data.contentLength ?? 0;
        } else if (ev.event === "Progress") {
          done += ev.data.chunkLength;
          const pct = total ? Math.round((done / total) * 100) : 0;
          setProgress(pct);
          setUpdateMsg(`下载中 ${pct}%`);
        } else if (ev.event === "Finished") {
          setProgress(100);
          setUpdateMsg("下载完成，正在安装，应用即将重启…");
        }
      });
      await relaunch();
    } catch (e) {
      setUpdateMsg(`安装失败：${String(e)}`);
      setInstalling(false);
      setProgress(null);
    }
  }

  const profileColumns: TableColumnsType<ProfileMeta> = [
    { title: "名称", dataIndex: "name", width: 160, ellipsis: true },
    { title: "别名", dataIndex: "alias", width: 120, ellipsis: true },
    {
      title: "签名文件",
      dataIndex: "keystorePath",
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v}>
          <span className="mono">{baseName(v)}</span>
        </Tooltip>
      ),
    },
    {
      title: "默认策略",
      dataIndex: "strategy",
      width: 170,
      render: (v: string) => (
        <Tooltip title={strategyLabel(v)}>
          <Tag bordered={false} className="tag-ellipsis">
            {strategyLabel(v)}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: "创建时间",
      dataIndex: "createdAt",
      width: 168,
      render: (v: string) => <span className="mono">{v}</span>,
    },
    {
      title: "操作",
      key: "act",
      width: 120,
      align: "right",
      render: (_, row) => (
        <Space size={2}>
          <Button size="small" type="text" onClick={() => reveal(row.keystorePath)}>
            定位
          </Button>
          <Popconfirm
            title={`删除配置「${row.name}」？`}
            description="只删除本机加密的口令记录，不会删除签名文件本身。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={async () => {
              try {
                await api.deleteProfile(row.id);
                message.success("已删除");
                loadProfiles();
              } catch (e) {
                message.error(String(e));
              }
            }}
          >
            <Button size="small" type="text" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const pathRow = (label: string, value: string | undefined, actionLabel = "定位") => (
    <div className="path-row">
      <span className="label">{label}</span>
      <span className="value path-text">{value || "—"}</span>
      <span className="act">
        {value ? (
          <Button size="small" type="text" onClick={() => reveal(value)}>
            {actionLabel}
          </Button>
        ) : null}
      </span>
    </div>
  );

  const ready = !!tools && tools.java && tools.apksigner;
  const allReady = ready && tools!.keytool && tools!.zipalign;

  const navItems = useMemo(
    () => [
      {
        key: "profiles" as const,
        label: "签名配置",
        desc: "已存密钥库与别名",
        icon: (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="7.5" cy="15.5" r="5.5" />
            <path d="m21 2-9.6 9.6" />
            <path d="m15.5 7.5 3 3L22 7l-3-3" />
          </svg>
        ),
        badge: `${profiles.length} 条`,
      },
      {
        key: "runtime" as const,
        label: "环境与存储",
        desc: "内置工具链与目录",
        icon: (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
        ),
        badge: tools ? (allReady ? "4/4 就绪" : "部分缺失") : "检测中",
      },
      {
        key: "updater" as const,
        label: "网络与更新",
        desc: "代理设置与软件更新",
        icon: (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
            <path d="M2 12h20" />
          </svg>
        ),
        badge: update ? `v${update.version}` : (version ? `v${version}` : "—"),
      },
    ],
    [profiles.length, tools, allReady, update, version],
  );

  return (
    <div className="settings-layout">
      {/* ---------- 左侧：层级分类导航 ---------- */}
      <aside className="settings-sidebar">
        <nav className="settings-nav-list" role="tablist">
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={category === item.key}
              className={`settings-nav-item ${category === item.key ? "active" : ""}`}
              onClick={() => setCategory(item.key)}
            >
              <div className="settings-nav-item-top">
                <div className="settings-nav-title-wrap">
                  <span className="settings-nav-icon">{item.icon}</span>
                  <span>{item.label}</span>
                </div>
                {item.badge ? (
                  <span className="settings-nav-badge">{item.badge}</span>
                ) : null}
              </div>
              <div className="settings-nav-desc">{item.desc}</div>
            </button>
          ))}
        </nav>
      </aside>

      {/* ---------- 右侧：选中的分类内容面板 ---------- */}
      <div className="settings-content" key={category}>
        {/* 1. 签名配置管理 */}
        {category === "profiles" && (
          <Section
            title="已保存的签名配置"
            desc={`共 ${profiles.length} 条已保存配置。口令经 Windows DPAPI 硬件/账户级加密存储，不暴露明文。`}
            extra={
              <Tooltip title="口令经 Windows DPAPI 硬件/账户级加密，仅本机当前用户可解密">
                <span className="status-indicator">
                  <span className="status-dot ok" />
                  <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>DPAPI 本机加密</span>
                </span>
              </Tooltip>
            }
          >
            <Table<ProfileMeta>
              rowKey="id"
              size="small"
              tableLayout="fixed"
              columns={profileColumns}
              dataSource={profiles}
              pagination={{ pageSize: 8, showSizeChanger: false, size: "small" }}
              locale={{ emptyText: "暂无签名配置，可在「APK 签名」或「生成签名文件」中勾选保存" }}
            />
          </Section>
        )}

        {/* 2. 运行环境与存储 */}
        {category === "runtime" && (
          <>
            <Section
              title="内置工具链"
              desc="安装包内置 jlink 精简 JRE、apksigner 与 zipalign，离线独立运行。"
              extra={
                <Button
                  size="small"
                  onClick={() => {
                    loadAll();
                    onReload();
                  }}
                >
                  重新检测
                </Button>
              }
            >
              <div className="tool-grid">
                <div className="tool-card">
                  <div className="tool-card-head">
                    <span className="tool-card-name">java</span>
                    <span className="tool-card-status">
                      <span className={`status-dot ${tools?.java ? "ok" : "err"}`} />
                      <span style={{ color: tools?.java ? "var(--ok)" : "var(--err)" }}>
                        {tools?.java ? "已就绪" : "缺失"}
                      </span>
                    </span>
                  </div>
                  <div className="tool-card-desc">精简 JRE 运行时</div>
                </div>

                <div className="tool-card">
                  <div className="tool-card-head">
                    <span className="tool-card-name">keytool</span>
                    <span className="tool-card-status">
                      <span className={`status-dot ${tools?.keytool ? "ok" : "err"}`} />
                      <span style={{ color: tools?.keytool ? "var(--ok)" : "var(--err)" }}>
                        {tools?.keytool ? "已就绪" : "缺失"}
                      </span>
                    </span>
                  </div>
                  <div className="tool-card-desc">密钥与证书管理</div>
                </div>

                <div className="tool-card">
                  <div className="tool-card-head">
                    <span className="tool-card-name">apksigner</span>
                    <span className="tool-card-status">
                      <span className={`status-dot ${tools?.apksigner ? "ok" : "err"}`} />
                      <span style={{ color: tools?.apksigner ? "var(--ok)" : "var(--err)" }}>
                        {tools?.apksigner ? "已就绪" : "缺失"}
                      </span>
                    </span>
                  </div>
                  <div className="tool-card-desc">官方 APK 签名工具</div>
                </div>

                <div className="tool-card">
                  <div className="tool-card-head">
                    <span className="tool-card-name">zipalign</span>
                    <span className="tool-card-status">
                      <span className={`status-dot ${tools?.zipalign ? "ok" : "err"}`} />
                      <span style={{ color: tools?.zipalign ? "var(--ok)" : "var(--err)" }}>
                        {tools?.zipalign ? "已就绪" : "缺失"}
                      </span>
                    </span>
                  </div>
                  <div className="tool-card-desc">4 字节对齐优化</div>
                </div>
              </div>

              <div className="tool-path-bar">
                <span className="path-text">
                  <span className="text-faint" style={{ marginRight: 8 }}>
                    JRE 路径:
                  </span>
                  {tools?.javaPath || "内置/环境变量"}
                </span>
                {tools?.javaPath ? (
                  <Button size="small" type="text" onClick={() => reveal(tools.javaPath!)}>
                    定位文件
                  </Button>
                ) : null}
              </div>
            </Section>

            <Section
              title="本机存储与安全"
              desc="口令以 Windows 当前用户 DPAPI 加密落盘，换机器或系统账户无法解密；日志与历史永不记录口令。"
            >
              <div className="path-list">
                {pathRow("数据主目录", paths?.dataDir, "打开目录")}
                {pathRow("签名配置库", paths?.profiles, "定位文件")}
                {pathRow("签名历史库", paths?.history, "定位文件")}
              </div>
            </Section>
          </>
        )}

        {/* 3. 网络与更新 */}
        {category === "updater" && (
          <Section
            title="软件更新与网络设置"
            desc="更新走 GitHub Releases（NSIS 安装包 + latest.json 签名清单），校验 minisign 签名后安装。"
            extra={
              <span className="status-indicator">
                <span className="status-dot ok" />
                <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                  当前版本 {version ? `v${version}` : "—"}
                </span>
              </span>
            }
          >
            {/* 网络代理配置微面板 */}
            <FieldPanel
              title="更新网络代理"
              desc="作用于检查更新与下载安装包；配置仅持久化于本机。"
              extra={
                <Radio.Group
                  value={proxy.mode}
                  onChange={(e) => applyProxy({ ...proxy, mode: e.target.value })}
                  optionType="button"
                  buttonStyle="solid"
                  size="small"
                  disabled={checking || installing}
                  options={[
                    { label: "跟随系统代理", value: "system" },
                    { label: "自定义代理", value: "custom" },
                  ]}
                />
              }
            >
              {proxy.mode === "custom" ? (
                <>
                  <div className="proxy-input-row">
                    <Input
                      value={proxy.url}
                      onChange={(e) => applyProxy({ ...proxy, url: e.target.value })}
                      disabled={checking || installing}
                      placeholder="例如 http://127.0.0.1:7890"
                      status={proxyInvalid ? "error" : undefined}
                      aria-label="更新代理地址"
                      style={{ flex: 1 }}
                    />
                    <Button
                      onClick={handleTestProxy}
                      loading={testingProxy}
                      disabled={!proxy.url.trim() || proxyInvalid || checking || installing}
                    >
                      测试连通性
                    </Button>
                    <Button
                      onClick={() => applyProxy(DEFAULT_PROXY)}
                      disabled={checking || installing}
                    >
                      重置
                    </Button>
                  </div>

                  {/* 常见本地代理快捷预设 */}
                  <div className="preset-chips">
                    <span className="preset-label">快捷填充:</span>
                    {PRESET_PROXIES.map((p) => (
                      <button
                        key={p.url}
                        type="button"
                        className="preset-btn"
                        onClick={() => applyProxy({ mode: "custom", url: p.url })}
                        disabled={checking || installing}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>

                  {/* 连通性测试回显或校验提示 */}
                  <div className="field-note">
                    {testProxyMsg ? (
                      <span className={testProxySuccess ? "text-ok" : "note-err"}>
                        <span
                          className={`status-dot ${testProxySuccess ? "ok" : "err"}`}
                          style={{ marginRight: 6 }}
                        />
                        {testProxyMsg}
                      </span>
                    ) : proxyInvalid && proxyCheck && !proxyCheck.ok ? (
                      <span className="note-err">{proxyCheck.error}</span>
                    ) : (
                      <span>
                        支持 http / https 代理；支持填写主机与端口（可省略协议，如 127.0.0.1:7890）。
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <div className="field-note">
                  自动读取并跟随当前 Windows 系统的网络代理设置（系统代理未开启时直连）。
                </div>
              )}
            </FieldPanel>

            {/* 版本检查与升级动作面板 */}
            <FieldPanel title="版本状态与操作">
              <div className="update-dashboard">
                <div className="update-banner">
                  <div className="update-banner-left">
                    <span
                      className={`status-dot ${
                        update ? "warn" : updateMsg.includes("已是最新") ? "ok" : "muted"
                      }`}
                    />
                <div className="update-status-text">
                  <span>{updateMsg || "尚未检查更新"}</span>
                  {update ? (
                    <Tag color="orange" bordered={false} style={{ marginLeft: 8 }}>
                      最新版本 v{update.version}
                    </Tag>
                  ) : null}
                </div>
              </div>

              <div className="update-banner-actions">
                <Button
                  onClick={doCheck}
                  loading={checking}
                  disabled={installing}
                >
                  检查更新
                </Button>
                <Button
                  type="primary"
                  disabled={!update || proxyInvalid}
                  loading={installing}
                  onClick={doInstall}
                >
                  下载并安装
                </Button>
              </div>
            </div>

            {progress !== null ? (
              <Progress
                percent={progress}
                size="small"
                strokeColor="#1f6feb"
                style={{ marginTop: 8, marginBottom: 0 }}
              />
            ) : null}

            {update?.body ? (
              <div className="update-notes-box">
                <b style={{ color: "var(--ink)", display: "block", marginBottom: 4 }}>
                  更新说明（v{update.version}）：
                </b>
                <div style={{ whiteSpace: "pre-wrap" }}>{update.body}</div>
              </div>
            ) : null}
          </div>
        </FieldPanel>
      </Section>
    )}
      </div>
    </div>
  );
}
