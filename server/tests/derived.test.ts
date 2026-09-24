/**
 * 派生指标 · 行为一 & 行为二：
 *  - 多层依赖的定义按依赖顺序计算，结果与手工按式子推算逐值相等（含窗口聚合）；
 *  - 会成环的定义在保存时被拒绝，并清楚指出环节点；已有定义不受影响照常计算。
 * 同时锁定：定义校验（语法/未知引用/id 规范）、删除语义（被引用则拒删、
 * 级联清理告警规则）、定义落盘（重启后仍在）。
 * 全部通过 HTTP 接口黑盒断言，注入走 /api/test/ingest（与真实节拍同一管线）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api, startServer, type TestServer } from './helpers/server';

/** 在响应的 derived 数组里取某指标本拍产出的值 */
function derivedValue(res: { body: any }, id: string): number | undefined {
  return res.body.derived?.find((p: any) => p.sourceId === id)?.value;
}

describe('派生指标：依赖顺序与求值正确性（行为一）', () => {
  let server: TestServer;
  // 固定基准时间，注入点全部带显式时间戳，互不重叠
  const T = 1_760_000_000_000;

  beforeAll(async () => {
    server = await startServer({ tickMs: 100000 }); // 极大节拍：测试期间不产生随机点干扰
  });
  afterAll(async () => {
    await server.stop();
  });

  it('创建多层依赖的定义：m_sum 依赖两路原始指标，m_mix/m_deep 再层层引用', async () => {
    const defs = [
      { id: 'm_sum', name: 'CPU+内存合计', unit: '%', decimals: 1, expression: 'cpu + memory' },
      { id: 'm_mix', name: '综合水位', unit: '%', decimals: 2, expression: 'm_sum * 2 - cpu / 4' },
      { id: 'm_deep', name: '三层混合', unit: '%', decimals: 2, expression: '(m_mix + m_sum) / 3' },
      { id: 'm_const', name: '带常数与括号', unit: '', decimals: 2, expression: '(cpu - 8) * (1 + 1) / 2 - 5' },
      { id: 'sum_avg', name: '合计的3秒均值', unit: '%', decimals: 2, expression: 'avg(m_sum, 3s)' },
      { id: 'cpu_avg3', name: 'CPU 3秒均值', unit: '%', decimals: 2, expression: 'avg(cpu, 3s)' },
      { id: 'cpu_max3', name: 'CPU 3秒最大', unit: '%', decimals: 2, expression: 'max(cpu, 3s)' },
      { id: 'cpu_min3', name: 'CPU 3秒最小', unit: '%', decimals: 2, expression: 'min(cpu, 3s)' },
      { id: 'cpu_last3', name: 'CPU 3秒末值', unit: '%', decimals: 2, expression: 'last(cpu, 3s)' },
    ];
    for (const def of defs) {
      const r = await api(server, '/derived', { method: 'POST', body: JSON.stringify(def) });
      expect(r.status).toBe(201);
    }
    const list = await api(server, '/derived');
    expect(list.body).toHaveLength(defs.length);
    // 依赖关系随定义一起返回
    expect(list.body.find((d: any) => d.id === 'm_deep').refs.sort()).toEqual(['m_mix', 'm_sum']);
  });

  it('逐拍注入后，各层结果与手工推算逐值相等', async () => {
    // 第 1 拍：cpu=48, memory=60
    let r = await api(server, '/test/ingest', {
      method: 'POST',
      body: JSON.stringify({ points: [{ sourceId: 'cpu', ts: T, value: 48 }, { sourceId: 'memory', ts: T, value: 60 }] }),
    });
    expect(r.status).toBe(201);
    expect(derivedValue(r, 'm_sum')).toBe(108); // 48 + 60
    expect(derivedValue(r, 'm_mix')).toBe(204); // 108*2 - 48/4
    expect(derivedValue(r, 'm_deep')).toBe(104); // (204 + 108) / 3
    expect(derivedValue(r, 'm_const')).toBe(35); // (48-8)*2/2 - 5
    expect(derivedValue(r, 'sum_avg')).toBe(108); // 窗口内只有 108
    expect(derivedValue(r, 'cpu_avg3')).toBe(48);
    expect(derivedValue(r, 'cpu_max3')).toBe(48);
    expect(derivedValue(r, 'cpu_min3')).toBe(48);
    expect(derivedValue(r, 'cpu_last3')).toBe(48);

    // 第 2 拍：cpu=51, memory=63
    r = await api(server, '/test/ingest', {
      method: 'POST',
      body: JSON.stringify({ points: [{ sourceId: 'cpu', ts: T + 1000, value: 51 }, { sourceId: 'memory', ts: T + 1000, value: 63 }] }),
    });
    expect(derivedValue(r, 'm_sum')).toBe(114);
    expect(derivedValue(r, 'm_mix')).toBe(215.25); // 114*2 - 51/4
    expect(derivedValue(r, 'm_deep')).toBe(109.75); // (215.25 + 114) / 3
    expect(derivedValue(r, 'sum_avg')).toBe(111); // (108+114)/2
    expect(derivedValue(r, 'cpu_avg3')).toBe(49.5);
    expect(derivedValue(r, 'cpu_max3')).toBe(51);
    expect(derivedValue(r, 'cpu_min3')).toBe(48);
    expect(derivedValue(r, 'cpu_last3')).toBe(51);

    // 第 3 拍：cpu=54, memory=66
    r = await api(server, '/test/ingest', {
      method: 'POST',
      body: JSON.stringify({ points: [{ sourceId: 'cpu', ts: T + 2000, value: 54 }, { sourceId: 'memory', ts: T + 2000, value: 66 }] }),
    });
    expect(derivedValue(r, 'm_sum')).toBe(120);
    expect(derivedValue(r, 'm_mix')).toBe(226.5); // 120*2 - 54/4
    expect(derivedValue(r, 'm_deep')).toBe(115.5); // (226.5 + 120) / 3
    expect(derivedValue(r, 'sum_avg')).toBe(114); // (108+114+120)/3，窗口聚合可以挂在派生指标上
    expect(derivedValue(r, 'cpu_avg3')).toBe(51);
    expect(derivedValue(r, 'cpu_max3')).toBe(54);
    expect(derivedValue(r, 'cpu_min3')).toBe(48);
    expect(derivedValue(r, 'cpu_last3')).toBe(54);
  });

  it('滚动窗口随时间滑动：窗口边界 (ts-窗口, ts] 左开右闭', async () => {
    const T2 = T + 10_000; // 与前面的点隔开，3 秒窗口互不影响
    const values = [10, 20, 30, 40, 50];
    const expected = [
      { avg: 10, max: 10, min: 10, last: 10 }, // [10]
      { avg: 15, max: 20, min: 10, last: 20 }, // [10,20]
      { avg: 20, max: 30, min: 10, last: 30 }, // [10,20,30]
      { avg: 30, max: 40, min: 20, last: 40 }, // (T2, T2+3000]：10 滑出窗口
      { avg: 40, max: 50, min: 30, last: 50 }, // [30,40,50]
    ];
    for (let i = 0; i < values.length; i++) {
      const r = await api(server, '/test/ingest', {
        method: 'POST',
        body: JSON.stringify({ points: [{ sourceId: 'cpu', ts: T2 + i * 1000, value: values[i] }] }),
      });
      expect(derivedValue(r, 'cpu_avg3')).toBe(expected[i].avg);
      expect(derivedValue(r, 'cpu_max3')).toBe(expected[i].max);
      expect(derivedValue(r, 'cpu_min3')).toBe(expected[i].min);
      expect(derivedValue(r, 'cpu_last3')).toBe(expected[i].last);
    }
  });

  it('派生点与原始指标一样逐点落档：历史回放取到的就是实时算出的值', async () => {
    const q = await api(server, `/history?from=${T - 1}&to=${T + 2001}&sources=m_deep,sum_avg`);
    expect(q.status).toBe(200);
    expect(q.body.series.m_deep.points).toEqual([
      { sourceId: 'm_deep', ts: T, value: 104 },
      { sourceId: 'm_deep', ts: T + 1000, value: 109.75 },
      { sourceId: 'm_deep', ts: T + 2000, value: 115.5 },
    ]);
    expect(q.body.series.sum_avg.points.map((p: any) => p.value)).toEqual([108, 111, 114]);

    // 派生指标出现在数据源清单里，与原始指标同等待遇
    const sources = await api(server, '/sources');
    const deep = sources.body.find((s: any) => s.def.id === 'm_deep');
    expect(deep.def.kind).toBe('derived');
    // 上一组注入只有 cpu（缺 memory），按约定 m_deep 不产点并标记依赖缺失；
    // 其最近产出时间仍停在最后一次成功计算的拍，绝不拿旧值凑数
    expect(deep.status).toBe('error');
    expect(deep.lastError).toContain('m_sum'); // 直接依赖被点名（根因 memory 体现在 m_sum 自身状态上）
    expect(deep.lastPointTs).toBe(T + 2000);
    const sum = sources.body.find((s: any) => s.def.id === 'm_sum');
    expect(sum.lastError).toContain('memory');
  });
});

