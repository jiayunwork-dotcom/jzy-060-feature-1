/**
 * 依赖关系整理与环检测 —— 派生指标的独立一块。
 *
 * 每个定义视作图上一个节点，“A 引用 B”对应 A -> B 的边；
 * 求值顺序要求被依赖者先算，因此返回的拓扑序中 B 在 A 之前。
 * 保存定义时若候选集合中存在环，立即拒绝并把“是哪几个指标绕成了环”
 * 原样返回给调用方（接口据此给用户清楚的错误提示）。
 */
import type { DerivedDef } from '../types';

/** 节点依赖关系：id -> 它直接引用的指标 id 列表 */
export type DepGraph = Map<string, string[]>;

export interface BuildInput {
  defs: DerivedDef[];
  /**
   * 从算式中提取直接依赖的函数（由 formula 模块注入，避免本模块依赖解析细节）。
   * 解析失败时抛出异常，调用方应在进入环检测之前先完成语法校验。
   */
  depsOf: (formula: string) => string[];
  /**
   * 只把“派生指标之间”的边纳入排序；指向原始指标的引用是图的叶子，
   * 但仍需由调用方保证它们存在（定义阶段的引用存在性校验）。
   */
  derivedIds: Set<string>;
}

export interface TopoResult {
  /** 求值顺序：被依赖者在前 */
  order: string[];
}

/**
 * Kahn 拓扑排序。要求输入图中不存在环（保存时已挡住）；
 * 万一存量数据里仍有环（例如旧版本遗留），通过 result 暴露未排序节点，
 * 由引擎把这些节点标记为 broken，而不是让整个计算停摆。
 */
export function topologicalSort(graph: DepGraph): { order: string[]; cyclic: string[] } {
  const indegree = new Map<string, number>();
  for (const id of graph.keys()) indegree.set(id, 0);
  for (const [id, deps] of graph) {
    for (const dep of deps) {
      if (graph.has(dep)) indegree.set(id, (indegree.get(id) ?? 0) + 1);
    }
  }
  // 先处理零入度（不依赖任何派生指标）的节点；同层按 id 排序保证结果稳定可复现
  let ready = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const [other, deps] of graph) {
      if (!deps.includes(id)) continue;
      const d = (indegree.get(other) ?? 0) - 1;
      indegree.set(other, d);
      if (d === 0) {
        ready.push(other);
        ready.sort();
      }
    }
  }
  const cyclic = [...graph.keys()].filter((id) => !order.includes(id));
  return { order, cyclic };
}

/** 依据定义集合构建“派生指标之间”的依赖图。 */
export function buildGraph(input: BuildInput): DepGraph {
  const graph: DepGraph = new Map();
  for (const def of input.defs) {
    const deps = input.depsOf(def.formula).filter((id) => input.derivedIds.has(id));
    graph.set(def.id, deps);
  }
  return graph;
}

export interface Cycle {
  /** 环上的节点，按 A -> B -> ... -> A 的顺序排列（首尾不重复） */
  path: string[];
}

/**
 * 环检测（DFS 三色标记）。返回找到的第一个环；无环返回 null。
 * path 按引用方向给出，例如 A 引用 B、B 又引用 A 时返回 ['A','B']。
 */
export function findCycle(graph: DepGraph): Cycle | null {
  const color = new Map<string, 0 | 1 | 2>(); // 0 白 1 灰（在当前栈上）2 黑
  for (const id of graph.keys()) color.set(id, 0);
  const stack: string[] = [];

  const dfs = (id: string): string[] | null => {
    color.set(id, 1);
    stack.push(id);
    for (const dep of graph.get(id) ?? []) {
      if (!graph.has(dep)) continue; // 指向图外（原始指标），忽略
      const c = color.get(dep);
      if (c === 1) {
        // 回到当前栈上的节点：截出环
        const start = stack.indexOf(dep);
        return stack.slice(start);
      }
      if (c === 0) {
        const found = dfs(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };

  // 按 id 顺序遍历，保证返回的环稳定
  for (const id of [...graph.keys()].sort()) {
    if (color.get(id) === 0) {
      const path = dfs(id);
      if (path) return { path };
    }
  }
  return null;
}

/**
 * 只找“包含指定节点”的环（用于保存某定义时，让报错链路一定带上它）。
 * 返回从 start 出发、沿引用方向回到 start 的节点序列；不经过 start 则 null。
 */
export function findCycleFromNode(graph: DepGraph, start: string): Cycle | null {
  if (!graph.has(start)) return null;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const dfs = (id: string): string[] | null => {
    stack.push(id);
    onStack.add(id);
    for (const dep of graph.get(id) ?? []) {
      if (!graph.has(dep)) continue;
      if (dep === start) return [...stack];
      if (onStack.has(dep)) continue;
      const found = dfs(dep);
      if (found) return found;
    }
    stack.pop();
    onStack.delete(id);
    return null;
  };
  const path = dfs(start);
  return path ? { path } : null;
}

/**
 * 定义保存前的完整校验辅助：
 * 用“候选定义集合（含待保存的新/改定义）”构图，先找环再求拓扑序。
 */
export function analyzeCandidates(defs: DerivedDef[], depsOf: (formula: string) => string[]): { graph: DepGraph; order: string[]; cycle: Cycle | null } {
  const derivedIds = new Set(defs.map((d) => d.id));
  const graph = buildGraph({ defs, depsOf, derivedIds });
  const cycle = findCycle(graph);
  const { order } = topologicalSort(graph);
  return { graph, order, cycle };
}

/** 计算某节点的全部（传递）下游依赖者：删除/关闭前提示“谁还在用它”。 */
export function dependentsOf(graph: DepGraph, id: string): string[] {
  const out = new Set<string>();
  const walk = (target: string) => {
    for (const [other, deps] of graph) {
      if (deps.includes(target) && !out.has(other)) {
        out.add(other);
        walk(other);
      }
    }
  };
  walk(id);
  return [...out].sort();
}
