/**
 * 指标视图模型：把“原始采集源（SourceState）”与“派生指标（DerivedState）”
 * 归一成统一的 MetricView，供看板、回放、告警面板以同一种方式渲染。
 * 派生指标是一等公民：有自己的名字、单位、小数位、满量程、可用状态。
 */
import type { DerivedState, SourceState } from '../types';

export interface MetricView {
  id: string;
  name: string;
  unit: string;
  decimals: number;
  max: number;
  description: string;
  kind: 'system' | 'business' | 'derived';
  /** 是否可用于实时计算/展示：原始源看 enabled；派生指标始终在列（异常时单独标记） */
  enabled: boolean;
  /** ok / error：派生指标计算异常（被零除、依赖无数据等）时为 error */
  status: 'ok' | 'error';
  lastError: string | null;
  lastPointTs: number | null;
  /** 仅派生指标 */
  formula?: string;
  dependsOn?: string[];
  broken?: boolean;
}

export function fromSource(s: SourceState): MetricView {
  return {
    id: s.def.id,
    name: s.def.name,
    unit: s.def.unit,
    decimals: s.def.decimals,
    max: s.def.max,
    description: s.def.description,
    kind: s.def.kind,
    enabled: s.enabled,
    status: s.status,
    lastError: s.lastError,
    lastPointTs: s.lastPointTs,
  };
}

export function fromDerived(d: DerivedState): MetricView {
  return {
    id: d.def.id,
    name: d.def.name,
    unit: d.def.unit,
    decimals: d.def.decimals,
    max: d.def.max,
    description: d.def.description,
    kind: 'derived',
    enabled: !d.broken,
    status: d.status,
    lastError: d.lastError,
    lastPointTs: d.lastPointTs,
    formula: d.def.formula,
    dependsOn: d.dependsOn,
    broken: d.broken,
  };
}

export function buildMetricViews(sources: SourceState[], derived: DerivedState[]): MetricView[] {
  return [...sources.map(fromSource), ...derived.map(fromDerived)];
}

/** 在统一视图集合里按 id 查找（原始或派生）。 */
export function findMetric(views: MetricView[], id: string): MetricView | undefined {
  return views.find((m) => m.id === id);
}
