/**
 * 钉死行为一：给定一组带多层依赖的派生指标定义，系统按依赖顺序算出的结果
 * 与手工按式子推算的结果逐值相等。
 *
 * 依赖结构（含多层、跨层引用原始与派生指标）：
 *   err_ratio = error_rate / 100                         （原始 error_rate 的比率形式）
 *   load      = (cpu + memory) / 2                       （两路原始指标的综合水位）
 *   req_user  = rps / online                             （每在线用户请求量）
 *   composite = load * (1 - err_ratio) + req_user * 2    （引用三个派生指标）
 * 每拍注入完全确定的原始点，逐拍断言四层取值。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, startServer, type TestServer } from './helpers/server';

const RAW = ['cpu', 'memory', 'network', 'rps', 'online', 'error_rate'];

async function createDerived(server: TestServer, body: Record<string, unknown>) {
  const r = await api(server, '/derived', { method: 'POST', body: JSON.stringify(body) });
  if (r.status !== 201) throw new Error(`创建派生指标失败: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

function round(v: number, d: number) {
  return Number(v.toFixed(d));
}

describe('派生指标：多层依赖按拓扑序计算', () => {
  let server: TestServer;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    server = await startServer({ tickMs: 100000 }); // 停止随机造数
    for (const id of RAW) {
      await api(server, `/sources/${id}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    }
    // 按依赖自底向上创建（先有被引用者），系统仍会自己理清拓扑顺序而非依赖提交顺序
    const errRatio = await createDerived(server, {
      name: '错误比率', unit: '', decimals: 4, max: 1,
      formula: 'error_rate / 100', description: '错误请求占比',
    });
    const load = await createDerived(server, {
      name: '综合水位', unit: '%', decimals: 2, max: 100,
      formula: '(cpu + memory) / 2', description: '内存和CPU综合',
    });
    const reqUser = await createDerived(server, {
      name: '人均请求量', unit: 'req', decimals: 4, max: 100,
      formula: 'rps / online', description: '每在线用户摊到的请求',
    });
    ids.err_ratio = errRatio.def.id;
    ids.load = load.def.id;
    ids.req_user = reqUser.def.id;
    // 顶层指标引用前面三个派生指标的真实 id（多层依赖：派生引用派生）
    const composite = await createDerived(server, {
      name: '综合健康分', unit: '分', decimals: 3, max: 200,
      formula: `${ids.load} * (1 - ${ids.err_ratio}) + ${ids.req_user} * 2`,
      description: '跨三层派生',
    });
    ids.composite = composite.def.id;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('定义列表包含四路派生指标且依赖关系被正确解析', async () => {
    const list = (await api(server, '/derived')).body;
    expect(list).toHaveLength(4);
    const byId = Object.fromEntries(list.map((d: any) => [d.def.id, d]));
    expect(byId[ids.load].dependsOn.sort()).toEqual(['cpu', 'memory']);
    expect(byId[ids.req_user].dependsOn).toEqual(['rps', 'online']);
    expect(byId[ids.err_ratio].dependsOn).toEqual(['error_rate']);
    expect(byId[ids.composite].dependsOn.sort()).toEqual([ids.err_ratio, ids.load, ids.req_user].sort());
    // 全部处于正常态（尚未喂点时不会是 error 之外的脏状态）
    for (const d of list) expect(d.broken).toBe(false);
  });

  const cases = [
    { cpu: 40, memory: 60, rps: 1000, online: 200, error_rate: 5 },
    { cpu: 80, memory: 90, rps: 1600, online: 400, error_rate: 0 },
    { cpu: 10, memory: 30, rps: 100, online: 50, error_rate: 10 },
    { cpu: 55.5, memory: 64.5, rps: 1234, online: 56, error_rate: 2.5 },
  ];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    it(`第 ${i + 1} 拍：四层结果与手工推算逐值相等`, async () => {
      const ts = 1_700_000_000_000 + i * 1000;
      const points = [
        { sourceId: 'cpu', ts, value: c.cpu },
        { sourceId: 'memory', ts, value: c.memory },
        { sourceId: 'rps', ts, value: c.rps },
        { sourceId: 'online', ts, value: c.online },
        { sourceId: 'error_rate', ts, value: c.error_rate },
      ];
      const ingest = await api(server, '/test/ingest', { method: 'POST', body: JSON.stringify({ points }) });
      expect(ingest.status).toBe(201);

      // 手工按式子推算
      const errRatio = round(c.error_rate / 100, 4);
      const load = round((c.cpu + c.memory) / 2, 2);
      const reqUser = round(c.rps / c.online, 4);
      const composite = round(load * (1 - errRatio) + reqUser * 2, 3);

      const q = await api(server, `/history?from=${ts}&to=${ts}&sources=${ids.err_ratio},${ids.load},${ids.req_user},${ids.composite}`);
      const val = (key: string) => q.body.series[ids[key]].points.map((p: any) => p.value);

      expect(val('err_ratio')).toEqual([errRatio]);
      expect(val('load')).toEqual([load]);
      expect(val('req_user')).toEqual([reqUser]);
      expect(val('composite')).toEqual([composite]);

      // 派生点与原始点走同一条管线：注入接口也回传了派生点的告警评估（此处无规则，不报错即可）
      expect(ingest.body.ingested.map((p: any) => p.sourceId).sort()).toEqual(
        ['cpu', 'error_rate', 'memory', 'online', 'rps'].sort(),
      );
    });
  }

  it('派生点通过长连接随原始点一起被服务端主动推送', async () => {
    const { WebSocket: WS } = await import('ws');
    const ts = 1_700_000_009_000;
    const pushed = await new Promise<string[]>((resolve, reject) => {
      const ws = new WS(server.baseUrl.replace('http', 'ws') + '/api/ws');
      const seen: string[] = [];
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('等待含派生点的 metrics 帧超时'));
      }, 5000);
      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type !== 'metrics') return;
        for (const p of msg.points) {
          if (p.ts === ts) seen.push(p.sourceId);
        }
        if (seen.includes(ids.composite)) {
          clearTimeout(timer);
          ws.close();
          resolve(seen);
        }
      });
      ws.on('error', reject);
      ws.on('open', () => {
        // 连接就绪后再注入，避免建连竞态
        api(server, '/test/ingest', {
          method: 'POST',
          body: JSON.stringify({
            points: [
              { sourceId: 'cpu', ts, value: 20 },
              { sourceId: 'memory', ts, value: 40 },
              { sourceId: 'rps', ts, value: 500 },
              { sourceId: 'online', ts, value: 100 },
              { sourceId: 'error_rate', ts, value: 1 },
            ],
          }),
        }).catch(reject);
      });
    });
    // 同一批 metrics 帧里既有原始点也有派生点
    expect(pushed).toContain('cpu');
    expect(pushed).toContain(ids.load);
    expect(pushed).toContain(ids.composite);
  });

  it('运行期被零除只把这一路（及其下游）标异常，无关节点照常产出', async () => {
    const ts = 1_700_000_100_000;
    // online = 0 -> req_user 除零异常 -> composite 依赖它也异常；load / err_ratio 不受影响
    await api(server, '/test/ingest', {
      method: 'POST',
      body: JSON.stringify({
        points: [
          { sourceId: 'cpu', ts, value: 30 },
          { sourceId: 'memory', ts, value: 50 },
          { sourceId: 'rps', ts, value: 500 },
          { sourceId: 'online', ts, value: 0 },
          { sourceId: 'error_rate', ts, value: 2 },
        ],
      }),
    });
    const list = (await api(server, '/derived')).body;
    const byId = Object.fromEntries(list.map((d: any) => [d.def.id, d]));
    expect(byId[ids.req_user].status).toBe('error');
    expect(byId[ids.req_user].lastError).toContain('0');
    expect(byId[ids.composite].status).toBe('error');
    // 无关两路正常
    expect(byId[ids.load].status).toBe('ok');
    expect(byId[ids.err_ratio].status).toBe('ok');

    // 下一拍 online 恢复 -> 全部恢复正常，且不拿旧值
    const ts2 = ts + 1000;
    await api(server, '/test/ingest', {
      method: 'POST',
      body: JSON.stringify({
        points: [
          { sourceId: 'cpu', ts: ts2, value: 30 },
          { sourceId: 'memory', ts: ts2, value: 50 },
          { sourceId: 'rps', ts: ts2, value: 800 },
          { sourceId: 'online', ts: ts2, value: 200 },
          { sourceId: 'error_rate', ts: ts2, value: 2 },
        ],
      }),
    });
    const list2 = (await api(server, '/derived')).body;
    const byId2 = Object.fromEntries(list2.map((d: any) => [d.def.id, d]));
    expect(byId2[ids.req_user].status).toBe('ok');
    expect(byId2[ids.composite].status).toBe('ok');
    const q = await api(server, `/history?from=${ts2}&to=${ts2}&sources=${ids.req_user}`);
    expect(q.body.series[ids.req_user].points.map((p: any) => p.value)).toEqual([4]);
  });
});
