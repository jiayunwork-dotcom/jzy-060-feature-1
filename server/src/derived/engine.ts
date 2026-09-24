/**
 * 派生（算出来的）指标引擎 —— 把算式解析、依赖图、滚动窗口、历史留档与
 * 告警引擎组装成一个整体，按“原始点 -> 拓扑序派生点”的顺序逐拍计算。
 *
 * 关键约定：
 *  - 每一拍按依赖的拓扑序计算（被依赖者先算）；某一路算失败（被零除、
 *    依赖本拍无数据、结果非有限数）只把这一路标成异常，绝不连累其它指标。
 *  - 严格“不拿旧值凑算”：无论瞬时引用还是窗口聚合，被依赖的源本拍必须在
 *    正常产出新值；源被关闭/采集中断时，这一路立即标异常并停止产点，
 *    重新产出后自动恢复。窗口内取值全部来自该指标真实留存的点。
 *  - 派生点与原始点一样：留档（支持历史回放）、进告警判定、由 WS 推送。
 */
import type { AlertEvent, DerivedDef, DerivedState, MetricPoint } from '../types';
import type { ConfigStore } from '../storage/configStore';
import type { HistoryStore } from '../storage/historyStore';
import type { SourceRegistry } from '../sources/registry';
import { FormulaEvalError, FormulaSyntaxError, evaluateFormula, parseFormula, type AstNode, type ParsedFormula } from './formula';
import { buildGraph, findCycle, findCycleFromNode, topologicalSort, type DepGraph } from './graph';
import { RollingWindowBuffer } from './rollingWindow';

interface RuntimeAlerts {
  evaluate: (point: MetricPoint) => AlertEvent[];
  /** 派生指标本拍算不出来时，让绑定它的告警立即失效（不用旧值重判） */
  invalidateSource: (sourceId: string, ts: number) => AlertEvent[];
}

export class DerivedEngine {
  private states = new Map<string, DerivedState>();
  private parsed = new Map<string, ParsedFormula>();
  /** 派生指标之间的依赖图（仅派生节点） */
  private graph: DepGraph = new Map();
  /** 当前有效的求值顺序（不含环上节点） */
  private order: string[] = [];
  /** 存量数据里若检测到环，环上节点 id 集合（正常保存路径不可能出现） */
  private cyclicIds = new Set<string>();
  private readonly windows = new RollingWindowBuffer();

  constructor(
    private readonly config: ConfigStore,
    private readonly history: HistoryStore,
    private readonly registry: SourceRegistry,
    private readonly alerts: RuntimeAlerts,
  ) {
    this.reload();
  }

  // ---------------- 定义管理与校验 ----------------

  list(): DerivedState[] {
    return this.config.getDerived().map((d) => this.states.get(d.id) ?? this.fallbackState(d));
  }

  getState(id: string): DerivedState | undefined {
    const def = this.config.getDerivedDef(id);
    return def ? this.states.get(id) ?? this.fallbackState(def) : undefined;
  }

  private fallbackState(def: DerivedDef): DerivedState {
    return { def, status: 'error', lastError: '定义尚未载入', lastPointTs: null, dependsOn: [], broken: true };
  }

  /** 全部已知可引用的指标 id（原始 + 已有派生） */
  knownIds(excludeId?: string): Set<string> {
    const ids = new Set<string>();
    for (const s of this.registry.list()) ids.add(s.def.id);
    for (const d of this.config.getDerived()) if (d.id !== excludeId) ids.add(d.id);
    // 自身也允许出现在算式里（随后会被环检测作为自环拒绝）
    if (excludeId) ids.add(excludeId);
    return ids;
  }

