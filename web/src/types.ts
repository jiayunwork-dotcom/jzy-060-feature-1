/** 与后端 server/src/types.ts 结构保持一致的前端镜像定义。 */

export type SourceKind = 'system' | 'business';
export type SourceStatus = 'ok' | 'error';
export type DerivedStatus = 'ok' | 'error';
export type AlertLevel = 'warning' | 'critical';
export type AlertOperator = '>' | '<' | '>=' | '<=';

export interface SourceDef {
  id: string;
  name: string;
  kind: SourceKind;
  unit: string;
  max: number;
  decimals: number;
  description: string;
}

export interface MetricPoint {
  sourceId: string;
  ts: number;
  value: number;
}

export interface SourceState {
  def: SourceDef;
  enabled: boolean;
  status: SourceStatus;
  lastError: string | null;
  lastPointTs: number | null;
}

/** 派生（算出来的）指标定义，与后端 DerivedDef 一致 */
export interface DerivedDef {
  id: string;
  name: string;
  unit: string;
  decimals: number;
  max: number;
  formula: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

/** 派生指标运行态，与后端 DerivedState 一致 */
export interface DerivedState {
  def: DerivedDef;
  status: DerivedStatus;
  lastError: string | null;
  lastPointTs: number | null;
  dependsOn: string[];
  broken: boolean;
}

export interface AlertRule {
  id: string;
  sourceId: string;
  level: AlertLevel;
  operator: AlertOperator;
  threshold: number;
  enabled: boolean;
  note: string;
  createdAt: number;
  updatedAt: number;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  sourceId: string;
  level: AlertLevel;
  operator: AlertOperator;
  threshold: number;
  value: number;
  phase: 'fired' | 'resolved';
  ts: number;
}

export interface HistoryResponse {
  from: number;
  to: number;
  tickMs: number;
  series: Record<string, { sourceId: string; points: { ts: number; value: number }[] }>;
}

export type RGLPosition = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type LayoutConfig = RGLPosition[];
