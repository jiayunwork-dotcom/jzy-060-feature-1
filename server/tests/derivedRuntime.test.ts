/**
 * 派生指标 · 行为四：
 * 依赖的原始源被手动关闭后，派生指标这一路不再产点、状态置为异常并说明原因
 * （绝不拿旧值凑数）；重新打开后自动恢复正常。
 * 同时锁定运行时异常的隔离性：除以零只把本路标为异常，不连累其它指标。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, sleep, startServer, type TestServer } from './helpers/server';

/** 轮询直到条件满足或超时 */
async function pollUntil(fn: () => Promise<boolean>, timeoutMs = 6000, stepMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error('轮询等待超时');
    await sleep(stepMs);
  }
}

async function sourceState(server: TestServer, id: string): Promise<any> {
  const r = await api(server, `/sources/${id}`);
  return r.body;
}

describe('派生指标：依赖源关闭时的取值约定（行为四）', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer({ tickMs: 200 });
    for (const def of [
      { id: 'cpu2x', name: 'CPU 双倍', expression: 'cpu * 2' },
      { id: 'mem2x', name: '内存双倍', expression: 'memory * 2' },
    ]) {
      const r = await api(server, '/derived', { method: 'POST', body: JSON.stringify(def) });
      expect(r.status).toBe(201);
    }
    // 等两路都正常产出（实时节拍驱动）
    await pollUntil(async () => {
      const a = await sourceState(server, 'cpu2x');
      const b = await sourceState(server, 'mem2x');
      return a.lastPointTs !== null && b.lastPointTs !== null;
    });
  });
  afterAll(async () => {
    await server.stop();
  });

  it('关闭依赖的原始源：派生指标停止产点、状态异常并说明原因，其它派生指标不受影响', async () => {
    const before = await sourceState(server, 'cpu2x');
    expect(before.status).toBe('ok');
    const frozenTs = before.lastPointTs;

    const off = await api(server, '/sources/cpu/enabled', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    expect(off.body.enabled).toBe(false);

    // 等若干个节拍，让“关闭”生效到计算管线
    await sleep(1500);

    const during = await sourceState(server, 'cpu2x');
    // 约定：不产新点（最近点时间冻结），状态置异常并点名是哪个依赖断了
    expect(during.status).toBe('error');
    expect(during.lastError).toContain('cpu');
    expect(during.lastPointTs).toBe(frozenTs);

    // 历史里也没有关闭之后的新点（不拿旧值凑数）
    const hist = await api(server, `/history?from=${frozenTs + 1}&to=${Date.now() + 60_000}&sources=cpu2x`);
    expect(hist.body.series.cpu2x.points).toHaveLength(0);

    // 不依赖 cpu 的 mem2x 照常产出
    const mem = await sourceState(server, 'mem2x');
    expect(mem.status).toBe('ok');
    expect(mem.lastPointTs).toBeGreaterThan(frozenTs);
  });

  it('重新打开依赖源：派生指标自动恢复产点与正常状态', async () => {
    const frozenTs = (await sourceState(server, 'cpu2x')).lastPointTs;
    const on = await api(server, '/sources/cpu/enabled', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    expect(on.body.enabled).toBe(true);

    await pollUntil(async () => {
      const s = await sourceState(server, 'cpu2x');
      return s.status === 'ok' && s.lastPointTs > frozenTs;
    });
    // 恢复后产出的值仍然是定义算出来的（cpu 当前值 * 2），与实时值一致
    const cpu = await sourceState(server, 'cpu');
    const cpu2x = await sourceState(server, 'cpu2x');
    const hist = await api(server, `/history?from=${cpu2x.lastPointTs}&to=${cpu2x.lastPointTs}&sources=cpu2x,cpu`);
    const cpuPoint = hist.body.series.cpu.points.at(-1);
    const derivedPoint = hist.body.series.cpu2x.points.at(-1);
    expect(derivedPoint.ts).toBe(cpuPoint.ts);
    expect(derivedPoint.value).toBeCloseTo(cpuPoint.value * 2, 1);
    expect(cpu.lastPointTs).toBeGreaterThan(frozenTs);
  });
});

describe('派生指标：运行时异常隔离（除以零不连累其它指标）', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer({ tickMs: 200 });
    for (const def of [
      { id: 'divzero', name: '除零', expression: 'cpu / (cpu - cpu)' },
      { id: 'healthy', name: '健康参照', expression: 'cpu + 1' },
    ]) {
      const r = await api(server, '/derived', { method: 'POST', body: JSON.stringify(def) });
      expect(r.status).toBe(201);
    }
  });
  afterAll(async () => {
    await server.stop();
  });

  it('除以零：本路标异常、不产点；其它指标照常', async () => {
    // 等 healthy 正常产出
    await pollUntil(async () => (await sourceState(server, 'healthy')).lastPointTs !== null);
    // divzero 在下一拍就应被标为异常
    await pollUntil(async () => (await sourceState(server, 'divzero')).status === 'error');

    const dz = await sourceState(server, 'divzero');
    expect(dz.lastError).toContain('除数为零');
    expect(dz.lastPointTs).toBe(null); // 从未产出过点

    // 历史里 divzero 一路为空，而 healthy 持续增长
    const hist = await api(server, `/history?from=0&to=${Date.now() + 60_000}&sources=divzero,healthy`);
    expect(hist.body.series.divzero.points).toHaveLength(0);
    expect(hist.body.series.healthy.points.length).toBeGreaterThan(0);

    const before = (await sourceState(server, 'healthy')).lastPointTs;
    await sleep(700);
    const after = (await sourceState(server, 'healthy')).lastPointTs;
    expect(after).toBeGreaterThan(before);
  });
});
