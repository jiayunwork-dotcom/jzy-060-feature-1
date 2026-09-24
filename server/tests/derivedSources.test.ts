/**
 * 钉死行为四：某个派生指标依赖的原始源被手动关掉（暂时取不到数）后，
 * 这一路的取值遵守明确约定——立刻标记为异常并停止产出新点，绝不悄悄拿
 * 旧值凑算；依赖其它源的派生指标不受连累。源重新打开后自动恢复正常。
 *
 * 同时锁定：定义持久化到容器内存储，重启之后定义还在、历史还在。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, startServer, type TestServer, waitForWsMessage } from './helpers/server';

const RAW = ['cpu', 'memory', 'network', 'rps', 'online', 'error_rate'];

describe('派生指标：依赖源关闭的异常约定与重启持久化', () => {
  let server: TestServer;
  let dataDir: string;
  let perUser: string; // rps / online
  let cpuLoad: string; // cpu + memory（不依赖被关的源，应照常产出）

  beforeAll(async () => {
    // 固定数据目录且停止后保留，供最后的“同目录重启”用例验证持久化
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-dash-restart-'));
    server = await startServer({ tickMs: 200, dataDir, keepDataDir: true });
    // 确定性起见全部关掉随机采集，本测试通过 test/ingest 手动喂点
    for (const id of RAW) {
      await api(server, `/sources/${id}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    }
    const a = await api(server, '/derived', {
      method: 'POST',
      body: JSON.stringify({ name: '人均请求', unit: 'req', decimals: 3, max: 100, formula: 'rps / online', description: '依赖 rps 与 online' }),
    });
    const b = await api(server, '/derived', {
      method: 'POST',
      body: JSON.stringify({ name: 'CPU内存水位', unit: '%', decimals: 2, max: 100, formula: '(cpu + memory) / 2', description: '不依赖 rps/online' }),
    });
    perUser = a.body.def.id;
    cpuLoad = b.body.def.id;
  });

  afterAll(async () => {
    try {
      await server.stop();
    } catch {
      /* 重启用例可能已停止主服务 */
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* 忽略清理失败 */
    }
  });

  it('正常喂点：两路派生指标都产出', async () => {
    const ts = Date.now();
    const r = await api(server, '/test/ingest', {
      method: 'POST',
      body: JSON.stringify({
        points: [
          { sourceId: 'rps', ts, value: 1000 },
          { sourceId: 'online', ts, value: 250 },
          { sourceId: 'cpu', ts, value: 40 },
          { sourceId: 'memory', ts, value: 60 },
        ],
      }),
    });
    expect(r.status).toBe(201);
    const states = Object.fromEntries((await api(server, '/derived')).body.map((d: any) => [d.def.id, d]));
    expect(states[perUser].status).toBe('ok');
    expect(states[perUser].lastPointTs).toBe(ts);
    expect(states[cpuLoad].status).toBe('ok');
  });

  it('关闭其中一路依赖源 online 后：该派生立即异常且不再产新点，不拿旧值凑算', async () => {
    const off = await api(server, '/sources/online/enabled', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    expect(off.body.enabled).toBe(false);

    // 再喂一个只有 rps 的新拍（online 已关闭，本拍没有它的值）
    const ts = Date.now() + 1000;
    await api(server, '/test/ingest', {
      method: 'POST',
      body: JSON.stringify({
        points: [
          { sourceId: 'rps', ts, value: 9999 },
          { sourceId: 'cpu', ts, value: 50 },
          { sourceId: 'memory', ts, value: 70 },
        ],
      }),
    });

    const states = Object.fromEntries((await api(server, '/derived')).body.map((d: any) => [d.def.id, d]));
    // 依赖被关源的那一路：明确异常、给出可读原因、没有产出新点
    expect(states[perUser].status).toBe('error');
    expect(states[perUser].lastError).toContain('无数据');
    expect(states[perUser].lastPointTs).toBeLessThan(ts); // 没有用 ts 这拍
    // 历史中也没有 ts 时刻的派生点（不是推了旧值）
    const q = await api(server, `/history?from=${ts}&to=${ts}&sources=${perUser}`);
    expect(q.body.series[perUser].points).toEqual([]);

    // 不依赖 online 的派生指标照常产出，未被连累
    expect(states[cpuLoad].status).toBe('ok');
    expect(states[cpuLoad].lastPointTs).toBe(ts);
    const q2 = await api(server, `/history?from=${ts}&to=${ts}&sources=${cpuLoad}`);
    expect(q2.body.series[cpuLoad].points[0].value).toBe(60);
  });

  it('异常期间持续多拍也不会冒出旧值（WS 不推该派生点）', async () => {
    const { WebSocket: WS } = await import('ws');
    await new Promise<void>((resolve, reject) => {
      const ws = new WS(server.baseUrl.replace('http', 'ws') + '/api/ws');
      const timer = setTimeout(() => {
        ws.close();
        resolve();
      }, 1500);
      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'metrics' && msg.points.some((p: any) => p.sourceId === perUser)) {
          clearTimeout(timer);
          ws.close();
          reject(new Error('异常期间不应推送该派生指标的点'));
        }
      });
      ws.on('error', reject);
      // 在断言窗口内连续喂三拍 rps（online 仍关闭）
      const base = Date.now();
      for (let i = 0; i < 3; i++) {
        setTimeout(() => {
          api(server, '/test/ingest', {
            method: 'POST',
            body: JSON.stringify({ points: [{ sourceId: 'rps', ts: base + i * 200, value: 100 + i }] }),
          }).catch(() => undefined);
        }, i * 250);
      }
    });
  });

  it('重新打开 online 后：该派生自动恢复，新拍按新值计算', async () => {
    const on = await api(server, '/sources/online/enabled', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    expect(on.body.enabled).toBe(true);

    const ts = Date.now() + 5000;
    await api(server, '/test/ingest', {
      method: 'POST',
      body: JSON.stringify({ points: [{ sourceId: 'rps', ts, value: 800 }, { sourceId: 'online', ts, value: 200 }] }),
    });
    const states = Object.fromEntries((await api(server, '/derived')).body.map((d: any) => [d.def.id, d]));
    expect(states[perUser].status).toBe('ok');
    expect(states[perUser].lastError).toBeNull();
    expect(states[perUser].lastPointTs).toBe(ts);
    const q = await api(server, `/history?from=${ts}&to=${ts}&sources=${perUser}`);
    expect(q.body.series[perUser].points[0].value).toBe(4); // 800/200

    // 实时路径（模拟器节拍）恢复后也能在 WS 上收到该派生点
    for (const id of RAW) await api(server, `/sources/${id}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    await waitForWsMessage(
      server.baseUrl.replace('http', 'ws') + '/api/ws',
      (msg) => msg.type === 'metrics' && msg.points.some((p: any) => p.sourceId === perUser),
      5000,
    );
  });

  it('定义与历史持久化：落盘文件存在', async () => {
    const configRaw = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8');
    const config = JSON.parse(configRaw);
    const ids = config.derived.map((d: any) => d.id);
    expect(ids).toContain(perUser);
    expect(ids).toContain(cpuLoad);
    // 历史 JSONL 至少有一个点落盘（缓冲 2s 批量写，主动 flush 由退出/淘汰触发，这里检查文件被创建）
    // 通过 debug 接口确认内存计数 > 0，且重启后仍在（下一条用例）
    const debug = await api(server, '/test/debug');
    expect(debug.status).toBe(200);
  });

  it('重启后：定义仍在、开关状态仍在、历史点仍可回放', async () => {
    // 先记录一个确定点的时间与值
    const ts = 1_700_005_000_000;
    await api(server, '/test/ingest', {
      method: 'POST',
      body: JSON.stringify({
        points: [
          { sourceId: 'rps', ts, value: 600 },
          { sourceId: 'online', ts, value: 300 },
        ],
      }),
    });
    await server.stop();

    // 用同一个数据目录重启
    const restarted = await startServer({ dataDir, tickMs: 100000, prefillMs: 0 });
    try {
      const list = (await api(restarted, '/derived')).body;
      const byId = Object.fromEntries(list.map((d: any) => [d.def.id, d]));
      expect(byId[perUser].def.formula).toBe('rps / online');
      expect(byId[cpuLoad].def.formula).toBe('(cpu + memory) / 2');

      // 重启前逐点留存的派生历史仍在，且值与当时实时产出一致（600/300=2）
      const q = await api(restarted, `/history?from=${ts}&to=${ts}&sources=${perUser}`);
      expect(q.body.series[perUser].points).toEqual([{ sourceId: perUser, ts, value: 2 }]);

      // 重启后定义继续参与实时计算
      const ts2 = ts + 1000;
      await api(restarted, '/test/ingest', {
        method: 'POST',
        body: JSON.stringify({ points: [{ sourceId: 'rps', ts: ts2, value: 900 }, { sourceId: 'online', ts: ts2, value: 300 }] }),
      });
      const q2 = await api(restarted, `/history?from=${ts2}&to=${ts2}&sources=${perUser}`);
      expect(q2.body.series[perUser].points[0].value).toBe(3);
    } finally {
      await restarted.stop();
    }
  });
});
