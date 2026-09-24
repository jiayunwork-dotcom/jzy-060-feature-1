/**
 * 运行时装配：把注册表、模拟器、历史留档、告警引擎、派生指标引擎、
 * 推送中心串起来，并驱动每秒一次的实时节拍与 24 小时窗口的滚动淘汰。
 *
 * 每拍数据管线：
 *   原始点留档 -> 原始点告警判定 -> 派生引擎按拓扑序算出派生点
 *   （派生点同样留档 + 告警判定）-> 原始点与派生点一起通过长连接推给页面。
 */
import type { AppConfig } from './config';
import type { AlertEvent, MetricPoint, SourceState } from './types';
import { ConfigStore } from './storage/configStore';
import { HistoryStore } from './storage/historyStore';
import { SourceRegistry } from './sources/registry';
import { Simulator } from './sources/simulator';
import { AlertEngine } from './alerts/engine';
import { DerivedEngine } from './derived/engine';
import { Hub } from './realtime/hub';

export interface IngestResult {
  point: MetricPoint;
  events: AlertEvent[];
}

export class Runtime {
  readonly config: AppConfig;
  readonly configStore: ConfigStore;
  readonly history: HistoryStore;
  readonly registry: SourceRegistry;
  readonly simulator: Simulator;
  readonly alerts: AlertEngine;
  readonly derived: DerivedEngine;
  readonly hub: Hub;

  private tickTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(config: AppConfig) {
    this.config = config;
    this.configStore = new ConfigStore(config.dataDir);
    this.history = new HistoryStore(config.dataDir, config.retentionMs);
    this.registry = new SourceRegistry(this.configStore);
    for (const s of this.registry.list()) this.history.register(s.def.id);
    // 重启后已落盘的派生历史同样载入内存
    for (const d of this.configStore.getDerived()) this.history.register(d.id);
    this.simulator = new Simulator(this.registry);
    this.alerts = new AlertEngine(this.configStore);
    this.derived = new DerivedEngine(this.configStore, this.history, this.registry, this.alerts);
    this.hub = new Hub();
  }

  /** 冷启动：预填五分钟历史（原始 + 派生），然后开始周期性产出与推送。 */
  start(): void {
    const now = Date.now();
    this.simulator.prefill(now, this.config.prefillMs, this.config.tickMs, (sourceId, ts, value) => {
      this.history.add(sourceId, ts, value);
    });
    this.history.flush();
    // 用定义对预填的原始点补算派生点（不触发告警/推送），保证走势与回放开箱即用
    this.derived.backfill(now, this.config.prefillMs, this.config.tickMs);
    this.history.flush();

    this.tickTimer = setInterval(() => this.runTick(), this.config.tickMs);
    this.tickTimer.unref?.();
    this.pruneTimer = setInterval(() => {
      this.history.prune(Date.now());
    }, this.config.pruneIntervalMs);
    this.pruneTimer.unref?.();
  }

  /** 构造全量快照，WS 建连时与每拍同步源状态时使用。 */
  buildSnapshot() {
    return {
      type: 'snapshot' as const,
      sources: this.registry.list(),
      derived: this.derived.list(),
      rules: this.configStore.getRules(),
      actives: this.alerts.getActives(),
      latest: this.history.latestAll(),
      ts: Date.now(),
    };
  }

  /** 一个实时节拍：模拟产出 -> 留档 -> 原始/派生告警判定 -> 服务端主动推送。 */
  runTick(ts: number = Date.now()): MetricPoint[] {
    const points = this.simulator.tick(ts);
    if (points.length) {
      const derived = this.ingestPoints(points);
      void derived;
    }
    // 源状态（含故障标记）与派生状态也每拍同步给页面
    this.hub.broadcast(this.buildSnapshot());
    return points;
  }

  /**
   * 采集单个点（实时路径与测试注入路径共用）。
   */
  ingest(point: MetricPoint): IngestResult {
    const events = this.ingestPoints([point]);
    return { point, events };
  }

  /**
   * 采集一批点（实时路径与测试注入路径共用）：
   * 原始点先留档 + 告警判定，再交给派生引擎按拓扑序算出派生点
   * （派生点同样留档 + 告警判定），最后原始点与派生点一起推送。
   */
  ingestPoints(points: MetricPoint[]): AlertEvent[] {
    const allEvents: AlertEvent[] = [];
    for (const p of points) {
      this.history.add(p.sourceId, p.ts, p.value);
      this.registry.reportPoint(p.sourceId, p.ts);
      allEvents.push(...this.alerts.evaluate(p));
    }
    // 派生点在同一拍内紧接着算出，与原始点同等地留档、告警、推送
    const computed = this.derived.consume(points, { evaluateAlerts: true });
    allEvents.push(...computed.events);

    if (allEvents.length) this.emitAlertEvents(allEvents);
    this.hub.broadcast({ type: 'metrics', points: [...points, ...computed.points] });
    return allEvents;
  }

  /** 规则增删改后立即按最新值重判，并把结果推出去。 */
  resyncAlerts(): AlertEvent[] {
    const events = this.alerts.resync(Date.now());
    if (events.length) this.emitAlertEvents(events);
    return events;
  }

  emitAlertEvents(events: AlertEvent[]): void {
    for (const event of events) {
      this.hub.broadcast({ type: 'alert_event', event, actives: this.alerts.getActives() });
    }
  }

  broadcastSource(source: SourceState): void {
    this.hub.broadcast({ type: 'source', source });
  }

  broadcastRules(): void {
    this.hub.broadcast({ type: 'rules', rules: this.configStore.getRules() });
  }

  /** 派生定义增删改后，把新的运行态与最新值同步给所有页面。 */
  broadcastDerived(): void {
    this.hub.broadcast({ type: 'derived', derived: this.derived.list() });
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.history.close();
  }
}