describe('派生指标：循环依赖保存即拒（行为二）', () => {
  let server: TestServer;
  const T = 1_760_000_100_000;

  beforeAll(async () => {
    server = await startServer({ tickMs: 100000 });
    // 正常的三层链：chain_c -> chain_b -> chain_a -> cpu
    for (const def of [
      { id: 'chain_a', name: '链A', expression: 'cpu + 1' },
      { id: 'chain_b', name: '链B', expression: 'chain_a + 1' },
      { id: 'chain_c', name: '链C', expression: 'chain_b + 1' },
    ]) {
      const r = await api(server, '/derived', { method: 'POST', body: JSON.stringify(def) });
      expect(r.status).toBe(201);
    }
  });
  afterAll(async () => {
    await server.stop();
  });

  it('修改定义造成长链回环：被拒绝并指出全部环节点', async () => {
    // chain_a 改引用 chain_c：chain_a -> chain_c -> chain_b -> chain_a 成环
    const r = await api(server, '/derived/chain_a', {
      method: 'PUT',
      body: JSON.stringify({ expression: 'chain_c + 1' }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('cycle_detected');
    expect(r.body.message).toContain('循环依赖');
    // 环上的三个指标都要被点出来
    expect(new Set(r.body.cycle)).toEqual(new Set(['chain_a', 'chain_b', 'chain_c']));
  });

  it('自引用（最短的环）：被拒绝', async () => {
    const r = await api(server, '/derived/chain_a', {
      method: 'PUT',
      body: JSON.stringify({ expression: 'chain_a * 2' }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('cycle_detected');
    expect(r.body.cycle).toEqual(['chain_a']);
  });

  it('新建时引用不存在的指标：被拒绝并指出是哪个', async () => {
    const r = await api(server, '/derived', {
      method: 'POST',
      body: JSON.stringify({ id: 'cyc_new', name: '新指标', expression: 'ghost_a + ghost_b' }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('unknown_reference');
    expect(new Set(r.body.refs)).toEqual(new Set(['ghost_a', 'ghost_b']));
  });

  it('两节点互相引用成环：第二个定义保存时被拒', async () => {
    const a = await api(server, '/derived', { method: 'POST', body: JSON.stringify({ id: 'pair_a', name: '甲', expression: 'cpu + 1' }) });
    expect(a.status).toBe(201);
    const b = await api(server, '/derived', { method: 'POST', body: JSON.stringify({ id: 'pair_b', name: '乙', expression: 'pair_a + 1' }) });
    expect(b.status).toBe(201);
    // 把 pair_a 改成引用 pair_b：pair_a <-> pair_b 成环
    const r = await api(server, '/derived/pair_a', {
      method: 'PUT',
      body: JSON.stringify({ expression: 'pair_b + 1' }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('cycle_detected');
    expect(new Set(r.body.cycle)).toEqual(new Set(['pair_a', 'pair_b']));
  });

  it('被拒绝的修改没有生效，已有定义照常按依赖顺序计算', async () => {
    // 定义仍是原来的表达式
    const list = await api(server, '/derived');
    expect(list.body.find((d: any) => d.id === 'chain_a').expression).toBe('cpu + 1');
    expect(list.body.find((d: any) => d.id === 'pair_a').expression).toBe('cpu + 1');

    // 注入 cpu=10：链式三层与 pair 都正常产出
    const r = await api(server, '/test/ingest', {
      method: 'POST',
      body: JSON.stringify({ points: [{ sourceId: 'cpu', ts: T, value: 10 }] }),
    });
    expect(derivedValue(r, 'chain_a')).toBe(11);
    expect(derivedValue(r, 'chain_b')).toBe(12);
    expect(derivedValue(r, 'chain_c')).toBe(13);
    expect(derivedValue(r, 'pair_a')).toBe(11);
    expect(derivedValue(r, 'pair_b')).toBe(12);
  });
});

describe('派生指标：定义校验与删除语义', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer({ tickMs: 100000 });
  });
  afterAll(async () => {
    await server.stop();
  });

  it('语法错误：400 并给出中文说明', async () => {
    for (const expression of ['cpu +* 2', '(cpu + 1', 'avg(cpu, 5x)', 'cpu .. 2', '']) {
      const r = await api(server, '/derived', { method: 'POST', body: JSON.stringify({ name: '坏式子', expression }) });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid_expression');
      expect(typeof r.body.message).toBe('string');
    }
  });

  it('id 规范：与内置指标重名 / 保留字 / 非法字符 / 重复都被拒', async () => {
    const cases = [
      { id: 'cpu', status: 400 }, // 与内置采集指标重名
      { id: 'avg', status: 400 }, // 聚合函数保留字
      { id: '1abc', status: 400 }, // 数字开头
      { id: 'has-dash', status: 400 }, // 含非法字符
    ];
    for (const c of cases) {
      const r = await api(server, '/derived', { method: 'POST', body: JSON.stringify({ id: c.id, name: 'x', expression: 'cpu + 1' }) });
      expect(r.status).toBe(c.status);
    }
    const ok = await api(server, '/derived', { method: 'POST', body: JSON.stringify({ id: 'uniq', name: 'x', expression: 'cpu + 1' }) });
    expect(ok.status).toBe(201);
    const dup = await api(server, '/derived', { method: 'POST', body: JSON.stringify({ id: 'uniq', name: 'x', expression: 'cpu + 2' }) });
    expect(dup.status).toBe(409);
  });

  it('参数校验：小数位、满量程、名称', async () => {
    const badDecimals = await api(server, '/derived', { method: 'POST', body: JSON.stringify({ name: 'x', decimals: 7, expression: 'cpu' }) });
    expect(badDecimals.status).toBe(400);
    const badMax = await api(server, '/derived', { method: 'POST', body: JSON.stringify({ name: 'x', max: -1, expression: 'cpu' }) });
    expect(badMax.status).toBe(400);
    const noName = await api(server, '/derived', { method: 'POST', body: JSON.stringify({ expression: 'cpu' }) });
    expect(noName.status).toBe(400);
  });

  it('删除：被其它派生指标引用时拒绝；删除后级联清理告警规则', async () => {
    await api(server, '/derived', { method: 'POST', body: JSON.stringify({ id: 'del_base', name: '被依赖', expression: 'cpu + 1' }) });
    await api(server, '/derived', { method: 'POST', body: JSON.stringify({ id: 'del_top', name: '依赖别人', expression: 'del_base + 1' }) });

    // del_base 仍被 del_top 引用：拒删并说明是谁在引用
    const blocked = await api(server, '/derived/del_base', { method: 'DELETE' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('has_dependents');
    expect(blocked.body.dependents).toEqual(['del_top']);

    // 给 del_top 设一条告警规则，删除 del_top 时规则被级联清理
    const rule = await api(server, '/alerts/rules', {
      method: 'POST',
      body: JSON.stringify({ sourceId: 'del_top', level: 'warning', operator: '>', threshold: 1000 }),
    });
    expect(rule.status).toBe(201);

    const gone = await api(server, '/derived/del_top', { method: 'DELETE' });
    expect(gone.status).toBe(200);
    expect(gone.body.removedRules).toEqual([rule.body.id]);
    expect((await api(server, '/alerts/rules')).body.some((r: any) => r.id === rule.body.id)).toBe(false);
    expect((await api(server, '/sources')).body.some((s: any) => s.def.id === 'del_top')).toBe(false);
    // 历史接口里它也不再是已知数据源
    const hist = await api(server, '/history?from=0&to=1&sources=del_top');
    expect(hist.status).toBe(400);

    // 现在 del_base 没有被引用了，可以删
    const freed = await api(server, '/derived/del_base', { method: 'DELETE' });
    expect(freed.status).toBe(200);
  });
});

describe('派生指标：定义落盘，重启后仍在', () => {
  it('重启同一数据目录：定义、历史点都在，且继续按定义计算', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-dash-derived-'));
    const T = 1_760_000_200_000;
    let server = await startServer({ tickMs: 100000, dataDir });
    try {
      const created = await api(server, '/derived', {
        method: 'POST',
        body: JSON.stringify({ id: 'persisted', name: '双倍CPU', unit: '%', decimals: 1, expression: 'cpu * 2' }),
      });
      expect(created.status).toBe(201);
      const r = await api(server, '/test/ingest', {
        method: 'POST',
        body: JSON.stringify({ points: [{ sourceId: 'cpu', ts: T, value: 21 }] }),
      });
      expect(derivedValue(r, 'persisted')).toBe(42);

      // 定义确实写进了容器数据目录的 config.json
      const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
      expect(onDisk.derived.some((d: any) => d.id === 'persisted' && d.expression === 'cpu * 2')).toBe(true);
    } finally {
      await server.stop();
    }

    // 同一数据目录重启：定义与历史都还在
    server = await startServer({ tickMs: 100000, dataDir });
    try {
      const list = await api(server, '/derived');
      const def = list.body.find((d: any) => d.id === 'persisted');
      expect(def).toBeTruthy();
      expect(def.expression).toBe('cpu * 2');

      const sources = await api(server, '/sources');
      expect(sources.body.some((s: any) => s.def.id === 'persisted' && s.def.kind === 'derived')).toBe(true);

      // 重启前算出的历史点原样保留（回放一致性）
      const hist = await api(server, `/history?from=${T - 1}&to=${T + 1}&sources=persisted`);
      expect(hist.body.series.persisted.points).toEqual([{ sourceId: 'persisted', ts: T, value: 42 }]);

      // 新拍继续按定义计算
      const r2 = await api(server, '/test/ingest', {
        method: 'POST',
        body: JSON.stringify({ points: [{ sourceId: 'cpu', ts: T + 1000, value: 22 }] }),
      });
      expect(derivedValue(r2, 'persisted')).toBe(44);
    } finally {
      await server.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
