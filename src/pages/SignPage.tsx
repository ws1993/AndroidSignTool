import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  App as AntApp,
  Button,
  Checkbox,
  Col,
  Form,
  Input,
  Popconfirm,
  Radio,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
} from "antd";
import { open } from "@tauri-apps/plugin-dialog";
import LogConsole from "../components/LogConsole";
import { FieldGroup, PageGrid, Section } from "../components/Layout";
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

  const [mode, setMode] = useState<"file" | "profile">("file");
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

  const reloadProfiles = useCallback(() => {
    api
      .listProfiles()
      .then(setProfiles)
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
        label: `${p.name} · ${p.alias} · ${p.keystorePath.split(/[\\/]/).pop()}`,
      })),
    [profiles],
  );

  const doneCount = queue.filter((x) => x.state === "ok").length;
  const failCount = queue.filter((x) => x.state === "fail").length;

  return (
    <PageGrid>
      {/* ---------- 左：签名参数 ---------- */}
      <div className="stack">
        <Section
          title="签名参数"
          desc="密码经临时文件传递给 apksigner，不出现在进程命令行；勾选「保存签名」后口令以 Windows 当前用户加密（DPAPI）落盘。"
        >
          <Form layout="vertical">
            <FieldGroup title="输入与输出" hint="支持多选或粘贴路径">
              <Form.Item label="APK 文件（选择或粘贴路径，可多个）">
                <Space.Compact style={{ width: "100%" }}>
                  <Input
                    value={apkInput}
                    onChange={(e) => setApkInput(e.target.value)}
                    onPressEnter={flushApkInput}
                    placeholder={
                      queue.length
                        ? `${queue.length} 个文件已加入队列，可继续粘贴路径后回车`
                        : "粘贴 APK 路径，多个用 ; 分隔"
                    }
                  />
                  <Button onClick={flushApkInput} disabled={busy || !apkInput.trim()}>
                    加入队列
                  </Button>
                  <Button type="primary" onClick={pickApks} disabled={busy}>
                    选择文件
                  </Button>
                </Space.Compact>
              </Form.Item>

              <Form.Item label="输出目录（留空 = 与源文件同目录，输出名 xxx-signed.apk）">
                <Space.Compact style={{ width: "100%" }}>
                  <Input value={outDir} onChange={(e) => setOutDir(e.target.value)} placeholder="默认与 APK 同目录" />
                  <Button onClick={pickOutDir} disabled={busy}>
                    选择目录
                  </Button>
                </Space.Compact>
              </Form.Item>

              <Row gutter={16}>
                <Col span={14}>
                  <Form.Item label="签名策略">
                    <Select
                      value={strategy}
                      onChange={setStrategy}
                      options={strategies}
                      disabled={busy}
                    />
                  </Form.Item>
                </Col>
                <Col span={10}>
                  <Form.Item label="附加选项">
                    <Space size={16} style={{ height: 32, display: "flex", alignItems: "center" }}>
                      <span className="switch-label">
                        zipalign
                        <Switch size="small" checked={zipalignOn} onChange={setZipalignOn} disabled={busy} />
                      </span>
                      <span className="switch-label">
                        V4 增量签名
                        <Switch size="small" checked={v4} onChange={setV4} disabled={busy} />
                      </span>
                    </Space>
                  </Form.Item>
                </Col>
              </Row>
            </FieldGroup>

            <FieldGroup title="签名身份" hint="口令不会写入历史与日志">
              <Form.Item label="身份来源">
                <Radio.Group
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                  optionType="button"
                  buttonStyle="solid"
                  disabled={busy}
                  options={[
                    { label: "使用指定文件", value: "file" },
                    { label: "使用已配置签名", value: "profile" },
                  ]}
                />
              </Form.Item>

              {mode === "file" ? (
                <>
                  <Form.Item label="签名文件（.keystore / .jks / .p12）">
                    <Space.Compact style={{ width: "100%" }}>
                      <Input value={ks} onChange={(e) => setKs(e.target.value)} placeholder="C:\path\to\release.keystore" />
                      <Button onClick={pickKeystore} disabled={busy}>
                        选择
                      </Button>
                    </Space.Compact>
                  </Form.Item>

                  <Row gutter={16}>
                    <Col span={12}>
                      <Form.Item label="密钥库密码">
                        <Input.Password value={storePass} onChange={(e) => setStorePass(e.target.value)} autoComplete="new-password" />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item label="密钥密码（留空 = 同密钥库密码）">
                        <Input.Password value={keyPass} onChange={(e) => setKeyPass(e.target.value)} autoComplete="new-password" />
                      </Form.Item>
                    </Col>
                  </Row>

                  <Form.Item label="密钥别名 alias">
                    <Space.Compact style={{ width: "100%" }}>
                      <Select
                        style={{ flex: 1 }}
                        showSearch
                        allowClear
                        mode={aliases.length ? undefined : "tags"}
                        value={alias ? (aliases.length ? alias : [alias]) : undefined}
                        onChange={(v) => setAlias(Array.isArray(v) ? String(v[v.length - 1] ?? "") : String(v ?? ""))}
                        options={aliases.map((a) => ({ value: a, label: a }))}
                        placeholder="keytool -list 读取，或直接输入"
                      />
                      <Button onClick={probeAliases} disabled={busy}>
                        读取别名
                      </Button>
                    </Space.Compact>
                  </Form.Item>

                  <Form.Item style={{ marginBottom: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <Checkbox checked={saveProfile} onChange={(e) => setSaveProfile(e.target.checked)}>
                        保存签名
                      </Checkbox>
                      <Space.Compact style={{ flex: 1 }}>
                        <Input
                          value={profileName}
                          onChange={(e) => setProfileName(e.target.value)}
                          placeholder="配置名称（下次可一键选用）"
                          disabled={!saveProfile || busy}
                        />
                        <Button onClick={saveCurrentProfile} disabled={!saveProfile || busy}>
                          立即保存
                        </Button>
                      </Space.Compact>
                    </div>
                  </Form.Item>
                </>
              ) : (
                <Form.Item label="已配置签名" style={{ marginBottom: 0 }}>
                  <Select
                    value={profileId}
                    onChange={setProfileId}
                    options={profileOptions}
                    placeholder="选择本机已保存的签名配置"
                    notFoundContent="暂无配置，可在「使用指定文件」里保存一条"
                  />
                </Form.Item>
              )}
            </FieldGroup>
          </Form>

          <div className="row-actions section-actions">
            <Button type="primary" size="large" onClick={runQueue} loading={busy}>
              开始签名
            </Button>
            <Button onClick={() => setQueue([])} disabled={busy || !queue.length}>
              清空队列
            </Button>
            <Button onClick={() => setLogs([])} disabled={!logs.length}>
              清空日志
            </Button>
          </div>
        </Section>

        <Section
          title="执行日志"
          desc="zipalign → apksigner sign → apksigner verify 自检，逐行回显。"
          extra={<span className="text-faint">{logs.length ? `${logs.length} 行` : "等待任务"}</span>}
        >
          <LogConsole lines={logs} />
        </Section>
      </div>

      {/* ---------- 右：队列 + APK 信息 + 已存配置 ---------- */}
      <div className="stack">
        <Section
          title="APK 队列"
          desc="点击文件名查看包信息与现有签名方案。"
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
            <div className="empty-hint">队列为空</div>
          ) : (
            <div className="file-list">
              {queue.map((it) => (
                <div className="file-row" key={it.path}>
                  <span className="name" title={it.note || it.path} onClick={() => showInfo(it.path)} style={{ cursor: "pointer" }}>
                    {baseName(it.path)}
                  </span>
                  {stateTag(it.state)}
                  <button
                    className="rm"
                    type="button"
                    title="移出队列"
                    disabled={busy}
                    onClick={() => {
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
              ))}
            </div>
          )}
        </Section>

        <Section title="APK 信息" desc={info ? `${baseName(info.path)} · ${fmtSize(info.sizeBytes)}` : "选择队列中的文件后显示"}>
          {info ? (
            <>
              <dl className="kv">
                <dt>包名</dt>
                <dd>{info.package ?? "—"}</dd>
                <dt>版本</dt>
                <dd>
                  {info.versionName ?? "—"} ({info.versionCode ?? "—"})
                </dd>
                <dt>minSdk</dt>
                <dd>{info.minSdk ?? "—"}</dd>
                <dt>targetSdk</dt>
                <dd>{info.targetSdk ?? "—"}</dd>
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
                <dt>证书</dt>
                <dd>{info.certDn ?? "—"}</dd>
                <dt>SHA-256</dt>
                <dd>{info.certSha256 ? info.certSha256.slice(0, 64) : "—"}</dd>
              </dl>
              {info.error && <p className="field-note note-err">{info.error}</p>}
            </>
          ) : (
            <div className="empty-hint">选择一个 APK 后显示</div>
          )}
        </Section>

        <Section
          title="已保存签名配置"
          desc={profiles.length ? `共 ${profiles.length} 条` : "暂无配置"}
          extra={
            <Tooltip title="口令以 Windows DPAPI 加密，仅本机当前用户可解密；导出/日志中永不出现">
              <span className="text-faint">本机加密</span>
            </Tooltip>
          }
        >
          {profiles.length === 0 ? (
            <div className="empty-hint">暂无配置</div>
          ) : (
            <div className="file-list">
              {profiles.map((p) => (
                <div className="file-row" key={p.id}>
                  <span className="name" title={`${p.name} → ${p.keystorePath}`}>
                    {p.name} <span className="text-faint">· {p.alias}</span>
                  </span>
                  <Popconfirm
                    title={`删除配置「${p.name}」？`}
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() =>
                      api
                        .deleteProfile(p.id)
                        .then(() => {
                          reloadProfiles();
                          if (profileId === p.id) setProfileId(undefined);
                        })
                        .catch((e) => message.error(String(e)))
                    }
                  >
                    <button className="rm" type="button" title="删除配置">
                      ✕
                    </button>
                  </Popconfirm>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </PageGrid>
  );
}
