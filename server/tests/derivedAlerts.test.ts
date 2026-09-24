/**
 * 派生指标 · 行为三：
 * 对带时间窗口聚合的派生指标设阈值告警，喂入一串让窗口聚合值越过阈值再回落的
 * 数据点后，告警按新值先触发后解除；改动阈值后立即按新阈值判定（无需等新点）。
 * 脾气与给原始指标设告警完全一致：同一告警引擎、同一 fired/resolved 语义。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, startServer, type TestServer } from './helpers/server';

describe('派生指标的告警：窗口聚合值越限触发、回落解除、改阈值即时生效（行为三）', () => {
  let server: TestServer;
  let ruleId: string;
  const T = 1_760_001_000_000;

  beforeAll(async () => {
    server = await startServer({ tickMs: 100000 }); // 不产生随机点，全靠确定性注入
    const def = await api(server, '/derived', {
      method: 'POST',
      body: JSON.stringify({ id: 'err_avg', name: '平均错误率', unit: '%', decimals: 2, expression: 'avg(error_rate, 5m)' }),
    });
    expect(def.status).toBe(201);

    // 派生指标可以像原始指标一样设阈值告警
    const rule = await api(server, '/alerts/rules', {
      method: 'POST',
      body: JSON.stringify({ sourceId: 'err_avg', level: 'warning', operator: '>', threshold: 5, note: '五分钟平均错误率过高' }),
    });
    expect(rule.status).toBe(201);
    ruleId = rule.body.id;
  });
  afterAll(async () => {
    await server.stop();
  });

  async function ingestErrorRate(value: number, ts: number) {
    const r = await api(server, '/test/ingest', {
      method: 'POST',
      body: JSON.stringify({ points: [{ sourceId: 'error_rate', ts, value }] }),
    });
    expect(r.status).toBe(201);
    return r.body;
  }

  it('窗口均值越过阈值触发 warning，回落后解除', async () => {
    // 序列：0,0,0,10,10,10,10,10,0,0 —— 累计均值 0,0,0,2.5,4,5,5.71,6.25,5.56,5
    const seq = [0, 0, 0, 10, 10, 10, 10, 10, 0, 0];

    // 前 6 拍均值最高到 5，未越限：无事件、无激活告警
    for (let i = 0; i < 6; i++) {
      const body = await ingestErrorRate(seq[i], T + i * 1000);
      expect(body.events.filter((e: any) => e.ruleId === ruleId)).toHaveLength(0);
    }
    expect((await api(server, '/alerts/active')).body).toHaveLength(0);

    // 第 7 拍均值 5.71 > 5：触发 warning，事件上的值就是派生指标算出的新值
    const b7 = await ingestErrorRate(seq[6], T + 6 * 1000);
    const fired = b7.events.find((e: any) => e.ruleId === ruleId && e.phase === 'fired');
    expect(fired).toBeTruthy();
    expect(fired.level).toBe('warning');
    expect(fired.sourceId).toBe('err_avg');
    expect(fired.value).toBe(5.71);
    const active = (await api(server, '/alerts/active')).body;
    expect(active.map((a: any) => a.ruleId)).toEqual([ruleId]);

    // 第 8、9 拍仍在阈值上方：不重复触发
    for (const i of [7, 8]) {
      const body = await ingestErrorRate(seq[i], T + i * 1000);
      expect(body.events.filter((e: any) => e.ruleId === ruleId)).toHaveLength(0);
    }

    // 第 10 拍均值回落到 5：解除
    const b10 = await ingestErrorRate(seq[9], T + 9 * 1000);
    const resolved = b10.events.find((e: any) => e.ruleId === ruleId && e.phase === 'resolved');
    expect(resolved).toBeTruthy();
    expect(resolved.value).toBe(5);
    expect((await api(server, '/alerts/active')).body).toHaveLength(0);

    // 事件历史里 fired/resolved 成对
    const events = (await api(server, '/alerts/events')).body.filter((e: any) => e.ruleId === ruleId);
    expect(events.map((e: any) => e.phase).sort()).toEqual(['fired', 'resolved']);
  });

  it('改动阈值后立即按新阈值判定（用最近一个真实派生值，不等新点）', async () => {
    // 当前 err_avg 最近值是 5：阈值 5 不越限；收紧到 4 应立即触发
    const tighten = await api(server, `/alerts/rules/${ruleId}`, {
      method: 'PUT',
      body: JSON.stringify({ threshold: 4 }),
    });
    expect(tighten.body.threshold).toBe(4);
    let active = (await api(server, '/alerts/active')).body;
    expect(active.some((a: any) => a.ruleId === ruleId)).toBe(true);

    // 放宽回 5：立即解除
    await api(server, `/alerts/rules/${ruleId}`, {
      method: 'PUT',
      body: JSON.stringify({ threshold: 5 }),
    });
    active = (await api(server, '/alerts/active')).body;
    expect(active.some((a: any) => a.ruleId === ruleId)).toBe(false);
  });
});
