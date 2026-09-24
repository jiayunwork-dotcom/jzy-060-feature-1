/**
 * 钉死行为三：对一个“带时间窗口聚合”的派生指标设阈值告警，喂入一串会让
 * 窗口聚合值先越过阈值再回落的数据点后，告警按窗口聚合的新值先触发后解除；
 * 随后改动阈值，立即按最近一个真实聚合值用新阈值重判（无需等新点）。
 *
 * 派生指标：avg_err = avg(error_rate, 5s) —— 最近 5 秒错误率的平均。
 * 用固定时间戳逐点注入，窗口聚合结果完全确定。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, startServer, type TestServer } from './helpers/server';

const RAW = ['cpu', 'memory', 'network', 'rps', 'online', 'error_rate'];

function feed(server: TestServer, ts: number, value: number) {
  return api(server, '/test/ingest', {
    method: 'POST',
    body: JSON.stringify({ points: [{ sourceId: 'error_rate', ts, value }] }),
  });
}

describe('派生指标：窗口聚合告警的触发/回落/改阈值', () => {
  let server: TestServer;
  let derivedId: string;
  let ruleId: string;
  const t0 = 1_700_000_000_000;

  beforeAll(async () => {
    server = await startServer({ tickMs: 100000 });
    for (const id of RAW) {
      await api(server, `/sources/${id}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    }
    const created = await api(server, '/derived', {
      method: 'POST',
      body: JSON.stringify({ name: '近5秒平均错误率', unit: '%', decimals: 2, max: 10, formula: 'avg(error_rate, 5s)', description: '窗口聚合' }),
    });
    expect(created.status).toBe(201);
    derivedId = created.body.def.id;

    const rule = await api(server, '/alerts/rules', {
      method: 'POST',
      body: JSON.stringify({ sourceId: derivedId, level: 'warning', operator: '>', threshold: 5, note: '窗口错误率过高' }),
    });
    expect(rule.status).toBe(201);
    ruleId = rule.body.id;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('窗口平均值越限触发告警、回落后解除（事件脾气与原始指标一致）', async () => {
    // 连续 5 个点都在低位：5s 窗口平均值 <= 5，不触发
    const lows = [1, 2, 3, 4, 5];
    for (let i = 0; i < lows.length; i++) {
      await feed(server, t0 + i * 1000, lows[i]);
    }
    expect((await api(server, '/alerts/active')).body).toHaveLength(0);

    // 再喂 4 个高位点（ts+5..ts+8，值 9）。窗口随时间滚动：
    //  ts+5: 窗内 [2,3,4,5,9]      avg=4.6  安全
    //  ts+6: 窗内 [3,4,5,9,9]      avg=6.0  越过 5 -> fired
    //  ts+7: 窗内 [4,5,9,9,9]      avg=7.2  仍越限
    //  ts+8: 窗内 [5,9,9,9,9]      avg=8.2  仍越限
    let firedAt = -1;
    for (let i = 5; i <= 8; i++) {
      const r = await feed(server, t0 + i * 1000, 9);
      const fired = r.body.events.find((e: any) => e.ruleId === ruleId && e.phase === 'fired');
      if (fired) {
        expect(firedAt).toBe(-1); // 只触发一次
        firedAt = i;
        expect(fired.value).toBe(6);
        expect(fired.level).toBe('warning');
      }
    }
    expect(firedAt).toBe(6);
    let active = (await api(server, '/alerts/active')).body;
    expect(active.map((a: any) => a.ruleId)).toContain(ruleId);
    // 触发依据的是窗口聚合值而非原始 error_rate(原始值早就 > 5)
    expect(active[0].sourceId).toBe(derivedId);

    // 回落到低位（值 1），窗口平均值逐步回落：
    //  ts+9:  [9,9,9,9,1] avg=7.4
    //  ts+10: [9,9,9,1,1] avg=5.8
    //  ts+11: [9,9,1,1,1] avg=4.2  回到安全侧 -> resolved
    //  ts+12: [9,1,1,1,1] avg=2.6
    let resolvedAt = -1;
    for (let i = 9; i <= 12; i++) {
      const r = await feed(server, t0 + i * 1000, 1);
      const resolved = r.body.events.find((e: any) => e.ruleId === ruleId && e.phase === 'resolved');
      if (resolved) {
        expect(resolvedAt).toBe(-1);
        resolvedAt = i;
        expect(resolved.value).toBe(4.2);
      }
    }
    expect(resolvedAt).toBe(11);
    active = (await api(server, '/alerts/active')).body;
    expect(active.map((a: any) => a.ruleId)).not.toContain(ruleId);

    // fired / resolved 成对进入事件历史，且都绑定派生指标
    const events = (await api(server, '/alerts/events')).body.filter((e: any) => e.ruleId === ruleId);
    const phases = events.map((e: any) => e.phase).sort();
    expect(phases).toEqual(['fired', 'resolved']);
    expect(events.every((e: any) => e.sourceId === derivedId)).toBe(true);
  });

  it('改动阈值后立即按最近一个真实聚合值用新阈值判定', async () => {
    // 当前最近一个聚合值：ts+12 窗口 [9,1,1,1,1] avg=2.6，阈值 5，安全
    const recent = await api(server, `/history?from=${t0 + 12000}&to=${t0 + 12000}&sources=${derivedId}`);
    expect(recent.body.series[derivedId].points[0].value).toBe(2.6);
    expect((await api(server, '/alerts/active')).body).toHaveLength(0);

    // 把阈值降到 2：2.6 > 2，无需等新点立即触发
    let updated = await api(server, `/alerts/rules/${ruleId}`, { method: 'PUT', body: JSON.stringify({ threshold: 2 }) });
    expect(updated.body.threshold).toBe(2);
    let active = (await api(server, '/alerts/active')).body;
    expect(active.some((a: any) => a.ruleId === ruleId)).toBe(true);

    // 把阈值抬到 3：2.6 <= 3，立即解除
    updated = await api(server, `/alerts/rules/${ruleId}`, { method: 'PUT', body: JSON.stringify({ threshold: 3 }) });
    expect(updated.body.threshold).toBe(3);
    active = (await api(server, '/alerts/active')).body;
    expect(active.some((a: any) => a.ruleId === ruleId)).toBe(false);
  });
});
