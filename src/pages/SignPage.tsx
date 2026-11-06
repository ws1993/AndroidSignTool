import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  App as AntApp,
  Badge,
  Button,
  Checkbox,
  Col,
  Form,
  Input,
  Row,
  Segmented,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  Tooltip,
} from "antd";
import { open } from "@tauri-apps/plugin-dialog";
import LogConsole from "../components/LogConsole";
import { PageGrid, Section } from "../components/Layout";
import {
  api,
  baseName,
  dirName,
  fmtSize,
  uid,
  type ApkInfo,
  type ProfileMeta,
  type StrategyOption,
} from "../lib/api";
import "./SignPage.css";

type ItemState = "idle" | "running" | "ok" | "fail";
type QueueItem = { path: string; state: ItemState; note?: string; taskId?: string };

const apkFilter = [{ name: "APK", extensions: ["apk"] }];

export default function SignPage() {
  const { message } = AntApp.useApp();
  const [strategies, setStrategies] = useState<StrategyOption[]>([]);
  const [profiles, setProfiles] = useState<ProfileMeta[]>([]);

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [apkInput, setApkInput] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [info, setInfo] = useState<ApkInfo | null>(null);

  const [outDir, setOutDir] = useState("");
  const [strategy, setStrategy] = useState("v2_with_v1");
  const [v4, setV4] = useState(false);
  const [zipalignOn, setZipalignOn] = useState(true);

  // 凭据模式：优先使用已保存配置（若无则切至指定文件）
  const [mode, setMode] = useState<"profile" | "file">("profile");
  const [profileId, setProfileId] = useState<number | undefined>(undefined);
  const [ks, setKs] = useState("");
  const [alias, setAlias] = useState("");
  const [aliases, setAliases] = useState<string[]>([]);
  const [storePass, setStorePass] = useState("");
  const [keyPass, setKeyPass] = useState("");

  const [saveProfile, setSaveProfile] = useState(false);
  const [profileName, setProfileName] = useState("");

  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const myTasks = useRef<Set<string>>(new Set());

  // 右侧工作台活动 Tab（"info" 属性检查 | "logs" 执行日志）
  const [activeWorkbenchTab, setActiveWorkbenchTab] = useState<"info" | "logs">("info");

  const reloadProfiles = useCallback(() => {
    api
      .listProfiles()
      .then((list) => {
        setProfiles(list);
        if (list.length > 0) {
          setProfileId((prev) => (prev !== undefined && list.some((p) => p.id === prev) ? prev : list[0].id));
        } else {
          setMode("file");
        }
      })
      .catch((e) => message.error(String(e)));
  }, [message]);

  useEffect(() => {
    api.listStrategies().then(setStrategies).catch(() => undefined);
    reloadProfiles();
    const un = api.onSignLog((ev) => {
      if (!myTasks.current.has(ev.taskId)) return;
      setLogs((prev) => [...prev.slice(-1500), ev.line]);
    });
    return () => {
      un.then((f) => f());
    };
  }, [reloadProfiles]);

  const showInfo = useCallback(
    async (path: string) => {
      setPreview(path);
      try {
        setInfo(await api.apkInfo(path));
      } catch (e) {
        setInfo(null);
        message.error(String(e));
      }
    },
    [message],
  );

  const addQueue = useCallback(
    (paths: string[]): QueueItem[] => {
      const clean = paths
        .flatMap((p) => p.split(";"))
        .map((p) => p.trim().replace(/^"|"$/g, ""))
        .filter(Boolean);
      if (!clean.length) return queue;
      const seen = new Set(queue.map((p) => p.path));
      const add = clean
        .filter((p) => !seen.has(p))
        .map((p) => ({ path: p, state: "idle" as ItemState }));
      const merged = [...queue, ...add];
      setQueue(merged);
      if (!preview && merged.length) void showInfo(merged[0].path);
      if (!outDir) {
        const d = dirName(clean[0]);
        if (d) setOutDir(d);
      }
      return merged;
    },
    [queue, preview, showInfo, outDir],
  );

  async function pickApks() {
    const picked = await open({ multiple: true, title: "选择要签名的 APK", filters: apkFilter });
    if (!picked) return;
    addQueue((Array.isArray(picked) ? picked : [picked]).filter(Boolean) as string[]);
  }

  function flushApkInput(): QueueItem[] {
    const merged = addQueue([apkInput]);
    setApkInput("");
    return merged;
  }

  async function pickOutDir() {
    const d = await open({ directory: true, title: "选择输出目录", defaultPath: outDir || undefined });
    if (d) setOutDir(d as string);
  }

  async function pickKeystore() {
    const p = await open({
      title: "选择签名文件（keystore）",
      filters: [{ name: "Keystore", extensions: ["keystore", "jks", "ks", "p12"] }],
    });
    if (p) {
      setKs(p as string);
      setAliases([]);
    }
  }

  async function probeAliases() {
    if (!ks || !storePass) {
      message.warning("请先选择签名文件并填写密钥库密码");
      return;
    }
    try {
      const r = await api.probeKeystore(ks, storePass);
      setAliases(r.aliases);
      if (r.aliases.length === 1) setAlias(r.aliases[0]);
      message.success(`读取到 ${r.aliases.length} 个私钥别名`);
    } catch (e) {
      setAliases([]);
      message.error(String(e));
    }
  }

  async function saveCurrentProfile() {
    if (!ks || !alias || !storePass) {
      message.warning("签名文件、别名与密钥库密码需先填写完整");
      return;
    }
    const name = profileName.trim() || "默认签名";
    try {
      const meta = await api.saveProfile({
        name,
        keystorePath: ks,
        alias,
        storePass,
        keyPass: keyPass || null,
        strategy,
      });
      setProfileName(meta.name);
      setSaveProfile(true);
      reloadProfiles();
      message.success(`已保存签名配置「${meta.name}」`);
    } catch (e) {
      message.error(String(e));
    }
  }

  async function runQueue() {
    if (busy) return;
    const items = apkInput.trim() ? flushApkInput() : queue;
    if (!items.length) return message.warning("请先添加 APK 文件");
    if (mode === "file" && (!ks.trim() || !alias.trim() || !storePass))
      return message.warning("请填写签名文件、密钥别名与密钥库密码");
    if (mode === "profile" && profileId == null) return message.warning("请选择已配置签名");
    if (saveProfile && !profileName.trim()) return message.warning("请填写要保存的签名配置名称");

    setBusy(true);
    // 自动平滑切至实时执行日志
    setActiveWorkbenchTab("logs");
    setLogs((p) => [...p, `# 开始批量签名，共 ${items.length} 个文件`]);
    let okCount = 0;
    for (const item of items) {
      const taskId = uid();
      myTasks.current.add(taskId);
      setQueue((q) => q.map((x) => (x.path === item.path ? { ...x, state: "running", taskId } : x)));
      try {
        const res = await api.signApk({
          taskId,
          apkPath: item.path,
          outDir: outDir.trim() ? outDir.trim() : null,
          strategy,
          v4,
          zipalignEnabled: zipalignOn,
          keystorePath: mode === "file" ? ks.trim() : null,
          alias: mode === "file" ? alias.trim() : null,
          storePass: mode === "file" ? storePass : null,
          keyPass: mode === "file" ? keyPass || null : null,
          profileId: mode === "profile" ? profileId ?? null : null,
          saveProfileName:
            saveProfile && mode === "file" && profileName.trim() ? profileName.trim() : null,
        });
        setQueue((q) =>
          q.map((x) =>
            x.path === item.path
              ? { ...x, state: res.ok ? "ok" : "fail", note: res.ok ? res.outputApk ?? "" : res.error ?? "" }
              : x,
          ),
        );
        if (res.ok) okCount += 1;
      } catch (e) {
        setQueue((q) =>
          q.map((x) => (x.path === item.path ? { ...x, state: "fail", note: String(e) } : x)),
        );
      }
    }
    setBusy(false);
    reloadProfiles();
    if (okCount === items.length) message.success(`全部签名完成（${okCount}/${items.length}）`);
    else message.warning(`完成 ${okCount}/${items.length}，失败项见日志`);
  }

  const stateTag = (s: ItemState) =>
    s === "ok" ? (
      <Tag color="green" bordered={false}>
        已签名
      </Tag>
    ) : s === "fail" ? (
      <Tag color="red" bordered={false}>
        失败
      </Tag>
    ) : s === "running" ? (
      <Tag color="blue" bordered={false}>
        签名中
      </Tag>
    ) : (
      <Tag bordered={false}>待处理</Tag>
    );

  const profileOptions = useMemo(
    () =>
      profiles.map((p) => ({
        value: p.id,
        label: `${p.name} · ${p.alias} (${p.keystorePath.split(/[\\/]/).pop()})`,
      })),
    [profiles],
  );

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === profileId),
    [profiles, profileId],
  );

  const doneCount = queue.filter((x) => x.state === "ok").length;
  const failCount = queue.filter((x) => x.state === "fail").length;

  return (
    <PageGrid>
      {/* ============================================================
       * 左栏：配置流水线 (Step 1 -> Step 2 -> Step 3 -> Action Bar)
       * ============================================================ */}
      <div className="stack">
        {/* 步骤 1：待签文件与输出 */}
        <Section
          title={
            <span className="sign-step-head">
              <span className="sign-step-num">1</span>
              待签 APK 与输出目标
            </span>
          }
          desc="添加待签名的 APK 文件；支持批量多选、路径粘贴与输出目录自定义。"
          extra={
            queue.length ? (
              <Tag color="processing" bordered={false}>
                已入队 {queue.length} 个
              </Tag>
            ) : null
          }
        >
          <Form layout="vertical">
            <Form.Item label="APK 文件路径" style={{ marginBottom: 12 }}>
              <Space.Compact style={{ width: "100%" }}>
                <Input
                  value={apkInput}
                  onChange={(e) => setApkInput(e.target.value)}
                  onPressEnter={flushApkInput}
                  placeholder={
                    queue.length
                      ? `${queue.length} 个文件在右侧队列中，可继续粘贴路径并回车加入`
                      : "粘贴本地 APK 路径（多个文件用 ; 分隔）"
                  }
                  disabled={busy}
                />
                <Button onClick={flushApkInput} disabled={busy || !apkInput.trim()}>
                  加入队列
                </Button>
                <Button type="primary" onClick={pickApks} disabled={busy}>
                  浏览文件
                </Button>
              </Space.Compact>
            </Form.Item>

            <Form.Item
              label="签名输出目录"
              style={{ marginBottom: 0 }}
              tooltip="留空将默认在源 APK 同级目录下生成 xxx-signed.apk"
            >
              <Space.Compact style={{ width: "100%" }}>
                <Input
                  value={outDir}
                  onChange={(e) => setOutDir(e.target.value)}
                  placeholder="默认输出至源 APK 同目录"
                  disabled={busy}
                />
                <Button onClick={pickOutDir} disabled={busy}>
                  选择目录
                </Button>
              </Space.Compact>
            </Form.Item>
          </Form>
        </Section>

        {/* 步骤 2：签名身份凭据 */}
        <Section
          title={
            <span className="sign-step-head">
              <span className="sign-step-num">2</span>
              签名身份凭据
            </span>
          }
          desc="口令经系统临时隔离管道传递，支持 Windows DPAPI 本机加密存储。"
        >
          <div className="sign-mode-switch-wrap">
            <Segmented
              block
              value={mode}
              onChange={(v) => setMode(v as "profile" | "file")}
              disabled={busy}
              options={[
                {
                  label: `⚡ 选用已保存配置 (${profiles.length})`,
                  value: "profile",
                },
                {
                  label: "📁 自定义签名文件",
                  value: "file",
                },
              ]}
            />
          </div>

          <Form layout="vertical">
            {mode === "profile" ? (
              profiles.length === 0 ? (
                <div className="profile-empty-alert">
                  暂未检测到已保存的签名配置。请切换至「自定义签名文件」输入并保存，或在设置页面添加。
                </div>
              ) : (
                <>
                  <Form.Item label="选择签名配置" style={{ marginBottom: 8 }}>
                    <Select
                      value={profileId}
                      onChange={setProfileId}
                      options={profileOptions}
                      placeholder="选择本机已保存的签名配置"
                      disabled={busy}
                    />
                  </Form.Item>

                  {activeProfile && (
                    <div className="profile-summary-card">
                      <div className="profile-summary-main">
                        <div className="profile-summary-tags">
                          <Tag color="blue" bordered={false} style={{ fontWeight: 600 }}>
                            {activeProfile.name}
                          </Tag>
                          <Tag bordered={false}>别名: {activeProfile.alias}</Tag>
                          <Tooltip title="口令经 Windows DPAPI 本机物理级加密隔离，运行签名时内存直通">
                            <Tag color="cyan" bordered={false}>
                              DPAPI 安全加密
                            </Tag>
                          </Tooltip>
                        </div>
                      </div>
                      <div className="profile-summary-path" title={activeProfile.keystorePath}>
                        Keystore: {activeProfile.keystorePath}
                      </div>
                    </div>
                  )}
                </>
              )
            ) : (
              <>
                <Form.Item label="签名文件（.keystore / .jks / .p12）" style={{ marginBottom: 12 }}>
                  <Space.Compact style={{ width: "100%" }}>
                    <Input
                      value={ks}
                      onChange={(e) => setKs(e.target.value)}
                      placeholder="C:\path\to\release.keystore"
                      disabled={busy}
                    />
                    <Button onClick={pickKeystore} disabled={busy}>
                      选择
                    </Button>
                  </Space.Compact>
                </Form.Item>

                <Row gutter={16}>
                  <Col span={12}>
                    <Form.Item label="密钥库密码" style={{ marginBottom: 12 }}>
                      <Input.Password
                        value={storePass}
                        onChange={(e) => setStorePass(e.target.value)}
                        autoComplete="new-password"
                        disabled={busy}
                      />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item
                      label="密钥密码"
                      style={{ marginBottom: 12 }}
                      tooltip="若私钥密码与密钥库密码相同，可直接留空"
                    >
                      <Input.Password
                        value={keyPass}
                        onChange={(e) => setKeyPass(e.target.value)}
                        placeholder="留空 = 同密钥库密码"
                        autoComplete="new-password"
                        disabled={busy}
                      />
                    </Form.Item>
                  </Col>
                </Row>

                <Form.Item label="密钥别名 alias" style={{ marginBottom: 12 }}>
                  <Space.Compact style={{ width: "100%" }}>
                    <Select
                      style={{ flex: 1 }}
                      showSearch
                      allowClear
                      mode={aliases.length ? undefined : "tags"}
                      value={alias ? (aliases.length ? alias : [alias]) : undefined}
                      onChange={(v) =>
                        setAlias(Array.isArray(v) ? String(v[v.length - 1] ?? "") : String(v ?? ""))
                      }
                      options={aliases.map((a) => ({ value: a, label: a }))}
                      placeholder="keytool 读取或直接输入别名"
                      disabled={busy}
                    />
                    <Button onClick={probeAliases} disabled={busy || !ks || !storePass}>
                      读取别名
                    </Button>
                  </Space.Compact>
                </Form.Item>

                <Form.Item style={{ marginBottom: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <Checkbox
                      checked={saveProfile}
                      onChange={(e) => setSaveProfile(e.target.checked)}
                      disabled={busy}
                    >
                      保存此签名配置
                    </Checkbox>
                    <Space.Compact style={{ flex: 1 }}>
                      <Input
                        value={profileName}
                        onChange={(e) => setProfileName(e.target.value)}
                        placeholder="配置名称（下次可一键选用）"
                        disabled={!saveProfile || busy}
                      />
                      <Button
                        onClick={saveCurrentProfile}
                        disabled={!saveProfile || busy || !ks || !alias || !storePass}
                      >
                        立即保存
                      </Button>
                    </Space.Compact>
                  </div>
                </Form.Item>
              </>
            )}
          </Form>
        </Section>

        {/* 步骤 3：签名策略与高级选项 */}
        <Section
          title={
            <span className="sign-step-head">
              <span className="sign-step-num subtle">3</span>
              签名策略与优化选项
            </span>
          }
          desc="选择 APK 签名方案（V1/V2/V3），并可选进行 zipalign 4字节对齐及 V4 签名。"
        >
          <Form layout="vertical">
            <Row gutter={16}>
              <Col span={14}>
                <Form.Item label="签名策略" style={{ marginBottom: 0 }}>
                  <Select
                    value={strategy}
                    onChange={setStrategy}
                    options={strategies}
                    disabled={busy}
                  />
                </Form.Item>
              </Col>
              <Col span={10}>
                <Form.Item label="附加优化选项" style={{ marginBottom: 0 }}>
                  <Space size={16} style={{ height: 32, display: "flex", alignItems: "center" }}>
                    <span className="switch-label">
                      zipalign 对齐
                      <Switch size="small" checked={zipalignOn} onChange={setZipalignOn} disabled={busy} />
                    </span>
                    <span className="switch-label">
                      V4 增量
                      <Switch size="small" checked={v4} onChange={setV4} disabled={busy} />
                    </span>
                  </Space>
                </Form.Item>
              </Col>
            </Row>
          </Form>
        </Section>

        {/* 底部常驻主操作面板 */}
        <div className="sign-actions-card">
          <div className="sign-actions-left">
            <Button
              type="primary"
              size="large"
              onClick={runQueue}
              loading={busy}
              disabled={!queue.length && !apkInput.trim()}
            >
              开始批量签名 {queue.length ? `(${queue.length})` : ""}
            </Button>
            <Button onClick={() => setQueue([])} disabled={busy || !queue.length}>
              清空队列
            </Button>
          </div>

          <div className="sign-actions-summary">
            {queue.length ? (
              <span>
                待签 <b>{queue.length}</b> 个文件
              </span>
            ) : (
              <span className="text-faint">请在上方添加待签 APK</span>
            )}
            {mode === "profile" && activeProfile ? (
              <Tag color="blue" bordered={false}>
                {activeProfile.name}
              </Tag>
            ) : null}
          </div>
        </div>
      </div>

      {/* ============================================================
       * 右栏：任务队列 + 联动工作台 (Tabs: APK 属性检查 / 实时执行日志)
       * ============================================================ */}
      <div className="stack">
        {/* 待签任务队列 */}
        <Section
          title="待签任务队列"
          desc="点击文件行可高亮并在下方查看包属性与现有签名。"
          extra={
            queue.length ? (
              <span className="queue-stats">
                <span>共 {queue.length}</span>
                <span className="ok">成功 {doneCount}</span>
                <span className="fail">失败 {failCount}</span>
              </span>
            ) : null
          }
        >
          {queue.length === 0 ? (
            <div className="empty-hint">暂无待签文件，请在左侧添加 APK</div>
          ) : (
            <div className="file-list">
              {queue.map((it) => {
                const isSelected = preview === it.path;
                return (
                  <div
                    className={`queue-file-row ${isSelected ? "selected" : ""}`}
                    key={it.path}
                    onClick={() => {
                      showInfo(it.path);
                    }}
                  >
                    <div className="name" title={it.note || it.path}>
                      {baseName(it.path)}
                    </div>
                    {stateTag(it.state)}
                    <button
                      className="rm"
                      type="button"
                      title="移出队列"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        setQueue((q) => q.filter((x) => x.path !== it.path));
                        if (preview === it.path) {
                          setPreview(null);
                          setInfo(null);
                        }
                      }}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        {/* 联动工作台：选项卡二合一（属性检查 / 实时执行日志） */}
        <Section
          title="联动工作台"
          desc="查看当前选中 APK 的包体属性，或观察构建命令与验签日志。"
          extra={
            activeWorkbenchTab === "logs" && logs.length > 0 ? (
              <Button size="small" type="link" onClick={() => setLogs([])}>
                清空日志
              </Button>
            ) : null
          }
        >
          <Tabs
            className="workbench-card"
            activeKey={activeWorkbenchTab}
            onChange={(k) => setActiveWorkbenchTab(k as "info" | "logs")}
            items={[
              {
                key: "info",
                label: "📦 APK 属性与签名检查",
                children: info ? (
                  <>
                    <dl className="kv">
                      <dt>文件</dt>
                      <dd title={info.path}>
                        {baseName(info.path)} · {fmtSize(info.sizeBytes)}
                      </dd>
                      <dt>包名</dt>
                      <dd>{info.package ?? "—"}</dd>
                      <dt>版本</dt>
                      <dd>
                        {info.versionName ?? "—"} ({info.versionCode ?? "—"})
                      </dd>
                      <dt>minSdk / targetSdk</dt>
                      <dd>
                        {info.minSdk ?? "—"} / {info.targetSdk ?? "—"}
                      </dd>
                      <dt>现有签名</dt>
                      <dd>
                        {info.schemes.length ? (
                          info.schemes.map((s) => (
                            <Tag key={s} color="green" bordered={false}>
                              {s}
                            </Tag>
                          ))
                        ) : (
                          <span className="text-faint">未签名 / 验签失败</span>
                        )}
                      </dd>
                      <dt>证书 DN</dt>
                      <dd>{info.certDn ?? "—"}</dd>
                      <dt>SHA-256</dt>
                      <dd>{info.certSha256 ? info.certSha256.slice(0, 64) : "—"}</dd>
                    </dl>
                    {info.error && <p className="field-note note-err">{info.error}</p>}
                  </>
                ) : (
                  <div className="empty-hint">在上方队列中点击任一 APK 查看属性与现有签名</div>
                ),
              },
              {
                key: "logs",
                label: (
                  <span>
                    🖥️ 实时执行日志{" "}
                    {logs.length > 0 && (
                      <Badge
                        count={logs.length}
                        overflowCount={999}
                        style={{ backgroundColor: "#94a3b8", marginLeft: 4 }}
                      />
                    )}
                  </span>
                ),
                children: (
                  <div>
                    <LogConsole lines={logs} />
                  </div>
                ),
              },
            ]}
          />
        </Section>
      </div>
    </PageGrid>
  );
}
