/**
 * 派生（算出来的）指标路由：定义的增删改查。
 * 所有“成环 / 引用不存在 / 算式写错”都在保存这一刻挡下，绝不混进运行时；
 * 定义落到 ConfigStore（data/config.json），重启后仍在。
 */
import type { FastifyInstance } from 'fastify';
import type { Runtime } from '../runtime';

interface DerivedBody {
  id?: unknown;
  name?: unknown;
  unit?: unknown;
  decimals?: unknown;
  max?: unknown;
  formula?: unknown;
  description?: unknown;
}

interface DerivedIdParam {
  id: string;
}

interface ValidInput {
  name: string;
  unit: string;
  decimals: number;
  max: number;
  formula: string;
  description: string;
}

function validateInput(body: DerivedBody): { ok: true; value: ValidInput } | { ok: false; message: string } {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { ok: false, message: 'name 必填' };
  if (name.length > 40) return { ok: false, message: 'name 最长 40 个字符' };

  const formula = typeof body.formula === 'string' ? body.formula.trim() : '';
  if (!formula) return { ok: false, message: 'formula 必填' };
  if (formula.length > 500) return { ok: false, message: 'formula 最长 500 个字符' };

  const unit = typeof body.unit === 'string' ? body.unit.trim().slice(0, 16) : '';
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 200) : '';

  const decimals = body.decimals === undefined || body.decimals === null ? 2 : Number(body.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) {
    return { ok: false, message: 'decimals 必须是 0~8 的整数' };
  }
  const max = body.max === undefined || body.max === null || body.max === '' ? 100 : Number(body.max);
  if (!Number.isFinite(max) || max <= 0) return { ok: false, message: 'max 必须是正数' };

  return { ok: true, value: { name, unit, decimals, max, formula, description } };
}

export default async function derivedRoutes(app: FastifyInstance, rt: Runtime): Promise<void> {
  app.get('/derived', async () => rt.derived.list());

  app.get<{ Params: DerivedIdParam }>('/derived/:id', async (req, reply) => {
    const state = rt.derived.getState(req.params.id);
    if (!state) return reply.code(404).send({ error: 'derived_not_found' });
    return state;
  });

  app.post<{ Body: DerivedBody }>('/derived', async (req, reply) => {
    const v = validateInput(req.body ?? {});
    if (!v.ok) return reply.code(400).send({ error: 'invalid_derived', message: v.message });

    const check = rt.derived.validateSave(null, v.value.formula);
    if (!check.ok) return reply.code(check.status).send({ error: check.code, message: check.message, cycle: check.cycle });

    const def = rt.configStore.addDerived(v.value);
    rt.history.register(def.id);
    rt.derived.reload();
    // 对已有历史区间补算一遍，让新建指标立刻有走势/回放，且与当时实时产出保持一致
    rt.derived.backfill(Date.now(), rt.config.prefillMs, rt.config.tickMs);
    rt.history.flush();
    rt.broadcastDerived();
    rt.hub.broadcast(rt.buildSnapshot());
    rt.resyncAlerts();
    return reply.code(201).send(rt.derived.getState(def.id));
  });

  app.put<{ Params: DerivedIdParam; Body: DerivedBody }>('/derived/:id', async (req, reply) => {
    const existing = rt.configStore.getDerivedDef(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'derived_not_found' });

    const merged: DerivedBody = {
      name: existing.name,
      unit: existing.unit,
      decimals: existing.decimals,
      max: existing.max,
      formula: existing.formula,
      description: existing.description,
      ...(req.body ?? {}),
    };
    const v = validateInput(merged);
    if (!v.ok) return reply.code(400).send({ error: 'invalid_derived', message: v.message });

    const check = rt.derived.validateSave(existing.id, v.value.formula);
    if (!check.ok) return reply.code(check.status).send({ error: check.code, message: check.message, cycle: check.cycle });

    const formulaChanged = existing.formula !== v.value.formula;
    const def = rt.configStore.updateDerived(existing.id, v.value)!;
    rt.derived.reload();
    // 算式变了：旧值不再代表新定义，立即让绑定它的激活告警解除，等新拍重新判定
    if (formulaChanged) {
      const gone = rt.alerts.invalidateSource(def.id);
      if (gone.length) rt.emitAlertEvents(gone);
    }
    // 旧历史点是“当时按旧定义实时产出”的结果，冻结保留，保证回放与当初一致；
    // 新定义从此刻起的新拍生效。仅对尚无点的区间做幂等回填。
    rt.derived.backfill(Date.now(), rt.config.prefillMs, rt.config.tickMs);
    rt.history.flush();
    rt.broadcastDerived();
    rt.hub.broadcast(rt.buildSnapshot());
    rt.resyncAlerts();
    return rt.derived.getState(def.id);
  });

  app.delete<{ Params: DerivedIdParam }>('/derived/:id', async (req, reply) => {
    const existing = rt.configStore.getDerivedDef(req.params.id);
    if (!existing) return reply.code(404).send({ error: 'derived_not_found' });

    // 仍被其它派生指标引用 -> 阻止删除并清楚告知是谁在依赖
    const downstream = rt.derived.dependents(existing.id);
    if (downstream.length) {
      return reply.code(409).send({
        error: 'derived_in_use',
        message: `仍有 ${downstream.length} 个派生指标引用它，请先修改或删除它们：${downstream.map((id) => rt.derived.getState(id)?.def.name ?? id).join('、')}`,
        dependents: downstream,
      });
    }
    // 仍有告警规则绑在它上面 -> 阻止删除，避免规则变成野指针
    const rules = rt.configStore.getRules().filter((r) => r.sourceId === existing.id);
    if (rules.length) {
      return reply.code(409).send({
        error: 'derived_in_use',
        message: `仍有 ${rules.length} 条告警规则绑定该指标，请先删除这些规则`,
        ruleIds: rules.map((r) => r.id),
      });
    }

    rt.configStore.deleteDerived(existing.id);
    rt.derived.reload();
    rt.broadcastDerived();
    rt.hub.broadcast(rt.buildSnapshot());
    return { ok: true };
  });
}
