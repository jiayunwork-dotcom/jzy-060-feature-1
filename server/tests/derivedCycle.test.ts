/**
 * 钉死行为二：提交会成环的定义时，在保存那一刻即被拒绝，并清楚告知是哪几个
 * 指标绕成了环；已存在的正常定义不受任何影响、照常计算。覆盖自环、双元环、
 * 更长链环，以及“引用不存在的指标”“算式写错”两类定义期错误。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, startServer, type TestServer } from './helpers/server';

const RAW = ['cpu', 'memory', 'network', 'rps', 'online', 'error_rate'];

async function create(body: Record<string, unknown>) {
  return api(globalServer, '/derived', { method: 'POST', body: JSON.stringify(body) });
}

let globalServer: TestServer;

describe('派生指标：循环依赖在保存时被拒绝', () => {
  let server: TestServer;
  let idA: string;
  let idB: string;
  let idGood: string;

  beforeAll(async () => {
    server = await startServer({ tickMs: 100000 });
    globalServer = server;
    for (const id of RAW) {
      await api(server, `/sources/${id}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    }
    // 两个互不依赖的正常派生指标
    const a = await create({ name: '指标A', unit: '%', decimals: 2, max: 100, formula: 'cpu + 1' });
    const b = await create({ name: '指标B', unit: '%', decimals: 2, max: 100, formula: 'memory * 2' });
    const good = await create({ name: '正常指标', unit: '%', decimals: 2, max: 100, formula: 'rps - 1' });
    idA = a.body.def.id;
    idB = b.body.def.id;
    idGood = good.body.def.id;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('自引用（A -> A）被拒绝', async () => {
    const r = await api(server, `/derived/${idA}`, { method: 'PUT', body: JSON.stringify({ name: '指标A', unit: '%', decimals: 2, max: 100, formula: `${idA} + 1` }) });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('cyclic_dependency');
    expect(r.body.cycle).toContain(idA);
    expect(r.body.message).toContain('循环依赖');
  });

  it('双元环（A -> B 且 B -> A）被拒绝并报出 A、B', async () => {
    // 先把 A 改成引用 B（此时无环，成功）
    const ok = await api(server, `/derived/${idA}`, { method: 'PUT', body: JSON.stringify({ name: '指标A', unit: '%', decimals: 2, max: 100, formula: idB }) });
    expect(ok.status).toBe(200);
    // 再把 B 改成引用 A，构成 A->B->A，必须拒绝
    const r = await api(server, `/derived/${idB}`, { method: 'PUT', body: JSON.stringify({ name: '指标B', unit: '%', decimals: 2, max: 100, formula: `${idA} + ${idB}` }) });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('cyclic_dependency');
    expect(r.body.cycle.sort()).toEqual([idA, idB].sort());
  });

  it('更长链环（A->B->C->A）被拒绝并报出完整链路', async () => {
    // 当前 A=B；先恢复 A，再建 C，然后制造三环
    await api(server, `/derived/${idA}`, { method: 'PUT', body: JSON.stringify({ name: '指标A', unit: '%', decimals: 2, max: 100, formula: 'cpu' }) });
    const c = await create({ name: '指标C', unit: '%', decimals: 2, max: 100, formula: 'cpu' });
    const idC = c.body.def.id;
    await api(server, `/derived/${idA}`, { method: 'PUT', body: JSON.stringify({ name: '指标A', unit: '%', decimals: 2, max: 100, formula: idB }) });
    await api(server, `/derived/${idB}`, { method: 'PUT', body: JSON.stringify({ name: '指标B', unit: '%', decimals: 2, max: 100, formula: idC }) });
    // 最后一步 C -> A 收口成环
    const r = await api(server, `/derived/${idC}`, { method: 'PUT', body: JSON.stringify({ name: '指标C', unit: '%', decimals: 2, max: 100, formula: idA }) });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('cyclic_dependency');
    expect(r.body.cycle.sort()).toEqual([idA, idB, idC].sort());
    // 错误信息里能看到全部三个指标名
    expect(r.body.message).toContain('指标A');
    expect(r.body.message).toContain('指标B');
    expect(r.body.message).toContain('指标C');
  });

  it('引用不存在的指标在定义阶段被拒绝', async () => {
    const r = await create({ name: '幽灵', unit: '%', decimals: 2, max: 100, formula: 'no_such_metric * 2' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_formula');
    expect(r.body.message).toContain('no_such_metric');
  });

  it('算式写错（括号不配、非法字符、未知函数）在定义阶段被拒绝', async () => {
    const bad = ['(cpu + memory', 'cpu + #', 'avg(cpu, 5m', 'foobar(cpu, 1m)', 'cpu +', 'avg(5, 1m)'];
    for (const formula of bad) {
      const r = await create({ name: '坏式子', unit: '%', decimals: 2, max: 100, formula });
      expect(r.status, `式子应被拒绝: ${formula}`).toBe(400);
      expect(r.body.error).toBe('invalid_formula');
    }
  });

  it('被拒绝后：定义数量不增加，已有正常定义照常计算', async () => {
    const before = (await api(server, '/derived')).body;
    const countBefore = before.length;

    // 新建一个合法指标，再把它改成自环：修改必须被拒绝，定义仍是原算式
    const tmp = await create({ name: '临时', unit: '%', decimals: 2, max: 100, formula: 'memory' });
    expect(tmp.status).toBe(201);
    const tmpId = tmp.body.def.id;
    const self = await api(server, `/derived/${tmpId}`, { method: 'PUT', body: JSON.stringify({ name: '临时', unit: '%', decimals: 2, max: 100, formula: tmpId }) });
    expect(self.status).toBe(400);
    expect(self.body.error).toBe('cyclic_dependency');

    const after = (await api(server, '/derived')).body;
    // 只多了临时这一个（自环修改被拒，它仍是 memory）
    expect(after.length).toBe(countBefore + 1);
    const tmpState = after.find((d: any) => d.def.id === tmpId);
    expect(tmpState.def.formula).toBe('memory');
    expect(tmpState.broken).toBe(false);

    // 长环用例临时改过 A/B/C 的式子（但收口成环的那次提交被拒）。
    // 这里把三者重置为无环的已知算式，再断言它们照常计算。
    const idC = before.find((d: any) => d.def.name === '指标C').def.id;
    const put = (sid: string, formula: string) =>
      api(server, `/derived/${sid}`, { method: 'PUT', body: JSON.stringify({ name: { [idA]: '指标A', [idB]: '指标B', [idC]: '指标C' }[sid] ?? 'x', unit: '%', decimals: 2, max: 100, formula }) });
    await put(idB, 'memory * 2');
    await put(idA, idB);
    await put(idC, 'cpu');

    // 喂一个点：所有正常定义（含刚建的临时指标）照常产出，没有任何东西被环拖死
    const ts = 1_700_000_000_000;
    await api(server, '/test/ingest', {
      method: 'POST',
      body: JSON.stringify({
        points: [
          { sourceId: 'cpu', ts, value: 42 },
          { sourceId: 'memory', ts, value: 88 },
          { sourceId: 'rps', ts, value: 700 },
        ],
      }),
    });
    const states = (await api(server, '/derived')).body;
    const byName = Object.fromEntries(states.map((d: any) => [d.def.name, d]));
    for (const name of ['指标A', '指标B', '指标C', '正常指标', '临时']) {
      expect(byName[name].broken, `${name} 不应是 broken`).toBe(false);
      expect(byName[name].status, `${name} 应正常产出`).toBe('ok');
      expect(byName[name].lastPointTs).toBe(ts);
    }
    // 具体值：B=2*memory=176，A=B=176，C=cpu=42，正常=rps-1=699，临时=memory=88
    const valAt = async (sid: string) => {
      const r = await api(server, `/history?from=${ts}&to=${ts}&sources=${sid}`);
      return r.body.series[sid].points[0]?.value;
    };
    expect(await valAt(byName['指标B'].def.id)).toBe(176);
    expect(await valAt(byName['指标A'].def.id)).toBe(176);
    expect(await valAt(byName['指标C'].def.id)).toBe(42);
    expect(await valAt(byName['正常指标'].def.id)).toBe(699);
    expect(await valAt(byName['临时'].def.id)).toBe(88);
  });
});
