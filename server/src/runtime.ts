/**
 * 运行时装配：把注册表、模拟器、历史留档、派生指标引擎、告警引擎、推送中心串起来，
 * 并驱动每秒一次的实时节拍与 24 小时窗口的滚动淘汰。
 *
 * 每个节拍的数据流：模拟产出 -> 留档 -> 告警判定 -> 派生指标按依赖序计算
 * （产出的点走与原始点完全相同的留档/告警/推送管线）-> 服务端主动推送。
 */
import type { AppConfig } from './config';
import type { AlertEvent, MetricPoint, SourceState } from './types';
import { ConfigStore } from './storage/configStore';
import { HistoryStore } from './storage/historyStore';
import { SourceRegistry } from './sources/registry';
import { Simulator } from './sources/simulator';
import { DerivedEngine } from './derived/engine';
import { AlertEngine } from './alerts/engine';
import { Hub } from './realtime/hub';

export interface IngestResult {
  point: MetricPoint;
  events: AlertEvent[];
  /** 本拍由派生指标算出的点 */
  derived: MetricPoint[];
}

export interface IngestBatchResult {
  events: AlertEvent[];
  derived: MetricPoint[];
}

export class Runtime {
  readonly config: AppConfig;
  readonly configStore: ConfigStore;
  readonly history: HistoryStore;
  readonly registry: SourceRegistry;
  readonly simulator: Simulator;
  readonly derived: DerivedEngine;
  readonly alerts: AlertEngine;
  readonly hub: Hub;

  private tickTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(config: AppConfig) {
    this.config = config;
    this.configStore = new ConfigStore(config.dataDir);
    this.history = new HistoryStore(config.dataDir, config.retentionMs);
    this.registry = new SourceRegistry(this.configStore);
    for (const s of this.registry.list()) this.history.register(s.def.id);
    this.simulator = new Simulator(this.registry);
    this.derived = new DerivedEngine(this.configStore, this.history, this.registry);
    this.alerts = new AlertEngine(this.configStore);
    this.hub = new Hub();
  }

  /** 冷启动：预填五分钟历史（含派生指标），然后开始周期性产出与推送。 */
  start(): void {
    const now = Date.now();
    // 预填原始点的同时按时间戳归集，随后逐拍补算派生指标，
    // 让派生指标初次打开页面也有五分钟走势（幂等：重启不会重复产点）。
    const batches = new Map<number, Map<string, number>>();
    this.simulator.prefill(now, this.config.prefillMs, this.config.tickMs, (sourceId, ts, value) => {
      this.history.add(sourceId, ts, value);
      let batch = batches.get(ts);
      if (!batch) batches.set(ts, (batch = new Map()));
      batch.set(sourceId, value);
    });
    if (this.derived.hasAny()) {
      for (const ts of [...batches.keys()].sort((a, b) => a - b)) {
        this.derived.evaluateTick(batches.get(ts)!, ts, (p) => this.history.add(p.sourceId, p.ts, p.value));
      }
    }
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
      sources: [...this.registry.list(), ...this.derived.listStates()],
      rules: this.configStore.getRules(),
      actives: this.alerts.getActives(),
      latest: this.history.latestAll(),
      ts: Date.now(),
    };
  }

  /** 一个实时节拍：模拟产出 -> 留档 -> 告警判定 -> 派生计算 -> 服务端主动推送。 */
  runTick(ts: number = Date.now()): MetricPoint[] {
    const points = this.simulator.tick(ts);
    if (points.length) this.ingestPoints(points);
    // 源状态（含故障标记）也每拍同步给页面
    this.hub.broadcast(this.buildSnapshot());
    return points;
  }

  /**
   * 采集单个点（实时路径与测试注入路径共用）：
   * 留档（24h）、告警判定、派生计算、通过长连接主动推给页面。
   */
  ingest(point: MetricPoint): IngestResult {
    const { events, derived } = this.ingestPoints([point]);
    return { point, events, derived };
  }

  /**
   * 采集一批点：先按原始管线处理（留档/告警），再按时间戳分组逐拍计算派生指标。
   * 派生点复用同一条管线（留档、告警、推送），与原始指标完全同等待遇。
   */
  ingestPoints(points: MetricPoint[]): IngestBatchResult {
    const allEvents: AlertEvent[] = [];
    for (const p of points) {
      this.history.add(p.sourceId, p.ts, p.value);
      this.registry.reportPoint(p.sourceId, p.ts);
      allEvents.push(...this.alerts.evaluate(p));
    }

    // 派生指标：按时间戳分批（一个时间戳 = 一拍），紧跟原始点之后按依赖顺序计算
    const derivedPoints: MetricPoint[] = [];
    if (this.derived.hasAny() && points.length) {
      const byTs = new Map<number, Map<string, number>>();
      for (const p of points) {
        let batch = byTs.get(p.ts);
        if (!batch) byTs.set(p.ts, (batch = new Map()));
        batch.set(p.sourceId, p.value);
      }
      for (const ts of [...byTs.keys()].sort((a, b) => a - b)) {
        derivedPoints.push(...this.ingestDerivedTick(byTs.get(ts)!, ts, allEvents));
      }
    }

    if (allEvents.length) this.emitAlertEvents(allEvents);
    if (points.length) this.hub.broadcast({ type: 'metrics', points });
    if (derivedPoints.length) this.hub.broadcast({ type: 'metrics', points: derivedPoints });
    return { events: allEvents, derived: derivedPoints };
  }

  /** 计算一个时间戳上的全部派生指标：落档 + 告警判定，返回产出的点。 */
  private ingestDerivedTick(batch: Map<string, number>, ts: number, events: AlertEvent[]): MetricPoint[] {
    return this.derived.evaluateTick(batch, ts, (p) => {
      this.history.add(p.sourceId, p.ts, p.value);
      events.push(...this.alerts.evaluate(p));
    });
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

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.history.close();
  }
}
