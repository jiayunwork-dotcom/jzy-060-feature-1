/**
 * 派生指标（算出来的指标）管理路由：增删改查。
 * 定义校验（语法/未知引用/循环依赖）在引擎内完成，这里只做 HTTP 映射；
 * 任何定义变化都会广播新快照，让各页面立即看到最新的数据源清单。
 */
import type { FastifyInstance } from 'fastify';
import type { Runtime } from '../runtime';
import type { DerivedInput } from '../derived/engine';

interface DerivedIdParam {
  id: string;
}

export default async function derivedRoutes(app: FastifyInstance, rt: Runtime): Promise<void> {
  // 列表：定义 + 各自引用到的指标（便于前端展示依赖关系）
  app.get('/derived', async () =>
    rt.derived.list().map((def) => ({
      ...def,
      refs: rt.derived.getRefs(def.id),
      dependents: rt.derived.dependentsOf(def.id),
      enabled: rt.derived.isEnabled(def.id),
    })),
  );

  app.post<{ Body: DerivedInput }>('/derived', async (req, reply) => {
    const result = rt.derived.create(req.body ?? {});
    if (!result.ok) return reply.code(result.status).send(result);
    rt.hub.broadcast(rt.buildSnapshot());
    return reply.code(201).send(result.value);
  });

  app.put<{ Params: DerivedIdParam; Body: DerivedInput }>('/derived/:id', async (req, reply) => {
    const result = rt.derived.update(req.params.id, req.body ?? {});
    if (!result.ok) return reply.code(result.status).send(result);
    rt.hub.broadcast(rt.buildSnapshot());
    return result.value;
  });

  // 删除：级联删除绑定在它上面的告警规则（激活中的先解除），并清理其历史序列
  app.delete<{ Params: DerivedIdParam }>('/derived/:id', async (req, reply) => {
    const id = req.params.id;
    const result = rt.derived.delete(id);
    if (!result.ok) return reply.code(result.status).send(result);

    const removedRules: string[] = [];
    for (const rule of rt.configStore.getRules()) {
      if (rule.sourceId !== id) continue;
      rt.configStore.deleteRule(rule.id);
      removedRules.push(rule.id);
      const gone = rt.alerts.deactivate(rule.id);
      if (gone) rt.emitAlertEvents([gone]);
    }
    if (removedRules.length) rt.broadcastRules();
    rt.hub.broadcast(rt.buildSnapshot());
    return { ok: true, id, removedRules };
  });
}
