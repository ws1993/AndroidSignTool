import { useCallback, useEffect, useMemo, useState } from "react";
import { App as AntApp, Button, Input, Popconfirm, Select, Table, Tag, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import { save } from "@tauri-apps/plugin-dialog";
import { api, baseName, dirName, type HistoryRecord, type StrategyOption } from "../lib/api";
import { Section } from "../components/Layout";

export default function HistoryPage() {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<HistoryRecord[]>([]);
  const [strategies, setStrategies] = useState<StrategyOption[]>([]);
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<"all" | "ok" | "fail">("all");
  const [loading, setLoading] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    api
      .historyList(2000)
      .then(setRows)
      .catch((e) => message.error(String(e)))
      .finally(() => setLoading(false));
  }, [message]);

  useEffect(() => {
    reload();
    api.listStrategies().then(setStrategies).catch(() => undefined);
  }, [reload]);

  const strategyLabel = useMemo(() => {
    const m = new Map(strategies.map((s) => [s.value, s.label]));
    return (v: string) => m.get(v) ?? v;
  }, [strategies]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return rows.filter((r) => {
      if (status === "ok" && !r.ok) return false;
      if (status === "fail" && r.ok) return false;
      if (!kw) return true;
      return (
        r.apk.toLowerCase().includes(kw) ||
        r.output.toLowerCase().includes(kw) ||
        (r.cert ?? "").toLowerCase().includes(kw)
      );
    });
  }, [rows, keyword, status]);

  const stats = useMemo(() => {
    const ok = rows.filter((r) => r.ok).length;
    return { total: rows.length, ok, fail: rows.length - ok };
  }, [rows]);

  async function exportCsv() {
    const p = await save({
      title: "导出签名历史（CSV，不含任何密码）",
      defaultPath: "sign-history.csv",
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!p) return;
    try {
      const n = await api.historyExport(String(p));
      message.success(`已导出 ${n} 条记录`);
    } catch (e) {
      message.error(String(e));
    }
  }

  async function openDir(row: HistoryRecord) {
    const dir = dirName(row.ok ? row.output : row.apk);
    if (!dir) return;
    try {
      await api.openInExplorer(dir);
    } catch (e) {
      message.error(String(e));
    }
  }

  const columns: TableColumnsType<HistoryRecord> = [
    {
      title: "时间",
      dataIndex: "createdAt",
      width: 168,
      render: (v: string) => <span className="mono">{v}</span>,
    },
    {
      title: "APK",
      dataIndex: "apk",
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v}>
          <span>{baseName(v)}</span>
        </Tooltip>
      ),
    },
    {
      title: "输出",
      dataIndex: "output",
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v}>
          <span>{baseName(v)}</span>
        </Tooltip>
      ),
    },
    {
      title: "策略",
      dataIndex: "strategy",
      width: 150,
      render: (v: string) => <Tag bordered={false}>{strategyLabel(v)}</Tag>,
    },
    {
      title: "结果",
      dataIndex: "ok",
      width: 110,
      render: (ok: boolean, row) =>
        ok ? (
          <Tag color="green" bordered={false}>
            成功
          </Tag>
        ) : (
          <Tooltip title={row.error ?? "未知错误"}>
            <Tag color="red" bordered={false}>
              失败
            </Tag>
          </Tooltip>
        ),
    },
    {
      title: "耗时",
      dataIndex: "durationMs",
      width: 90,
      render: (v: number) => `${(v / 1000).toFixed(1)}s`,
    },
    {
      title: "证书 SHA-256",
      dataIndex: "cert",
      width: 150,
      render: (v: string | null) =>
        v ? (
          <Tooltip title={v}>
            <span className="mono">{v.slice(0, 12)}…</span>
          </Tooltip>
        ) : (
          <span className="empty-hint">—</span>
        ),
    },
    {
      title: "",
      key: "act",
      width: 90,
      render: (_, row) => (
        <Button size="small" type="text" onClick={() => openDir(row)}>
          打开目录
        </Button>
      ),
    },
  ];
  return (
    <div className="page">
      <Section
        title="签名历史"
        desc={
          <>
            记录存于本机 SQLite（<code>history.db</code>），仅含路径、策略、结果与证书指纹，
            <b>不含任何密码</b>。CSV 导出同样不含密码字段。
          </>
        }
        extra={
          <span className="history-stats">
            <span>
              共 <b>{stats.total}</b>
            </span>
            <span className="ok">成功 {stats.ok}</span>
            <span className="fail">失败 {stats.fail}</span>
          </span>
        }
      >
        <div className="table-toolbar">
          <Input.Search
            allowClear
            placeholder="按 APK / 输出 / 证书指纹筛选"
            style={{ width: 280 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Select
            value={status}
            onChange={setStatus}
            style={{ width: 140 }}
            options={[
              { value: "all", label: "全部结果" },
              { value: "ok", label: "仅成功" },
              { value: "fail", label: "仅失败" },
            ]}
          />
          <span className="text-faint nowrap">当前筛选 {filtered.length} 条</span>
          <div className="toolbar-right">
            <Button onClick={reload} loading={loading}>
              刷新
            </Button>
            <Button onClick={exportCsv} disabled={!rows.length}>
              导出 CSV
            </Button>
            <Popconfirm
              title="清空全部签名历史？"
              description="仅删除记录，不影响任何 APK / 签名文件。"
              okText="清空"
              okButtonProps={{ danger: true }}
              onConfirm={async () => {
                try {
                  await api.historyClear();
                  message.success("历史已清空");
                  reload();
                } catch (e) {
                  message.error(String(e));
                }
              }}
            >
              <Button danger disabled={!rows.length}>
                清空历史
              </Button>
            </Popconfirm>
          </div>
        </div>

        <Table<HistoryRecord>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={filtered}
          loading={loading}
          pagination={{ pageSize: 12, showSizeChanger: false, size: "small" }}
          locale={{ emptyText: "暂无签名记录" }}
        />
      </Section>
    </div>
  );
}
