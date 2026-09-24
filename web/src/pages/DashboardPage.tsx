/** 仪表板主页：可布局网格内放置对比柱图、各指标表盘与趋势折线（含派生指标）。 */
import { useMemo } from 'react';
import { useDashboard } from '../store/useDashboard';
import ChartCard from '../components/ChartCard';
import DashboardGrid from '../components/DashboardGrid';
import GaugeChart from '../components/charts/GaugeChart';
import TrendLine from '../components/charts/TrendLine';
import CompareBars from '../components/charts/CompareBars';
import AlertBanner from '../components/AlertBanner';
import { buildMetricViews, type MetricView } from '../utils/metrics';

export default function DashboardPage() {
  const sources = useDashboard((s) => s.sources);
  const derived = useDashboard((s) => s.derived);
  const series = useDashboard((s) => s.series);
  const rules = useDashboard((s) => s.rules);
  const actives = useDashboard((s) => s.actives);
  const connected = useDashboard((s) => s.connected);

  // 统一视图：已开启的原始采集源 + 未失效的派生指标
  const metrics: MetricView[] = useMemo(
    () => buildMetricViews(sources, derived).filter((m) => (m.kind === 'derived' ? !m.broken : m.enabled)),
    [sources, derived],
  );

  const levelOf = (id: string): 'none' | 'warning' | 'critical' => {
    const active = actives.filter((a) => a.sourceId === id);
    if (active.some((a) => a.level === 'critical')) return 'critical';
    if (active.some((a) => a.level === 'warning')) return 'warning';
    return 'none';
  };
  const latestOf = useMemo(() => {
    const map: Record<string, number | null> = {};
    for (const m of metrics) {
      const arr = series[m.id];
      map[m.id] = arr && arr.length ? arr[arr.length - 1].value : null;
    }
    return map;
  }, [metrics, series]);

  const widgets = [
    {
      key: 'compare',
      default: { i: 'compare', x: 0, y: 0, w: 12, h: 5 },
      node: (
        <ChartCard title="指标横向对比" subtitle="当前值占满量程百分比（按告警级别变色），含派生指标">
          <CompareBars metrics={metrics} latest={latestOf} levelOf={levelOf} height={272} />
        </ChartCard>
      ),
    },
    ...metrics.map((m, idx) => {
      const pts = series[m.id] ?? [];
      const level = levelOf(m.id);
      return {
        key: `gauge-${m.id}`,
        default: {
          i: `gauge-${m.id}`,
          x: (idx * 4) % 12,
          y: 5 + Math.floor(idx / 3) * 5,
          w: 4,
          h: 5,
        },
        node: (
          <ChartCard
            title={m.kind === 'derived' ? `Σ ${m.name}` : m.name}
            metric={m}
            level={level}
          >
            <GaugeChart
              title={m.kind === 'derived' ? (m.status === 'error' ? (m.lastError ?? '计算异常') : m.formula ?? m.description) : m.status === 'error' ? '采集中断' : m.description}
              unit={m.unit}
              max={m.max}
              decimals={m.decimals}
              value={pts.length ? pts[pts.length - 1].value : null}
              rules={rules.filter((r) => r.sourceId === m.id && r.enabled)}
              level={level}
            />
          </ChartCard>
        ),
      };
    }),
    ...metrics.map((m, idx) => {
      const pts = series[m.id] ?? [];
      const level = levelOf(m.id);
      return {
        key: `trend-${m.id}`,
        default: {
          i: `trend-${m.id}`,
          x: (idx % 2) * 6,
          y: 100 + Math.floor(idx / 2) * 6,
          w: 6,
          h: 6,
        },
        node: (
          <ChartCard title={`${m.kind === 'derived' ? 'Σ ' : ''}${m.name} · 最近 5 分钟走势`} metric={m} level={level}>
            <TrendLine
              series={[{ sourceId: m.id, name: m.name, color: m.kind === 'derived' ? '#a855f7' : '#3b82f6', points: pts }]}
              rules={rules.filter((r) => r.sourceId === m.id && r.enabled)}
              level={level}
              height={250}
            />
          </ChartCard>
        ),
      };
    }),
  ];

  return (
    <div>
      <div className="page-head">
        <h2>实时监控</h2>
        <span className={connected ? 'conn conn-on' : 'conn conn-off'}>{connected ? '● WebSocket 已连接 · 服务端推送中' : '○ 连接断开，正在重连…'}</span>
      </div>
      <AlertBanner />
      <DashboardGrid widgets={widgets} />
    </div>
  );
}
