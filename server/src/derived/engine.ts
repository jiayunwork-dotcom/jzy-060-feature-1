/**
 * 派生指标引擎：管理用户定义的“算出来的指标”的完整生命周期。
 *
 * 职责：
 *  - 定义校验（语法、未知引用、循环依赖）与持久化（ConfigStore）；
 *  - 每个实时节拍按依赖拓扑序求值：被依赖的先算，算出的点立刻可供下游引用；
 *  - 窗口聚合（avg/min/max/last）直接读历史留档（含本拍刚写入的点）；
 *  - 取值约定：任何被依赖的指标本拍没有新点（源被关闭/采集异常/上游失败），
 *    这一路就不产点、状态置 error 并说明原因——绝不拿旧值凑数；
 *    除零等非有限结果同样只把本路标为异常，不连累其它指标。
 */
import type { DerivedMetricDef, MetricPoint, SourceState } from '../types';
import type { ConfigStore } from '../storage/configStore';
import type { HistoryStore } from '../storage/historyStore';
import type { SourceRegistry } from '../sources/registry';
import { shortId } from '../util/random';
import { collectRefs, evaluateAst, parseExpression, ExpressionParseError, EvaluationError, type AggFn, type AstNode } from './expression';
import { findCycle, formatCycle, topoOrder } from './graph';

/** 创建/更新派生指标时的用户输入 */
export interface DerivedInput {
  id?: string;
  name?: string;
  unit?: string;
  decimals?: number;
  max?: number;
  expression?: string;
  description?: string;
}

/** 校验/操作结果：失败时带面向用户的错误码与消息 */
export type DerivedResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; message: string; cycle?: string[]; refs?: string[]; dependents?: string[] };

interface DerivedRuntimeState {
  status: 'ok' | 'error';
  lastError: string | null;
  lastPointTs: number | null;
}

const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
/** 聚合函数名保留，不能用作指标 id（避免表达式歧义） */
const RESERVED_IDS = new Set(['avg', 'min', 'max', 'last']);
const MAX_EXPRESSION_LEN = 500;

function fail(status: number, error: string, message: string, extra?: Partial<Extract<DerivedResult<never>, { ok: false }>>): DerivedResult<never> {
  return { ok: false, status, error, message, ...extra };
}

export class DerivedEngine {
  private config: ConfigStore;
  private history: HistoryStore;
  private registry: SourceRegistry;

  private defs = new Map<string, DerivedMetricDef>();
  private compiled = new Map<string, AstNode>();
  private refsOf = new Map<string, string[]>();
  /** 拓扑序：被依赖的先算；任何定义变化后重算 */
  private order: string[] = [];
  private states = new Map<string, DerivedRuntimeState>();

  constructor(config: ConfigStore, history: HistoryStore, registry: SourceRegistry) {
    this.config = config;
    this.history = history;
    this.registry = registry;
    for (const def of config.getDerived()) {
      this.defs.set(def.id, def);
      this.states.set(def.id, { status: 'ok', lastError: null, lastPointTs: null });
      this.history.register(def.id);
      // 重启后从历史恢复“最近产出时间”，保证预填/计算幂等（不重复产点）
      const latest = this.history.latest(def.id);
      if (latest) this.states.get(def.id)!.lastPointTs = latest.ts;
    }
    this.rebuild();
  }

  /** 重新编译全部定义并重排拓扑序（启动时与每次增删改后调用）。 */
  private rebuild(): void {
    this.compiled.clear();
    this.refsOf.clear();
    for (const [id, def] of this.defs) {
      try {
        const ast = parseExpression(def.expression);
        this.compiled.set(id, ast);
        this.refsOf.set(id, collectRefs(ast));
      } catch {
        // 持久化的定义理论上都通过过校验；若文件被手工改坏，跳过该路（状态置错）
        this.compiled.delete(id);
        this.refsOf.set(id, []);
        const st = this.states.get(id);
        if (st) {
          st.status = 'error';
          st.lastError = '定义的计算式无法解析，请编辑修正';
        }
      }
    }
    const edges = new Map<string, string[]>();
    for (const id of this.defs.keys()) {
      edges.set(id, (this.refsOf.get(id) ?? []).filter((r) => this.defs.has(r)));
    }
    this.order = topoOrder([...this.defs.keys()], edges);
  }

  has(id: string): boolean {
    return this.defs.has(id);
  }

  hasAny(): boolean {
    return this.defs.size > 0;
  }

  get(id: string): DerivedMetricDef | undefined {
    return this.defs.get(id);
  }

  list(): DerivedMetricDef[] {
    return [...this.defs.values()];
  }

  /** 某指标计算式引用到的全部指标 id */
  getRefs(id: string): string[] {
    return this.refsOf.get(id) ?? [];
  }

