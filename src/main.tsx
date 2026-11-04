import React from "react";
import ReactDOM from "react-dom/client";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      // 关闭两字按钮自动加空格：否则「选择」与「选择文件」文字宽度不一致，
      // 相邻按钮的基线与视觉节奏在扫视时对不齐（antd 5 仍以此属性生效）。
      autoInsertSpaceInButton={false}
      theme={{
        // token 与 styles.css 的 CSS 变量保持同一套数值，
        // 避免 antd 组件与自定义卡片出现圆角/间距/字色的细微不一致。
        token: {
          colorPrimary: "#1f6feb",
          colorInfo: "#1f6feb",
          colorSuccess: "#10b981",
          colorWarning: "#f59e0b",
          colorError: "#ef4444",
          colorText: "#0f172a",
          colorTextSecondary: "#64748b",
          colorBorder: "#cbd5e1",
          colorBorderSecondary: "#e2e8f0",
          colorBgContainer: "#ffffff",
          colorBgElevated: "#ffffff",
          borderRadius: 8,
          borderRadiusSM: 6,
          borderRadiusLG: 10,
          fontSize: 13,
          controlHeight: 32,
          lineWidth: 1,
          fontFamily:
            '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif',
          boxShadow: "0 1px 2px 0 rgba(15, 23, 42, 0.05)",
          boxShadowSecondary:
            "0 1px 3px 0 rgba(15, 23, 42, 0.06), 0 4px 12px -2px rgba(15, 23, 42, 0.04)",
        },
        components: {
          // 表单项间距由 .card .ant-form-item 统一控制，这里只保留基础值
          Form: { itemMarginBottom: 16, labelColor: "#5b6875" },
          Input: { paddingBlock: 5 },
          Button: { fontWeight: 500, primaryShadow: "none", defaultShadow: "none" },
          Table: {
            headerBg: "#fafbfd",
            headerColor: "#3c4a59",
            headerSplitColor: "transparent",
            rowHoverBg: "#f7f9fc",
            cellPaddingBlockSM: 8,
            borderColor: "#e3e8ef",
          },
          Descriptions: { labelBg: "transparent", titleMarginBottom: 12 },
          Tag: { defaultBg: "#f2f5f9", defaultColor: "#5b6875" },
          Alert: { withDescriptionPadding: "12px 16px" },
        },
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
