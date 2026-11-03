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
import { api, type DataPaths, type ProfileMeta, type StrategyOption, type ToolStatus } from "../lib/api";
import { FieldGroup, Section, ZoneGrid } from "../components/Layout";
import {
  DEFAULT_PROXY,
  explainUpdateError,
  loadProxyConfig,
  maskProxyUrl,
  normalizeProxyUrl,
  saveProxyConfig,
  type ProxyConfig,
} from "../lib/proxy";

export default function SettingsPage({ onReload }: { onReload: () => void }) {
  const { message } = AntApp.useApp();
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

  // —— 检查更新的网络代理配置（默认跟随 Windows 系统代理）——
  const [proxy, setProxy] = useState<ProxyConfig>(DEFAULT_PROXY);

  useEffect(() => {
    setProxy(loadProxyConfig());
  }, []);

  // 代理配置变更即持久化，避免用户填完忘了保存就得重填
  const applyProxy = useCallback((next: ProxyConfig) => {
    setProxy(next);
    saveProxyConfig(next);
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

  async function doCheck() {
    // 自定义代理必须先通过校验：错误的 URL 会让插件在 Rust 侧 Url::parse 直接报错，
    // 提前拦下能给出「该改哪里」而不是一串英文错误。
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
    setUpdateMsg("");
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
          <span>{v}</span>
        </Tooltip>
      ),
    },
    {
      title: "默认策略",
      dataIndex: "strategy",
      width: 150,
      render: (v: string) => <Tag bordered={false}>{strategyLabel(v)}</Tag>,
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

  const toolTag = (ok: boolean) => (
    <Tag color={ok ? "green" : "red"} bordered={false}>
      {ok ? "可用" : "缺失"}
    </Tag>
  );

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

  return (
    <div className="page">
      {/* ---------- 分区一：运行环境 ---------- */}
      <ZoneGrid>
        <Section
          title="内置工具链"
          desc={
            <>
              安装包内置 jlink 精简 JRE、apksigner.jar 与 zipalign.exe，用户机器无需安装 Java。
              开发环境需先执行 <code>npm run prepare:tools</code>。
            </>
          }
          extra={
            <Button
              onClick={() => {
                loadAll();
                onReload();
              }}
            >
              重新检测
            </Button>
          }
        >
          <div className="tool-matrix">
            <div className="tool-cell">
              <span className="tool-name">java</span>
              {toolTag(!!tools?.java)}
            </div>
            <div className="tool-cell">
              <span className="tool-name">keytool</span>
              {toolTag(!!tools?.keytool)}
            </div>
            <div className="tool-cell">
              <span className="tool-name">apksigner</span>
              {toolTag(!!tools?.apksigner)}
            </div>
            <div className="tool-cell">
              <span className="tool-name">zipalign</span>
              {toolTag(!!tools?.zipalign)}
            </div>
          </div>
          <div className="tool-path">
            <span className="text-faint">java 路径</span>
            <span className="path-text">{tools?.javaPath || "—"}</span>
          </div>
        </Section>

        <Section
          title="本机数据与存储"
          desc="签名配置里的口令以 Windows 当前用户 DPAPI 加密落盘，换机器 / 换 Windows 账户无法解密；日志与历史永不记录口令。"
        >
          <div className="path-list">
            {pathRow("数据目录", paths?.dataDir, "打开")}
            {pathRow("签名配置", paths?.profiles)}
            {pathRow("签名历史", paths?.history)}
          </div>
        </Section>
      </ZoneGrid>

      {/* ---------- 分区二：签名配置 ---------- */}
      <Section
        title="已保存的签名配置"
        desc={`共 ${profiles.length} 条。口令字段不出现在界面与导出内容中。`}
        extra={
          <Tooltip title="口令以 Windows DPAPI 加密，仅本机当前用户可解密">
            <Tag bordered={false}>本机加密</Tag>
          </Tooltip>
        }
      >
        <Table<ProfileMeta>
          rowKey="id"
          size="small"
          columns={profileColumns}
          dataSource={profiles}
          pagination={{ pageSize: 6, showSizeChanger: false, size: "small" }}
          locale={{ emptyText: "暂无签名配置" }}
        />
      </Section>

      {/* ---------- 分区三：软件更新（含网络代理） ---------- */}
      <Section
        title="关于与自动更新"
        desc={
          <>
            更新走 GitHub Releases（NSIS 安装包 + <code>latest.json</code> 签名清单），下载后校验
            minisign 签名再安装。
          </>
        }
        extra={<Tag bordered={false}>当前版本 {version || "—"}</Tag>}
      >
        <FieldGroup title="更新状态" hint={proxy.mode === "custom" ? "经自定义代理" : "跟随系统代理"}>
          <div className="kv update-state">
            <dt>状态</dt>
            <dd className={update ? undefined : "text-soft"}>
              <span style={{ fontFamily: "inherit" }}>{updateMsg || "尚未检查"}</span>
              {update && (
                <Tooltip title={update.body ?? ""}>
                  <Tag color="orange" bordered={false} style={{ marginLeft: 8 }}>
                    {update.version}
                  </Tag>
                </Tooltip>
              )}
            </dd>
          </div>
          {progress !== null && (
            <Progress
              percent={progress}
              size="small"
              strokeColor="#1f6feb"
              style={{ marginTop: 12, marginBottom: 0 }}
            />
          )}
        </FieldGroup>

        <FieldGroup
          title="网络代理"
          hint={
            proxy.mode === "custom" && proxyCheck?.ok
              ? `检查与下载均经由 ${maskProxyUrl(proxyCheck.url)}`
              : "未配置代理时自动读取 Windows 系统代理"
          }
        >
          <Radio.Group
            value={proxy.mode}
            onChange={(e) => applyProxy({ ...proxy, mode: e.target.value })}
            optionType="button"
            buttonStyle="solid"
            disabled={checking || installing}
            options={[
              { label: "跟随系统代理", value: "system" },
              { label: "自定义代理", value: "custom" },
            ]}
          />

          <div className="proxy-input">
            <Input
              value={proxy.url}
              onChange={(e) => applyProxy({ ...proxy, url: e.target.value })}
              disabled={proxy.mode === "system" || checking || installing}
              placeholder="http://127.0.0.1:25378"
              status={proxyInvalid ? "error" : undefined}
              aria-label="更新代理地址"
            />
            <Button
              onClick={() => applyProxy(DEFAULT_PROXY)}
              disabled={proxy.mode === "system" && !proxy.url}
            >
              重置
            </Button>
          </div>

          <p className="field-note">
            {proxyInvalid ? (
              <span className="note-err">{proxyCheck && !proxyCheck.ok ? proxyCheck.error : ""}</span>
            ) : (
              <>
                支持 http / https 代理，可省略协议前缀；该设置同时作用于「检查更新」与「下载安装」。
                代理地址仅保存在本机。
              </>
            )}
          </p>
        </FieldGroup>

        <div className="row-actions section-actions">
          <Button onClick={doCheck} loading={checking} type="primary" ghost>
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
      </Section>
    </div>
  );
}
