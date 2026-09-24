/** 图表卡片外壳：标题、状态点、级别描边，可嵌入 react-grid-layout。 */
import type { ReactNode } from 'react';
import type { SourceState } from '../types';
import type { MetricView } from '../utils/metrics';

interface ChartCardProps {
  title: string;
  subtitle?: string;
  /** 原始源（旧用法） */
  source?: SourceState;
  /** 统一指标视图（原始或派生） */
  metric?: MetricView;
  level?: 'none' | 'warning' | 'critical';
  children: ReactNode;
  actions?: ReactNode;
}

type DotState = 'ok' | 'error' | 'off';

function dotClass(state: DotState): string {
  return state === 'error' ? 'status-error' : state === 'off' ? 'status-off' : 'status-ok';
}

export default function ChartCard({ title, subtitle, source, metric, level = 'none', children, actions }: ChartCardProps) {
  let dot: { cls: string; title: string } | null = null;
  if (metric) {
    const dotState: DotState = metric.kind === 'derived' ? (metric.status === 'error' ? 'error' : 'ok') : !metric.enabled ? 'off' : metric.status === 'error' ? 'error' : 'ok';
    const titleText =
      metric.kind === 'derived'
        ? metric.status === 'error'
          ? metric.lastError ?? '派生指标计算异常'
          : '派生指标正常'
        : !metric.enabled
          ? '采集已关闭'
          : metric.status === 'error'
            ? metric.lastError ?? '异常'
            : '正常';
    dot = { cls: dotClass(dotState), title: titleText };
  } else if (source) {
    const dotState: DotState = source.enabled ? (source.status === 'error' ? 'error' : 'ok') : 'off';
    dot = {
      cls: dotClass(dotState),
      title: source.enabled ? (source.status === 'error' ? source.lastError ?? '异常' : '正常') : '采集已关闭',
    };
  }
  return (
    <div className={`chart-card ${level === 'critical' ? 'card-critical' : level === 'warning' ? 'card-warning' : ''}`}>
      <div className="chart-card-head">
        <div className="chart-card-title">
          <span className="card-title-text">{title}</span>
          {dot && <span className={`status-dot ${dot.cls}`} title={dot.title} />}
          {metric?.kind === 'derived' && <span className="tag tag-derived" title="用户定义的算出来的指标">派生</span>}
          {subtitle && <span className="card-subtitle">{subtitle}</span>}
        </div>
        {actions && <div className="chart-card-actions">{actions}</div>}
      </div>
      <div className="chart-card-body">{children}</div>
    </div>
  );
}
