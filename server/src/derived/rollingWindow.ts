/**
 * 滚动窗口聚合 —— 派生指标的独立一块。
 *
 * 为每一路被窗口函数引用的指标维护一段按时间有序的点缓冲，
 * 支持 O(log n) 下界二分 + 区间取值，供 avg/max/min/last 使用。
 * 缓冲只保留“当前所有算式中出现过的最大窗口”长度，随节拍滚动淘汰，
 * 与 24 小时历史留档解耦（后者负责回放，本模块只负责实时滚动计算）。
 */
export interface WindowPoint {
  ts: number;
  value: number;
}

export class RollingWindowBuffer {
  /** sourceId -> 有序点（实时路径只在尾部追加） */
  private buffers = new Map<string, WindowPoint[]>();
  /** sourceId -> 该指标被引用的最大窗口毫秒数 */
  private maxWindowMs = new Map<string, number>();

  /** 声明某指标会被窗口函数引用；同一指标取出现过的最大窗口。 */
  track(sourceId: string, windowMs: number): void {
    const prev = this.maxWindowMs.get(sourceId) ?? 0;
    if (windowMs > prev) this.maxWindowMs.set(sourceId, windowMs);
    if (!this.buffers.has(sourceId)) this.buffers.set(sourceId, []);
  }

  has(sourceId: string): boolean {
    return this.buffers.has(sourceId);
  }

  /** 批量灌入起始历史（如启动预填/重启恢复），灌入后排序并按窗口裁掉多余部分。 */
  hydrate(sourceId: string, points: WindowPoint[]): void {
    if (!this.buffers.has(sourceId)) this.buffers.set(sourceId, []);
    const buf = this.buffers.get(sourceId)!;
    buf.push(...points);
    buf.sort((a, b) => a.ts - b.ts);
    const last = buf[buf.length - 1];
    if (last) this.pruneSource(sourceId, last.ts);
  }

  /**
   * 追加一个实时点（正常路径时间戳单调递增；回填路径做有序插入）。
   * 同一 sourceId + ts 视为同一点：幂等覆盖取值，保证启动回填等重放路径
   * 不会把同一个点重复计入窗口聚合。
   */
  push(sourceId: string, ts: number, value: number): void {
    let buf = this.buffers.get(sourceId);
    if (!buf) {
      buf = [];
      this.buffers.set(sourceId, buf);
    }
    const last = buf[buf.length - 1];
    if (last && last.ts === ts) {
      last.value = value;
      return;
    }
    if (!last || ts > last.ts) {
      buf.push({ ts, value });
    } else {
      let lo = 0;
      let hi = buf.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (buf[mid].ts < ts) lo = mid + 1;
        else hi = mid;
      }
      if (lo < buf.length && buf[lo].ts === ts) buf[lo].value = value;
      else buf.splice(lo, 0, { ts, value });
    }
    this.pruneSource(sourceId, ts);
  }

  private pruneSource(sourceId: string, nowTs: number): void {
    const win = this.maxWindowMs.get(sourceId);
    const buf = this.buffers.get(sourceId);
    if (!win || !buf) return;
    // 保留可能仍落在半开窗口内的点；下界边界点可被物理淘汰
    const cutoff = nowTs - win;
    let lo = 0;
    while (lo < buf.length && buf[lo].ts <= cutoff) lo += 1;
    if (lo > 0) buf.splice(0, lo);
  }

  /**
   * 取半开区间 (ts-windowMs, ts] 内的点值（按时间升序）；无点返回空数组。
   * 下界排除、上界包含：在整秒节拍上“最近 5 秒”每拍恰好是最近 5 个点，
   * 不会把 5 秒前边界上的那一拍也算进来变成 6 个。
   */
  values(sourceId: string, ts: number, windowMs: number): number[] {
    const buf = this.buffers.get(sourceId);
    if (!buf || buf.length === 0) return [];
    const from = ts - windowMs;
    // 下界二分：第一个 ts > from
    let lo = 0;
    let hi = buf.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (buf[mid].ts <= from) lo = mid + 1;
      else hi = mid;
    }
    const out: number[] = [];
    for (let i = lo; i < buf.length; i += 1) {
      if (buf[i].ts > ts) break;
      out.push(buf[i].value);
    }
    return out;
  }

  /** 最近一个点的时间戳，无则 null（供测试/诊断）。 */
  latestTs(sourceId: string): number | null {
    const buf = this.buffers.get(sourceId);
    return buf && buf.length ? buf[buf.length - 1].ts : null;
  }

  size(sourceId: string): number {
    return this.buffers.get(sourceId)?.length ?? 0;
  }
}