  /**
   * 保存前校验算式：语法 / 引用存在性 / 环。
   * 返回解析结果或结构化错误（环错误附带环上节点，供接口清楚提示用户）。
   */
  validateSave(id: string | null, formula: string):
    | { ok: true; parsed: ParsedFormula; cycle: null }
    | { ok: false; status: 400; code: string; message: string; cycle?: string[] } {
    const candidateId = id ?? '__new__';
    let parsed: ParsedFormula;
    try {
      // knownIds 包含 candidateId 自身：自引用在这里先通过，随后由环检测作为自环拒绝
      const known = this.knownIds(id ?? undefined);
      if (!id) known.add(candidateId);
      parsed = parseFormula(formula, known);
    } catch (err) {
      if (err instanceof FormulaSyntaxError) {
        return { ok: false, status: 400, code: 'invalid_formula', message: err.message };
      }
      throw err;
    }
    // 用候选集合构图：更新时用新算式替换，新建时把自己作为新节点加入
    const candidateDefs: DerivedDef[] = this.config
      .getDerived()
      .filter((d) => d.id !== id)
      .map((d) => ({ ...d }));
    candidateDefs.push({
      id: candidateId,
      name: '',
      unit: '',
      decimals: 0,
      max: 100,
      formula,
      description: '',
      createdAt: 0,
      updatedAt: 0,
    });
    const graph = buildGraph({
      defs: candidateDefs,
      derivedIds: new Set(candidateDefs.map((d) => d.id)),
      // 构图只关心“派生之间”的边，引用存在性已在上面的 parseFormula(formula, knownIds) 校验过
      depsOf: (f) => parseFormula(f).refs,
    });
    // 保存那一刻必须挡住任何环；优先报告“包含本次提交节点”的环，
    // 让用户看到的链路一定带着他正在保存的那个指标
    let cycleInfo = findCycleFromNode(graph, candidateId);
    if (!cycleInfo) cycleInfo = findCycle(graph);
    if (cycleInfo) {
      // 环上每个节点都显示真实名字，让用户清楚看到是哪几个指标绕成环；
      // 仅当节点是“新建、尚未落库”的候选时，才用“本次定义”兜底。
      const labels = cycleInfo.path.map((x) => {
        if (x !== candidateId || this.config.getDerivedDef(x)) return this.displayName(x);
        return '本次定义';
      });
      return {
        ok: false,
        status: 400,
        code: 'cyclic_dependency',
        message: `计算式存在循环依赖：${labels.join(' → ')} → ${labels[0]}，已拒绝保存`,
        cycle: cycleInfo.path,
      };
    }
    return { ok: true, parsed, cycle: null };
  }

  /** 谁（直接或间接）还在引用某指标：删除前阻止并提示。 */
  dependents(id: string): string[] {
    const out = new Set<string>();
    const walk = (target: string) => {
      for (const [other, deps] of this.graph) {
        if (deps.includes(target) && !out.has(other)) {
          out.add(other);
          walk(other);
        }
      }
    };
    walk(id);
    return [...out].sort();
  }

  /** 定义增删改后重新装载：重新解析、重建拓扑序、登记窗口。 */
  reload(): void {
    const defs = this.config.getDerived();
    const derivedIds = new Set(defs.map((d) => d.id));
    const nextStates = new Map<string, DerivedState>();
    const nextParsed = new Map<string, ParsedFormula>();
    const graph: DepGraph = new Map();

    for (const def of defs) {
      let dependsOn: string[] = [];
      let broken = false;
      let error: string | null = null;
      try {
        const parsed = parseFormula(def.formula, this.knownIds());
        nextParsed.set(def.id, parsed);
        dependsOn = parsed.refs;
        graph.set(def.id, parsed.refs.filter((r) => derivedIds.has(r)));
      } catch (err) {
        broken = true;
        error = err instanceof FormulaSyntaxError ? `定义已失效：${err.message}` : '定义解析失败';
        graph.set(def.id, []);
      }
      const prev = this.states.get(def.id);
      nextStates.set(def.id, {
        def,
        status: prev?.status ?? 'ok',
        lastError: prev?.lastError ?? error,
        lastPointTs: prev?.lastPointTs ?? null,
        dependsOn,
        broken,
      });
    }

    const { order, cyclic } = topologicalSort(graph);
    this.cyclicIds = new Set(cyclic);
    for (const id of cyclic) {
      const st = nextStates.get(id);
      if (st) {
        st.broken = true;
        st.status = 'error';
        st.lastError = '定义处于循环依赖中，已停止计算';
      }
    }
    this.order = order.filter((id) => !this.cyclicIds.has(id) && !nextStates.get(id)?.broken);
    this.graph = graph;
    this.states = nextStates;
    this.parsed = nextParsed;

    // 登记窗口引用；新出现的窗口源从历史留档补灌，保证“最近 N 分钟”立即可用
    const now = Date.now();
    for (const parsed of this.parsed.values()) {
      for (const win of collectWindows(parsed.ast)) {
        const wasTracked = this.windows.has(win.refId);
        this.windows.track(win.refId, win.windowMs);
        if (!wasTracked) this.hydrateWindowFromHistory(win.refId, now);
      }
    }
  }

