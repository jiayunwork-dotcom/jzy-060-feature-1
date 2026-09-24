/**
 * 共享领域类型：数据点、数据源、告警规则/事件、布局。
 * 前端在 web/src/types.ts 内保持结构一致的镜像定义。
 */

export type SourceKind = 'system' | 'business' | 'derived';
export type SourceStatus = 'ok' | 'error';

export interface SourceDef {
  id: string;
  name: string;
  kind: SourceKind;
  unit: string;
  /** 展示用满量程，用于柱状图横向对比与仪表盘满刻度 */
  max: number;
  /** 建议小数位 */
  decimals: number;
  description: string;
}

export interface MetricPoint {
  sourceId: string;
  /** epoch 毫秒 */
  ts: number;
  value: number;
}

export interface SourceState {
  def: SourceDef;
  enabled: boolean;
  status: SourceStatus;
  /** 当 status=error 时的说明文本 */
  lastError: string | null;
  /** 最近一次产出数据点的时间（毫秒），无则 null */
  lastPointTs: number | null;
}

export type AlertLevel = 'warning' | 'critical';
export type AlertOperator = '>' | '<' | '>=' | '<=';

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
  /** fired = 越限触发，resolved = 回落后解除 */
  phase: 'fired' | 'resolved';
  ts: number;
}

/** 当前仍处于激活状态的告警（由规则 id 索引） */
export type ActiveAlert = AlertEvent;

/**
 * 派生指标（用户定义的“算出来的指标”）：
 * 由名字、单位、小数位与计算式定义；计算式可引用原始指标与其它派生指标，
 * 支持四则运算、括号、常数与窗口聚合（avg/min/max/last(指标, 5m)）。
 * 定义持久化在 config.json；产出的点与原始指标一样逐点落档历史。
 */
export interface DerivedMetricDef {
  /** 标识符，表达式里互相引用就用它；全局唯一且不与原始指标重名 */
  id: string;
  name: string;
  unit: string;
  decimals: number;
  /** 展示用满量程（仪表盘/对比图），用户可不填，默认 100 */
  max: number;
  expression: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

/** 前端保存下来的布局（react-grid-layout 的布局数组原样存储） */
export type LayoutConfig = Record<string, unknown>[];

/** WebSocket 下行消息 */
export type WsMessage =
  | { type: 'snapshot'; sources: SourceState[]; rules: AlertRule[]; actives: ActiveAlert[]; latest: MetricPoint[]; ts: number }
  | { type: 'metrics'; points: MetricPoint[] }
  | { type: 'source'; source: SourceState }
  | { type: 'alert_event'; event: AlertEvent; actives: ActiveAlert[] }
  | { type: 'rules'; rules: AlertRule[] };
