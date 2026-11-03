import { useEffect, useState } from "react";
import { Alert, Tag } from "antd";
import HistoryPage from "./pages/HistoryPage";
import KeystorePage from "./pages/KeystorePage";
import SettingsPage from "./pages/SettingsPage";
import SignPage from "./pages/SignPage";
import { api, type ToolStatus } from "./lib/api";

const TABS = [
  { key: "sign", label: "APK 签名" },
  { key: "keystore", label: "生成签名文件" },
  { key: "history", label: "签名历史" },
  { key: "settings", label: "设置" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function App() {
  const [tab, setTab] = useState<TabKey>("sign");
  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .checkTools()
      .then((t) => alive && setTools(t))
      .catch(() => alive && setTools(null));
    return () => {
      alive = false;
    };
  }, [nonce]);

  const ready = !!tools && tools.java && tools.apksigner;
  const allReady = ready && tools!.keytool && tools!.zipalign;

  return (
    <>
      <header className="topbar">
        <div className="wordmark">
          <b>APK SIGN TOOL</b>
          <span className="ver">v0.1.0</span>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`tab${tab === t.key ? " active" : ""}`}
              aria-current={tab === t.key ? "page" : undefined}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <Tag color={allReady ? "green" : ready ? "orange" : "red"} bordered={false}>
            {allReady ? "工具链就绪" : ready ? "部分工具缺失" : "内置工具未就绪"}
          </Tag>
        </div>
      </header>

      <main className="shell">
        <div className="page">
          {tools && !allReady && (
            <Alert
              type="warning"
              showIcon
              message="内置签名工具不完整"
              description={
                <>
                  开发环境请先在项目根目录执行 <code>npm run prepare:tools</code> 生成
                  <code> src-tauri/resources</code> 下的 jre / apksigner.jar / zipalign.exe。
                </>
              }
            />
          )}

          {tab === "sign" && <SignPage />}
          {tab === "keystore" && <KeystorePage />}
          {tab === "history" && <HistoryPage />}
          {tab === "settings" && <SettingsPage onReload={() => setNonce((n) => n + 1)} />}
        </div>
      </main>
    </>
  );
}
