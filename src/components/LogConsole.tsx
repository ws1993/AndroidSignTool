import { useEffect, useRef } from "react";

export type LogKind = "cmd" | "ok" | "err" | "warn" | "muted" | "plain";

export function classify(line: string): LogKind {
  if (line.startsWith("$")) return "cmd";
  // warn 必须先判：兼容性告警正文含「安装失败」等字样，若先过 err 会被误染成红色错误
  if (/\[警告\]|^WARNING:|⚠/.test(line)) return "warn";
  if (/\[错误\]|失败|Exception|DOES NOT VERIFY|WARNING:.*unsupported/i.test(line)) return "err";
  if (/✓|成功|完成|通过|生成/.test(line)) return "ok";
  if (line.startsWith("#") || line.startsWith("[apksigner] 已生成")) return "muted";
  return "plain";
}

export default function LogConsole({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <pre className="console" ref={ref}>
      {lines.length === 0 ? (
        <span className="ln-muted">等待任务…</span>
      ) : (
        lines.map((l, i) => {
          const k = classify(l);
          return (
            <div key={i} className={k === "plain" ? undefined : `ln-${k}`}>
              {l}
            </div>
          );
        })
      )}
    </pre>
  );
}