  private hydrateWindowFromHistory(sourceId: string, now: number): void {
    // 用留档里该源最近一段真实点补灌（history 是回放与计算的事实来源）
    // 窗口上界未知，取一个足够覆盖常见窗口的回看长度（与实时 5 分钟画面一致）。
    const lookback = Math.max(30 * 60 * 1000, ...[...this.windowMsOf(sourceId)]);
    const rows = this.history.query(sourceId, now - lookback, now);
    this.windows.hydrate(
      sourceId,
      rows.map((r) => ({ ts: r.ts, value: r.value })),
    );
  }

  private windowMsOf(sourceId: string): number[] {
    const out: number[] = [];
    for (const parsed of this.parsed.values()) {
      for (const win of collectWindows(parsed.ast)) if (win.refId === sourceId) out.push(win.windowMs);
    }
    return out;
  }

  // ---------------- 启动预填 ----------------

  /**
   * 冷启动预填：模拟器把原始点写入历史后，用同样的定义把派生点
   * 从早到晚补算一遍（不触发告警、不推送），让 5 分钟走势/回放开箱即用。
   * 重启恢复时派生点已经逐点落盘，已存在的点只喂窗口、不重复留档，
   * 保证回放看到的序列与当初实时产出逐点一致。
   */
  backfill(now: number, spanMs: number, _stepMs: number): void {
    if (this.order.length === 0 || spanMs <= 0) return;
    const from = now - spanMs;
    // 1) 滚动窗口先吃满留档中的原始/派生点（区间前的点也保留，窗口长度足够覆盖）
    for (const id of this.trackedWindowIds()) this.hydrateWindowFromHistory(id, now);
    // 2) 收集区间内所有原始点，按时间戳分拍回放
    const byTs = new Map<number, Map<string, number>>();
    for (const s of this.registry.list()) {
      for (const p of this.history.query(s.def.id, from, now)) {
        let row = byTs.get(p.ts);
        if (!row) {
          row = new Map();
          byTs.set(p.ts, row);
        }
        row.set(p.sourceId, p.value);
      }
    }
    // 3) 已逐点落档的派生点：建立 ts 集合用于去重
    const existingTs = new Map<string, Set<number>>();
    for (const id of this.order) {
      const set = new Set(this.history.query(id, from, now).map((p) => p.ts));
      if (set.size) existingTs.set(id, set);
    }
    const timestamps = [...byTs.keys()].sort((a, b) => a - b);
    for (const ts of timestamps) {
      this.runPass(ts, byTs.get(ts)!, { skipExisting: existingTs });
    }
  }

  private trackedWindowIds(): string[] {
    const ids = new Set<string>();
    for (const parsed of this.parsed.values()) for (const win of collectWindows(parsed.ast)) ids.add(win.refId);
    return [...ids];
  }

  // ---------------- 实时计算 ----------------