  /** 某指标被哪些派生指标引用（删除前检查用） */
  dependentsOf(id: string): string[] {
    return [...this.refsOf.entries()]
      .filter(([otherId, refs]) => otherId !== id && refs.includes(id))
      .map(([otherId]) => otherId)
      .sort();
  }

  /** 以 SourceState 形式暴露，让派生指标在数据源清单里与原始指标同等呈现。 */
  listStates(): SourceState[] {
    return this.list().map((def) => this.stateOf(def));
  }

  getState(id: string): SourceState | undefined {
    const def = this.defs.get(id);
    return def ? this.stateOf(def) : undefined;
  }

  private stateOf(def: DerivedMetricDef): SourceState {
    const st = this.states.get(def.id) ?? { status: 'ok' as const, lastError: null, lastPointTs: null };
    return {
      def: {
        id: def.id,
        name: def.name,
        kind: 'derived',
        unit: def.unit,
        max: def.max,
        decimals: def.decimals,
        description: def.description || `算式：${def.expression}`,
      },
      enabled: this.config.isEnabled(def.id, true),
      status: st.status,
      lastError: st.lastError,
      lastPointTs: st.lastPointTs,
    };
  }

  isEnabled(id: string): boolean {
    return this.config.isEnabled(id, true);
  }

  setEnabled(id: string, enabled: boolean): SourceState | undefined {
    const def = this.defs.get(id);
    if (!def) return undefined;
    this.config.setEnabled(id, enabled);
    return this.stateOf(def);
  }

  // ---------- 定义校验 ----------

  /**
   * 校验一份（可能是合并后的）定义输入。
   * selfId：更新场景下被更新的指标 id（新建为 null）。
   */
  private validate(input: DerivedInput, selfId: string | null): DerivedResult<{ def: DerivedMetricDef; ast: AstNode; refs: string[] }> {
    // id：新建时可指定（需合法且唯一），不指定则自动生成；更新时不可改
    let id = selfId;
    if (!selfId) {
      if (input.id !== undefined && input.id !== '') {
        id = String(input.id).trim();
        if (!ID_PATTERN.test(id)) {
          return fail(400, 'invalid_id', 'id 只能由字母、数字、下划线组成，且需以字母或下划线开头（最长 32 字符）');
        }
        if (RESERVED_IDS.has(id)) {
          return fail(400, 'invalid_id', `id “${id}” 是聚合函数保留字，请换一个`);
        }
        if (this.registry.get(id)) {
          return fail(400, 'invalid_id', `id “${id}” 与内置采集指标重名，请换一个`);
        }
        if (this.defs.has(id)) {
          return fail(409, 'duplicate_id', `id “${id}” 已被其它派生指标使用`);
        }
      } else {
        id = shortId('d_');
      }
    }

    const existing = selfId ? this.defs.get(selfId) : undefined;
    const name = (input.name ?? existing?.name ?? '').trim();
    if (!name) return fail(400, 'invalid_name', '名称不能为空');
    if (name.length > 60) return fail(400, 'invalid_name', '名称最长 60 个字符');

    const unit = (input.unit ?? existing?.unit ?? '').trim();
    if (unit.length > 16) return fail(400, 'invalid_unit', '单位最长 16 个字符');

    const decimals = input.decimals ?? existing?.decimals ?? 2;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) {
      return fail(400, 'invalid_decimals', '小数位必须是 0~6 的整数');
    }

    const max = input.max ?? existing?.max ?? 100;
    if (!Number.isFinite(max) || max <= 0) {
      return fail(400, 'invalid_max', '满量程（max）必须是大于 0 的数字');
    }

    const expression = (input.expression ?? existing?.expression ?? '').trim();
    if (!expression) return fail(400, 'invalid_expression', '计算式不能为空');
    if (expression.length > MAX_EXPRESSION_LEN) {
      return fail(400, 'invalid_expression', `计算式最长 ${MAX_EXPRESSION_LEN} 个字符`);
    }

    // 1) 语法：解析成 AST，错误消息直接反馈给用户
    let ast: AstNode;
    try {
      ast = parseExpression(expression);
    } catch (err) {
      if (err instanceof ExpressionParseError) {
        return fail(400, 'invalid_expression', `计算式语法错误：${err.message}`);
      }
      throw err;
    }

    // 2) 引用：必须指向已存在的原始指标或派生指标
    const refs = collectRefs(ast);
    const unknown = refs.filter((r) => !this.registry.get(r) && !this.defs.has(r) && r !== selfId);
    if (unknown.length) {
      return fail(400, 'unknown_reference', `计算式引用了不存在的指标：${unknown.join('、')}`, { refs: unknown });
    }

    // 3) 环检测：把这份定义放进全量图里试跑，成环即拒绝并指出环节点
    const edges = new Map<string, string[]>();
    const ids = new Set(this.defs.keys());
    ids.add(id!);
    for (const otherId of ids) {
      if (otherId === id) {
        edges.set(otherId, refs.filter((r) => ids.has(r)));
      } else {
        edges.set(otherId, (this.refsOf.get(otherId) ?? []).filter((r) => ids.has(r)));
      }
    }
    const cycle = findCycle([...ids], edges);
    if (cycle) {
      return fail(400, 'cycle_detected', `检测到循环依赖：${formatCycle(cycle)}。请调整计算式，让依赖关系不构成环。`, { cycle });
    }

