import { useEffect, useRef, useState } from "react";
import {
  App as AntApp,
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
} from "antd";
import { open, save } from "@tauri-apps/plugin-dialog";
import LogConsole from "../components/LogConsole";
import { FieldGroup, PageGrid, Section } from "../components/Layout";
import { api, baseName, uid } from "../lib/api";

const ksFilter = [{ name: "Keystore", extensions: ["keystore", "jks", "ks", "p12"] }];
const COUNTRY_RE = /^[A-Z]{2}$/;

export default function KeystorePage() {
  const { message } = AntApp.useApp();

  const [outPath, setOutPath] = useState("");
  const [alias, setAlias] = useState("releasekey");
  const [storePass, setStorePass] = useState("");
  const [samePass, setSamePass] = useState(true);
  const [keyPass, setKeyPass] = useState("");
  const [validity, setValidity] = useState(9125);
  const [keySize, setKeySize] = useState(2048);

  const [cn, setCn] = useState("");
  const [ou, setOu] = useState("");
  const [org, setOrg] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [country, setCountry] = useState("CN");

  const [saveProfile, setSaveProfile] = useState(true);
  const [profileName, setProfileName] = useState("");

  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const myTasks = useRef<Set<string>>(new Set());

  // 独立小工具：读取已有 keystore 的别名
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

  async function doProbe() {
    if (!probePath || !probePass) {
      message.warning("请先选择签名文件并输入密钥库密码");
      return;
    }
    setProbing(true);
    try {
      const r = await api.probeKeystore(probePath, probePass);
      setProbeAliases(r.aliases);
      message.success(`共 ${r.aliases.length} 个私钥别名`);
    } catch (e) {
      setProbeAliases(null);
      message.error(String(e));
    } finally {
      setProbing(false);
    }
  }

  function validate(): string | null {
    if (!outPath.trim()) return "请选择签名文件的生成位置";
    if (!alias.trim()) return "密钥别名 alias 不能为空";
    if (storePass.length < 6) return "密钥库密码至少 6 位（keytool 强制要求）";
    if (!samePass && keyPass.length < 6) return "密钥密码至少 6 位，或改为与密钥库密码相同";
    if (!cn.trim()) return "证书所有者 CN 不能为空";
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
    setLogs([`# 生成 PKCS12 签名文件：${outPath}`]);
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
        orgUnit: ou,
        org,
        city,
        state,
        country: country.trim().toUpperCase(),
        saveProfileName: saveProfile ? profileName.trim() || alias.trim() : null,
        strategy: "v2_with_v1",
      });
      if (r.ok) {
        message.success("签名文件已生成并通过别名自检");
        if (r.keystorePath) setProbePath(r.keystorePath);
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
      <div className="stack">
        <Section
          title="生成签名文件（keystore）"
          desc={
            <>
              内部调用内置 <code>keytool -genkeypair</code>，默认 PKCS12 + RSA 2048，有效期 9125 天（25 年）。
              密码通过临时文件传入，不出现在进程命令行。
            </>
          }
        >
          <Form layout="vertical">
            <FieldGroup title="输出位置与密钥" hint="密码 ≥ 6 位">
              <Form.Item label="生成位置（.keystore / .jks）">
                <Space.Compact style={{ width: "100%" }}>
                  <Input
                    value={outPath}
                    onChange={(e) => setOutPath(e.target.value)}
                    placeholder="C:\keys\release.keystore"
                  />
                  <Button onClick={pickSavePath} disabled={busy}>
                    选择位置
                  </Button>
                </Space.Compact>
              </Form.Item>

              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item label="密钥别名 alias">
                    <Input value={alias} onChange={(e) => setAlias(e.target.value)} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="密钥算法 / 长度">
                    <Space.Compact style={{ width: "100%" }}>
                      <Input value="RSA" readOnly style={{ width: 72 }} />
                      <Select
                        value={keySize}
                        onChange={setKeySize}
                        options={[
                          { value: 2048, label: "2048 位（推荐）" },
                          { value: 4096, label: "4096 位" },
                        ]}
                      />
                    </Space.Compact>
                  </Form.Item>
                </Col>
              </Row>

              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item label="密钥库密码（≥6 位）">
                    <Input.Password
                      value={storePass}
                      onChange={(e) => setStorePass(e.target.value)}
                      autoComplete="new-password"
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    label={
                      <Space size={8}>
                        <span>密钥密码</span>
                        <Checkbox
                          checked={samePass}
                          onChange={(e) => {
                            setSamePass(e.target.checked);
                            if (e.target.checked) setKeyPass("");
                          }}
                        >
                          与密钥库相同
                        </Checkbox>
                      </Space>
                    }
                  >
                    <Input.Password
                      value={keyPass}
                      onChange={(e) => setKeyPass(e.target.value)}
                      disabled={samePass}
                      autoComplete="new-password"
                    />
                  </Form.Item>
                </Col>
              </Row>
            </FieldGroup>

            <FieldGroup title="证书所有者（DN）" hint="CN 必填，国家为两位大写">
              <Form.Item label="CN（证书所有者）">
                <Input
                  value={cn}
                  onChange={(e) => setCn(e.target.value)}
                  placeholder="例如 San Zhang 或 公司名"
                />
              </Form.Item>

              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item label="组织单位 OU">
                    <Input value={ou} onChange={(e) => setOu(e.target.value)} placeholder="Mobile Dev" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="组织 O">
                    <Input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Example Inc." />
                  </Form.Item>
                </Col>
              </Row>

              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item label="城市 L">
                    <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Beijing" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="省份 ST">
                    <Input value={state} onChange={(e) => setState(e.target.value)} placeholder="Beijing" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="国家 C（两位大写）">
                    <Input
                      value={country}
                      maxLength={2}
                      onChange={(e) => setCountry(e.target.value.toUpperCase())}
                    />
                  </Form.Item>
                </Col>
              </Row>
            </FieldGroup>

            <FieldGroup title="有效期与保存" hint="可选保存为签名配置">
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item label="有效期（天）" style={{ marginBottom: 0 }}>
                    <InputNumber
                      min={1}
                      max={36500}
                      value={validity}
                      onChange={(v) => setValidity(Number(v ?? 9125))}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="生成后保存为签名配置" style={{ marginBottom: 0 }}>
                    <Space.Compact style={{ width: "100%" }}>
                      <Checkbox
                        checked={saveProfile}
                        onChange={(e) => setSaveProfile(e.target.checked)}
                      >
                        保存
                      </Checkbox>
                      <Input
                        value={profileName}
                        onChange={(e) => setProfileName(e.target.value)}
                        disabled={!saveProfile}
                        placeholder="配置名称"
                      />
                    </Space.Compact>
                  </Form.Item>
                </Col>
              </Row>
            </FieldGroup>
          </Form>

          <div className="row-actions section-actions">
            <Button type="primary" size="large" onClick={doGenerate} loading={busy}>
              生成签名文件
            </Button>
            <Button onClick={() => setLogs([])} disabled={!logs.length}>
              清空日志
            </Button>
          </div>
        </Section>

        <Section
          title="检查已有签名文件"
          desc={
            <>
              用 <code>keytool -list</code> 校验密码并列出全部 PrivateKeyEntry 别名，密码错误会直接回显原因。
            </>
          }
        >
          <Form layout="vertical">
            <Form.Item label="签名文件">
              <Space.Compact style={{ width: "100%" }}>
                <Input
                  value={probePath}
                  onChange={(e) => setProbePath(e.target.value)}
                  placeholder="C:\keys\release.keystore"
                />
                <Button onClick={pickProbePath} disabled={probing}>
                  选择
                </Button>
              </Space.Compact>
            </Form.Item>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item label="密钥库密码" style={{ marginBottom: 0 }}>
                  <Input.Password
                    value={probePass}
                    onChange={(e) => setProbePass(e.target.value)}
                    autoComplete="new-password"
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label="读取到的别名" style={{ marginBottom: 0 }}>
                  <div className="alias-row">
                    {(probeAliases ?? []).map((a) => (
                      <Tag key={a} color="blue" bordered={false}>
                        {a}
                      </Tag>
                    ))}
                    {probeAliases === null && <span className="empty-hint inline">尚未读取</span>}
                    {probeAliases?.length === 0 && <span className="empty-hint inline">无私钥条目</span>}
                  </div>
                </Form.Item>
              </Col>
            </Row>
          </Form>

          <div className="row-actions section-actions">
            <Button onClick={doProbe} loading={probing}>
              读取别名
            </Button>
          </div>
        </Section>
      </div>

      <Section
        title="生成日志"
        desc="keytool 逐行回显，生成后自动做一次别名校验。"
        extra={<span className="text-faint">{logs.length ? `${logs.length} 行` : "等待任务"}</span>}
      >
        <LogConsole lines={logs} />
      </Section>
    </PageGrid>
  );
}