  /**
   * 消费一批原始点（可能跨多个时间戳）：按时间戳分拍，每拍按拓扑序算出
   * 全部派生点，逐点留档并（可选）告警判定。返回本批新产出的派生点与事件。
   */
  consume(rawPoints: MetricPoint[], opts: { evaluateAlerts: boolean }): { points: MetricPoint[]; events: AlertEvent[] } {
    // 原始点先进入滚动窗口
    for (const p of rawPoints) this.windows.push(p.sourceId, p.ts, p.value);

    const groups = new Map<number, Map<string, number>>();
    for (const p of rawPoints) {
      let g = groups.get(p.ts);
      if (!g) {
        g = new Map();
        groups.set(p.ts, g);
      }
      g.set(p.sourceId, p.value);
    }
    const allPoints: MetricPoint[] = [];
    const allEvents: AlertEvent[] = [];
    for (const ts of [...groups.keys()].sort((a, b) => a - b)) {
      const { points, events } = this.runPass(ts, groups.get(ts)!, { evaluateAlerts: opts.evaluateAlerts });
      allPoints.push(...points);
      allEvents.push(...events);
    }
    return { points: allPoints, events: allEvents };
  }

  /**
   * 单个时间戳的计算拍。
   * @param rawTable 本拍到的原始值（sourceId -> value）；缺失即视为本拍无数据
   * @param evaluateAlerts 是否把产出的派生点送进告警引擎（预填回填时关闭）
   * @param skipExisting 回填去重用：某派生 id 在该 ts 已有点则不重复留档
   */
  private runPass(
    ts: number,
    rawTable: Map<string, number>,
    opts: { evaluateAlerts?: boolean; skipExisting?: Map<string, Set<number>> },
  ): { points: MetricPoint[]; events: AlertEvent[] } {
    const table = new Map<string, number>(rawTable);
    const produced: MetricPoint[] = [];
    const events: AlertEvent[] = [];

    // 每拍按拓扑序逐个落定；某一路失败不落点、不进表，下游会因此一并标异常，其它路照常
    for (const id of this.order) {
      const state = this.states.get(id)!;
      const parsed = this.parsed.get(id)!;
      try {
        const raw = evaluateFormula(parsed, {
          valueAt: (depId) => table.get(depId),
          windowValues: (depId, windowMs) => this.windows.values(depId, ts, windowMs),
          nameOf: (depId) => this.displayName(depId),
        });
        const value = Number(raw.toFixed(state.def.decimals));
        if (!Number.isFinite(value)) throw new FormulaEvalError('not_finite', '四舍五入后结果不是有限数值');

        table.set(id, value);
        // 派生点同样进滚动窗口（允许其它派生指标对其做窗口聚合；push 对同 ts 幂等）
        this.windows.push(id, ts, value);
        const alreadyStored = opts.skipExisting?.get(id)?.has(ts);
        if (!alreadyStored) this.history.add(id, ts, value);
        state.status = 'ok';
        state.lastError = null;
        state.lastPointTs = ts;
        const point: MetricPoint = { sourceId: id, ts, value };
        produced.push(point);
        if (opts.evaluateAlerts) events.push(...this.alerts.evaluate(point));
      } catch (err) {
        // 单路异常：不落点、不进表（下游会因此一并标异常），其它路照常计算
        table.delete(id);
        state.status = 'error';
        state.lastError = err instanceof FormulaEvalError ? err.message : `计算失败：${(err as Error).message}`;
        // 实时路径下，绑定该路的激活告警立即解除，并清除其最近值，杜绝旧值重判
        if (opts.evaluateAlerts) events.push(...this.alerts.invalidateSource(id, ts));
      }
    }

    return { points: produced, events };
  }

  displayName(id: string): string {
    const raw = this.registry.get(id);
    if (raw) return raw.def.name;
    return this.config.getDerivedDef(id)?.name ?? id;
  }
}

interface WindowRef {
  refId: string;
  windowMs: number;
}

function collectWindows(node: AstNode, out: WindowRef[] = []): WindowRef[] {
  switch (node.kind) {
    case 'num':
    case 'ref':
      return out;
    case 'unary':
      return collectWindows(node.arg, out);
    case 'binary':
      collectWindows(node.left, out);
      return collectWindows(node.right, out);
    case 'window':
      if (!out.some((w) => w.refId === node.refId && w.windowMs === node.windowMs)) {
        out.push({ refId: node.refId, windowMs: node.windowMs });
      }
      return out;
  }
}