    const now = Date.now();
    const def: DerivedMetricDef = {
      id: id!,
      name,
      unit,
      decimals,
      max,
      expression,
      description: (input.description ?? existing?.description ?? '').trim(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return { ok: true, value: { def, ast, refs } };
  }

  create(input: DerivedInput): DerivedResult<DerivedMetricDef> {
    const v = this.validate(input, null);
    if (!v.ok) return v;
    const { def } = v.value;
    this.config.addDerived(def);
    this.defs.set(def.id, def);
    this.states.set(def.id, { status: 'ok', lastError: null, lastPointTs: null });
    this.history.register(def.id);
    this.rebuild();
    return { ok: true, value: def };
  }

  update(id: string, input: DerivedInput): DerivedResult<DerivedMetricDef> {
    if (!this.defs.has(id)) return fail(404, 'derived_not_found', `派生指标 ${id} 不存在`);
    const v = this.validate(input, id);
    if (!v.ok) return v;
    const def = this.config.updateDerived(id, v.value.def)!;
    this.defs.set(id, def);
    this.rebuild();
    return { ok: true, value: def };
  }

  /**
   * 删除：若仍被其它派生指标引用则拒绝（409），由调用方决定是否级联清理告警规则。
   */
  delete(id: string): DerivedResult<{ id: string }> {
    if (!this.defs.has(id)) return fail(404, 'derived_not_found', `派生指标 ${id} 不存在`);
    const dependents = this.dependentsOf(id);
    if (dependents.length) {
      return fail(409, 'has_dependents', `派生指标 ${dependents.join('、')} 的计算式仍引用 ${id}，请先修改或删除它们`, { dependents });
    }
    this.config.deleteDerived(id);
    this.defs.delete(id);
    this.states.delete(id);
    this.history.remove(id);
    this.rebuild();
    return { ok: true, value: { id } };
  }

  // ---------- 运行时计算 ----------

  private aggregate(ref: string, fn: AggFn, windowMs: number, ts: number): number | undefined {
    const values = this.history.windowValues(ref, windowMs, ts);
    if (!values.length) return undefined;
    switch (fn) {
      case 'avg':
        return values.reduce((a, b) => a + b, 0) / values.length;
      case 'min':
        return Math.min(...values);
      case 'max':
        return Math.max(...values);
      case 'last':
        return values[values.length - 1];
    }
  }

  private markError(id: string, message: string): void {
    const st = this.states.get(id);
    if (!st) return;
    st.status = 'error';
    st.lastError = message;
  }

  /**
   * 一个节拍的派生计算：batch 是本拍各指标的最新值（原始点 + 本拍已算出的派生点）。
   * 按拓扑序逐个求值；产出的点通过 sink 立刻落档并进入告警管线，
   * 同时写回 batch 供本拍下游派生指标引用。
   * 幂等：同一指标对同一时间戳只产出一次（重启预填不会重复产点）。
   */
  evaluateTick(batch: Map<string, number>, ts: number, sink: (point: MetricPoint) => void): MetricPoint[] {
    const produced: MetricPoint[] = [];
    for (const id of this.order) {
      const def = this.defs.get(id)!;
      const st = this.states.get(id)!;
      if (!this.isEnabled(id)) continue; // 用户关掉了这一路
      if (st.lastPointTs !== null && ts <= st.lastPointTs) continue; // 该拍已产出过
      const ast = this.compiled.get(id);
      if (!ast) continue; // 定义损坏（状态已在 rebuild 置错）

      // 新鲜度门槛：所有被引用的指标本拍都必须有新点，否则本路不产点
      const missing = (this.refsOf.get(id) ?? []).filter((r) => !batch.has(r));
      if (missing.length) {
        this.markError(id, `依赖的指标本拍无数据：${missing.join('、')}（源已关闭或采集异常）`);
        continue;
      }

      try {
        const value = evaluateAst(ast, {
          get: (ref) => batch.get(ref),
          aggregate: (ref, fn, windowMs) => this.aggregate(ref, fn, windowMs, ts),
        });
        const rounded = Number(value.toFixed(def.decimals));
        const point: MetricPoint = { sourceId: id, ts, value: rounded };
        batch.set(id, rounded);
        sink(point);
        st.status = 'ok';
        st.lastError = null;
        st.lastPointTs = ts;
        produced.push(point);
      } catch (err) {
        if (err instanceof EvaluationError) {
          this.markError(id, err.message);
        } else {
          this.markError(id, `计算失败：${(err as Error).message}`);
        }
      }
    }
    return produced;
  }
}
