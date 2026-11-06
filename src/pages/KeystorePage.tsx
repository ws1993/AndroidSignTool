import { useEffect, useRef, useState } from "react";
import {
  App as AntApp,
  Badge,
  Button,
  Checkbox,
  Col,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Tag,
  Tooltip,
} from "antd";
import { open, save } from "@tauri-apps/plugin-dialog";
import LogConsole from "../components/LogConsole";
import { PageGrid, Section } from "../components/Layout";
import { api, baseName, uid } from "../lib/api";
import "./KeystorePage.css";

const ksFilter = [{ name: "Keystore", extensions: ["keystore", "jks", "ks", "p12"] }];
const COUNTRY_RE = /^[A-Z]{2}$/;

export default function KeystorePage() {
  const { message } = AntApp.useApp();

  // 核心生成参数
  const [outPath, setOutPath] = useState("");
  const [alias, setAlias] = useState("releasekey");
  const [storePass, setStorePass] = useState("");
  const [samePass, setSamePass] = useState(true);
  const [keyPass, setKeyPass] = useState("");
  const [cn, setCn] = useState("");

  // 高级属性（可折叠）
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [validity, setValidity] = useState(9125);
  const [keySize, setKeySize] = useState(2048);
  const [ou, setOu] = useState("");
  const [org, setOrg] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [country, setCountry] = useState("CN");

  // 保存为签名配置
  const [saveProfile, setSaveProfile] = useState(true);
  const [profileName, setProfileName] = useState("");

  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const myTasks = useRef<Set<string>>(new Set());

  // 右侧小工具：检查已有签名文件
  const [probePath, setProbePath] = useState("");
  const [probePass, setProbePass] = useState("");
  const [probeAliases, setProbeAliases] = useState<string[] | null>(null);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    const un = api.onSignLog((ev) => {
      if (!myTasks.current.has(ev.taskId)) return;
      setLogs((prev) => [...prev.slice(-1500), ev.line]);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  async function pickSavePath() {
    const p = await save({
      title: "选择签名文件生成位置",
      defaultPath: outPath || "release.keystore",
      filters: ksFilter,
    });
    if (!p) return;
    const full = String(p);
    setOutPath(full);
    if (!profileName) setProfileName(baseName(full).replace(/\.[^.]+$/, ""));
  }

  async function pickProbePath() {
    const p = await open({ title: "选择要检查的签名文件", filters: ksFilter });
    if (p) {
      setProbePath(String(p));
      setProbeAliases(null);
    }
  }

  async function doProbe(customPath?: string, customPass?: string) {
    const targetPath = customPath ?? probePath;
    const targetPass = customPass ?? probePass;
    if (!targetPath || !targetPass) {
      message.warning("请先选择签名文件并输入密钥库密码");
      return;
    }
    setProbing(true);
    try {
      const r = await api.probeKeystore(targetPath, targetPass);
      setProbeAliases(r.aliases);
      message.success(`读取到 ${r.aliases.length} 个私钥别名`);
    } catch (e) {
      setProbeAliases(null);
      message.error(String(e));
    } finally {
      setProbing(false);
    }
  }

  function copyAlias(a: string) {
    navigator.clipboard
      .writeText(a)
      .then(() => message.success(`已复制别名「${a}」到剪贴板`))
      .catch(() => message.info(`别名: ${a}`));
  }

  function validate(): string | null {
    if (!outPath.trim()) return "请选择签名文件的生成位置";
    if (!alias.trim()) return "密钥别名 alias 不能为空";
    if (storePass.length < 6) return "密钥库密码至少 6 位（keytool 强制要求）";
    if (!samePass && keyPass.length < 6) return "密钥密码至少 6 位，或改为与密钥库密码相同";
    if (!cn.trim()) return "证书所有者 CN（名字或公司名）不能为空";
    if (!COUNTRY_RE.test(country.trim())) return "国家代码必须是两位大写字母，例如 CN";
    return null;
  }

  async function doGenerate() {
    const bad = validate();
    if (bad) {
      message.warning(bad);
      return;
    }
    const taskId = uid();
    myTasks.current.add(taskId);
    setBusy(true);
    setLogs([`# 开始调用 keytool 生成 PKCS12 签名文件：${outPath}`]);
    try {
      const r = await api.generateKeystore({
        taskId,
        keystorePath: outPath.trim(),
        alias: alias.trim(),
        storePass,
        keyPass: samePass ? null : keyPass,
        validityDays: validity,
        keySize,
        commonName: cn.trim(),
        orgUnit: ou.trim(),
        org: org.trim(),
        city: city.trim(),
        state: state.trim(),
        country: country.trim().toUpperCase(),
        saveProfileName: saveProfile ? profileName.trim() || alias.trim() : null,
        strategy: "v2_with_v1",
      });
      if (r.ok) {
        message.success("签名文件已生成并通过别名自检！");
        if (r.keystorePath) {
          setProbePath(r.keystorePath);
          setProbePass(storePass);
          // 自动触发右侧检查器复验
          void doProbe(r.keystorePath, storePass);
        }
      } else {
        message.error(r.error ?? "生成失败");
      }
    } catch (e) {
      message.error(String(e));
    } finally {
      myTasks.current.delete(taskId);
      setBusy(false);
    }
  }

  return (
    <PageGrid>
      {/* ============================================================
       * 左栏：签名文件生成工作台 (聚焦核心向导 + 高级参数渐进折叠)
       * ============================================================ */}
      <div className="stack">
        <Section
          title="生成签名文件（Keystore）"
          desc="内部调用 JDK keytool 标准工具链生成标准 PKCS12 密钥库，支持一键存为 DPAPI 凭据。"
        >
          <Form layout="vertical">
            {/* 核心必填信息 */}
            <Form.Item
              label="保存位置（.keystore / .jks）"
              style={{ marginBottom: 12 }}
              required
            >
              <Space.Compact style={{ width: "100%" }}>
                <Input
                  value={outPath}
                  onChange={(e) => setOutPath(e.target.value)}
                  placeholder="选择或输入生成路径，例如 D:\keys\release.keystore"
                  disabled={busy}
                />
                <Button type="primary" onClick={pickSavePath} disabled={busy}>
                  选择保存位置
                </Button>
              </Space.Compact>
            </Form.Item>

            <Row gutter={16}>
              <Col span={12}>
                <Form.Item label="密钥别名 alias" style={{ marginBottom: 12 }} required>
                  <Input
                    value={alias}
                    onChange={(e) => setAlias(e.target.value)}
                    placeholder="例如 releasekey"
                    disabled={busy}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="证书所有者 CN"
                  style={{ marginBottom: 12 }}
                  tooltip="Common Name，填写开发者姓名、团队名或企业组织名"
                  required
                >
                  <Input
                    value={cn}
                    onChange={(e) => setCn(e.target.value)}
                    placeholder="例如 San Zhang 或 Acme Corp"
                    disabled={busy}
                  />
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={24}>
              <Col span={12}>
                <Form.Item
                  label="密钥库密码"
                  style={{ marginBottom: 12 }}
                  tooltip="至少 6 位，keytool 底层强制要求"
                  required
                >
                  <Input.Password
                    value={storePass}
                    onChange={(e) => setStorePass(e.target.value)}
                    placeholder="至少 6 位字符"
                    autoComplete="new-password"
                    disabled={busy}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={
                    <div className="pass-label-wrap">
                      <span>密钥密码</span>
                      <Checkbox
                        checked={samePass}
                        onChange={(e) => {
                          setSamePass(e.target.checked);
                          if (e.target.checked) setKeyPass("");
                        }}
                        disabled={busy}
                      >
                        同密钥库密码
                      </Checkbox>
                    </div>
                  }
                  style={{ marginBottom: 12 }}
                >
                  <Input.Password
                    value={keyPass}
                    onChange={(e) => setKeyPass(e.target.value)}
                    placeholder={samePass ? "已与密钥库密码保持一致" : "至少 6 位字符"}
                    disabled={samePass || busy}
                    autoComplete="new-password"
                  />
                </Form.Item>
              </Col>
            </Row>

            {/* 高级属性与规格（渐进式折叠） */}
            <div className="advanced-dn-panel">
              <div
                className="advanced-dn-toggle"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                <span>
                  ⚙️ 证书高级属性与算法规格{" "}
                  <span className="text-faint" style={{ fontWeight: "normal", fontSize: 12 }}>
                    （{showAdvanced ? "点击收起" : "OU / 组织 / 地理位置 / RSA 规格，默认收起"}）
                  </span>
                </span>
                <span className="text-faint" style={{ fontSize: 12 }}>
                  {showAdvanced ? "▲ 收起" : "▼ 展开"}
                </span>
              </div>

              {showAdvanced && (
                <div className="advanced-dn-content">
                  <Row gutter={16}>
                    <Col span={12}>
                      <Form.Item label="密钥算法与长度" style={{ marginBottom: 12 }}>
                        <Select
                          value={keySize}
                          onChange={setKeySize}
                          disabled={busy}
                          options={[
                            { value: 2048, label: "RSA 2048 位（标准推荐）" },
                            { value: 4096, label: "RSA 4096 位（高安全性）" },
                          ]}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item
                        label="有效期（天）"
                        style={{ marginBottom: 12 }}
                        tooltip="默认 9125 天约等于 25 年，符合 Google Play 规范"
                      >
                        <InputNumber
                          min={1}
                          max={36500}
                          value={validity}
                          onChange={(v) => setValidity(Number(v ?? 9125))}
                          style={{ width: "100%" }}
                          disabled={busy}
                        />
                      </Form.Item>
                    </Col>
                  </Row>

                  <Row gutter={16}>
                    <Col span={12}>
                      <Form.Item label="组织单位 OU" style={{ marginBottom: 12 }}>
                        <Input
                          value={ou}
                          onChange={(e) => setOu(e.target.value)}
                          placeholder="例如 Mobile Dev Team"
                          disabled={busy}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item label="企业组织 O" style={{ marginBottom: 12 }}>
                        <Input
                          value={org}
                          onChange={(e) => setOrg(e.target.value)}
                          placeholder="例如 Acme Inc."
                          disabled={busy}
                        />
                      </Form.Item>
                    </Col>
                  </Row>

                  <Row gutter={16}>
                    <Col span={8}>
                      <Form.Item label="城市 L" style={{ marginBottom: 0 }}>
                        <Input
                          value={city}
                          onChange={(e) => setCity(e.target.value)}
                          placeholder="例如 Beijing"
                          disabled={busy}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={8}>
                      <Form.Item label="省份 / 州 ST" style={{ marginBottom: 0 }}>
                        <Input
                          value={state}
                          onChange={(e) => setState(e.target.value)}
                          placeholder="例如 Beijing"
                          disabled={busy}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={8}>
                      <Form.Item
                        label="国家代码 C"
                        style={{ marginBottom: 0 }}
                        tooltip="两位大写字母代码，例如 CN, US"
                      >
                        <Input
                          value={country}
                          maxLength={2}
                          onChange={(e) => setCountry(e.target.value.toUpperCase())}
                          disabled={busy}
                        />
                      </Form.Item>
                    </Col>
                  </Row>
                </div>
              )}
            </div>

            {/* 生成后保存配置 */}
            <div style={{ marginTop: 16 }}>
              <Form.Item style={{ marginBottom: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Checkbox
                    checked={saveProfile}
                    onChange={(e) => setSaveProfile(e.target.checked)}
                    disabled={busy}
                  >
                    生成后同步保存为签名配置
                  </Checkbox>
                  <Input
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    disabled={!saveProfile || busy}
                    placeholder="配置别称（保存后在签名页立即可选）"
                    style={{ flex: 1 }}
                  />
                </div>
              </Form.Item>
            </div>
          </Form>

          {/* 操作主按钮条 */}
          <div className="row-actions section-actions" style={{ marginTop: 20 }}>
            <Button
              type="primary"
              size="large"
              onClick={doGenerate}
              loading={busy}
              disabled={!outPath.trim() || !storePass}
            >
              立即生成签名文件
            </Button>
          </div>
        </Section>
      </div>

      {/* ============================================================
       * 右栏：辅助工具 (Keystore 检查工具 + 实时生成日志)
       * ============================================================ */}
      <div className="stack">
        {/* 辅助工具：检查已有签名文件 */}
        <Section
          title="🔍 检查已有签名文件"
          desc="选择本地 Keystore 并输入密码，直接调用 keytool 列出其中的私钥别名。"
        >
          <Form layout="vertical">
            <Form.Item label="签名文件（.keystore / .jks / .p12）" style={{ marginBottom: 12 }}>
              <Space.Compact style={{ width: "100%" }}>
                <Input
                  value={probePath}
                  onChange={(e) => setProbePath(e.target.value)}
                  placeholder="选择或粘贴文件路径"
                  disabled={probing}
                />
                <Button onClick={pickProbePath} disabled={probing}>
                  浏览
                </Button>
              </Space.Compact>
            </Form.Item>

            <Row gutter={12}>
              <Col span={15}>
                <Form.Item label="密钥库密码" style={{ marginBottom: 12 }}>
                  <Input.Password
                    value={probePass}
                    onChange={(e) => setProbePass(e.target.value)}
                    placeholder="输入密码"
                    autoComplete="new-password"
                    disabled={probing}
                  />
                </Form.Item>
              </Col>
              <Col span={9} style={{ display: "flex", alignItems: "flex-end" }}>
                <Form.Item style={{ marginBottom: 12, width: "100%" }}>
                  <Button
                    block
                    type="default"
                    onClick={() => void doProbe()}
                    loading={probing}
                    disabled={!probePath.trim() || !probePass}
                  >
                    读取别名
                  </Button>
                </Form.Item>
              </Col>
            </Row>

            <Form.Item label="读取到的私钥别名" style={{ marginBottom: 0 }}>
              <div className="alias-tag-container">
                {(probeAliases ?? []).map((a) => (
                  <Tooltip key={a} title="点击复制别名">
                    <Tag
                      color="blue"
                      bordered={false}
                      className="alias-clickable-tag"
                      onClick={() => copyAlias(a)}
                    >
                      {a}
                    </Tag>
                  </Tooltip>
                ))}
                {probeAliases === null && <span className="empty-hint inline">尚未读取</span>}
                {probeAliases?.length === 0 && (
                  <span className="empty-hint inline">未在该密钥库中找到私钥条目</span>
                )}
              </div>
            </Form.Item>
          </Form>
        </Section>

        {/* 执行日志 */}
        <Section
          title="🖥️ 执行与生成日志"
          desc="keytool 命令参数安全隔离回显及自检输出。"
          extra={
            logs.length > 0 ? (
              <Space size={8}>
                <Badge count={logs.length} overflowCount={999} style={{ backgroundColor: "#94a3b8" }} />
                <Button size="small" type="link" onClick={() => setLogs([])}>
                  清空日志
                </Button>
              </Space>
            ) : (
              <span className="text-faint">等待任务</span>
            )
          }
        >
          <LogConsole lines={logs} />
        </Section>
      </div>
    </PageGrid>
  );
}
