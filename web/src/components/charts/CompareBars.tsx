/** 柱状图：不同指标之间的横向对比（统一换算成占满量程百分比），原始/派生通用。 */
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts';
import type { MetricView } from '../../utils/metrics';
import { formatValue } from '../../utils/format';

interface CompareBarsProps {
  metrics: MetricView[];
  latest: Record<string, number | null>;
  /** sourceId -> 激活级别，柱体按级别变色 */
  levelOf: (id: string) => 'none' | 'warning' | 'critical';
  height?: number;
}

export default function CompareBars({ metrics, latest, levelOf, height = 220 }: CompareBarsProps) {
  const data = metrics.map((m) => {
    const v = latest[m.id];
    return {
      id: m.id,
      name: m.kind === 'derived' ? `Σ ${m.name}` : m.name,
      percent: v === null || v === undefined ? 0 : Math.min(100, (v / m.max) * 100),
      raw: v,
      unit: m.unit,
      level: levelOf(m.id),
      derived: m.kind === 'derived',
    };
  });

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 16, bottom: 40, left: -8 }}>
        <CartesianGrid stroke="#1f2a3a" strokeDasharray="3 3" />
        <XAxis dataKey="name" stroke="#64748b" fontSize={10} interval={0} angle={-22} textAnchor="end" height={48} />
        <YAxis stroke="#64748b" fontSize={11} unit="%" domain={[0, 100]} />
        <Tooltip
          cursor={{ fill: '#1b2636' }}
          contentStyle={{ background: '#0f1722', border: '1px solid #243042', borderRadius: 8, fontSize: 12 }}
          formatter={(value: number, _name, item) => {
            const row = item.payload as (typeof data)[number];
            return [`${value.toFixed(1)}%（${formatValue(row.raw, 1, row.unit)}）`, row.derived ? '派生指标' : '负载'];
          }}
        />
        <Bar dataKey="percent" radius={[4, 4, 0, 0]} isAnimationActive={false}>
          {data.map((d) => (
            <Cell
              key={d.id}
              fill={d.level === 'critical' ? '#e5484d' : d.level === 'warning' ? '#f5a524' : d.derived ? '#a855f7' : '#3b82f6'}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
