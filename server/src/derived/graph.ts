/**
 * 派生指标依赖图：把“谁依赖谁”整理成计算顺序，并在保存定义前做环检测。
 * 只关心派生指标之间的边（原始采集指标是没有出边的叶子，永远可先取到）。
 *
 * 边方向：id -> 它依赖的派生指标 id 列表。
 * topoOrder 返回“被依赖的先算”的顺序；findCycle 返回成环节点链（用于拒绝保存）。
 */

/**
 * 拓扑排序（Kahn），结果确定：同层按 id 字典序，保证同一组定义每次算出同样的顺序。
 * 前提：图无环（调用方先用 findCycle 把关）。
 */
export function topoOrder(ids: string[], edges: Map<string, string[]>): string[] {
  // indeg[id] = id 还等待多少个“被自己依赖”的节点先算完
  const indeg = new Map<string, number>();
  // dependents[dep] = 依赖 dep 的节点列表
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    indeg.set(id, 0);
    dependents.set(id, []);
  }
  for (const id of ids) {
    for (const dep of edges.get(id) ?? []) {
      if (!indeg.has(dep)) continue; // 依赖的是原始指标，不参与排序
      indeg.set(id, (indeg.get(id) ?? 0) + 1);
      dependents.get(dep)!.push(id);
    }
  }
  const ready = ids.filter((id) => indeg.get(id) === 0).sort();
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const left = indeg.get(next)! - 1;
      indeg.set(next, left);
      if (left === 0) {
        // 保持确定性：按字典序插入
        const at = ready.findIndex((x) => x > next);
        if (at === -1) ready.push(next);
        else ready.splice(at, 0, next);
      }
    }
  }
  return order;
}

/**
 * 环检测（三色 DFS）。返回成环的节点链（如 ['a','b','c'] 表示 a→b→c→a），
 * 无环返回 null。用于保存定义时拒绝并清楚告知用户是哪几个指标绕成了环。
 */
export function findCycle(ids: string[], edges: Map<string, string[]>): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(ids.map((id) => [id, WHITE]));
  const stack: string[] = [];

  const dfs = (id: string): string[] | null => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of edges.get(id) ?? []) {
      if (!color.has(dep)) continue; // 原始指标是叶子
      const c = color.get(dep)!;
      if (c === GRAY) {
        // 栈中从 dep 到栈顶就是环
        return stack.slice(stack.indexOf(dep));
      }
      if (c === WHITE) {
        const found = dfs(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };

  for (const id of [...ids].sort()) {
    if (color.get(id) === WHITE) {
      const found = dfs(id);
      if (found) return found;
    }
  }
  return null;
}

/** 把环格式化成用户可读的说明：a → b → c → a */
export function formatCycle(cycle: string[]): string {
  return [...cycle, cycle[0]].join(' → ');
}
