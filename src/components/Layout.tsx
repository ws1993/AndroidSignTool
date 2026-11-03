import type { ReactNode } from "react";

/**
 * Section —— 功能分区卡片。
 *
 * 强制统一结构：标题（可选图标）/ 说明 / 右侧操作 三段式头部 + 内容体。
 * 所有页面的卡片都经由这里渲染，从而保证标题基线、内边距、
 * 操作区位置在全局完全一致（对应「组件对齐」与「布局分割」）。
 */
export function Section({
  title,
  desc,
  extra,
  children,
}: {
  title: ReactNode;
  desc?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <div className="card-head-text">
          <h2 className="card-title">{title}</h2>
          {desc ? <p className="card-sub">{desc}</p> : null}
        </div>
        {extra ? <div className="card-head-extra">{extra}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * FieldGroup —— 卡片内的二级功能块。
 * 相邻 FieldGroup 自动生成分隔线，把「一个卡片里的多组字段」
 * 切成逻辑相邻但视觉有界的区域。
 */
export function FieldGroup({
  title,
  hint,
  extra,
  children,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field-group">
      {title || hint || extra ? (
        <div className="field-group-head">
          <h3 className="field-group-title">{title}</h3>
          {extra ?? (hint ? <span className="field-group-hint">{hint}</span> : null)}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** 主从两列布局：左表单 / 右结果，900px 以下自动堆叠。 */
export function PageGrid({ children }: { children: ReactNode }) {
  return <div className="page-grid">{children}</div>;
}

/** 独立卡片自适应网格：按可用宽度自动决定列数。 */
export function ZoneGrid({ children }: { children: ReactNode }) {
  return <div className="zone-grid">{children}</div>;
}

/** 单列卡片流，统一卡片间距。 */
export function Stack({ children }: { children: ReactNode }) {
  return <div className="stack">{children}</div>;
}
