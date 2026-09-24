/**
 * 派生指标管理页：把“算出来的指标”建起来、改、删。
 * 计算式可引用原始采集指标与其它派生指标，支持 + - * /、括号、常数，
 * 以及窗口聚合 avg/min/max/last(指标, 窗口)（如 avg(error_rate, 5m)）。
 * 保存时服务端会校验语法、未知引用与循环依赖，错误原样展示在这里。
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useDashboard } from '../store/useDashboard';
import ChartCard from '../components/ChartCard';
import { formatClock, formatValue } from '../utils/format';
import type { DerivedMetricInfo } from '../types';

interface Draft {
  id: string;
  name: string;
  unit: string;
  decimals: string;
  max: string;
  expression: string;
  description: string;
}

const emptyDraft: Draft = {
  id: '',
  name: '',
  unit: '',
  decimals: '2',
  max: '100',
  expression: '',
  description: '',
};

export default function DerivedPage() {
  const sources = useDashboard((s) => s.sources);
  const series = useDashboard((s) => s.series);

  const [defs, setDefs] = useState<DerivedMetricInfo[]>([]);
  const [draft, setDraft] = useState<Draft>({ ...emptyDraft });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => setDefs(await api.derived());
  useEffect(() => {
    refresh().catch(() => undefined);
  }, []);

  /** 可引用的指标：原始采集指标 + 已定义的派生指标 */
  const referable = useMemo(
    () => [
      ...sources.filter((s) => s.def.kind !== 'derived').map((s) => ({ id: s.def.id, name: s.def.name })),
      ...defs.map((d) => ({ id: d.id, name: d.name })),
    ],
    [sources, defs],
  );

  const stateOf = (id: string) => sources.find((s) => s.def.id === id);
  const latestOf = (id: string): number | null => {
    const arr = series[id];
    return arr && arr.length ? arr[arr.length - 1].value : null;
  };

  const resetForm = () => {
    setDraft({ ...emptyDraft });
    setEditingId(null);
    setError(null);
  };

  const submit = async () => {
    const decimals = Number(draft.decimals);
    const max = Number(draft.max);
    if (!draft.name.trim()) return setError('请填写名称');
    if (!draft.expression.trim()) return setError('请填写计算式');
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) return setError('小数位必须是 0~6 的整数');
    if (!Number.isFinite(max) || max <= 0) return setError('满量程必须是大于 0 的数字');
    setBusy(true);
    setError(null);
    try {
      if (editingId) {
        await api.updateDerived(editingId, {
          name: draft.name.trim(),
          unit: draft.unit.trim(),
          decimals,
          max,
          expression: draft.expression.trim(),
          description: draft.description.trim(),
        });
      } else {
        await api.createDerived({
          ...(draft.id.trim() ? { id: draft.id.trim() } : {}),
          name: draft.name.trim(),
          unit: draft.unit.trim(),
          decimals,
          max,
          expression: draft.expression.trim(),
          description: draft.description.trim(),
        });
      }
      await refresh();
      resetForm();
    } catch (e) {
      // 服务端校验消息（语法错误 / 未知引用 / 循环依赖）原样展示
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (def: DerivedMetricInfo) => {
    setEditingId(def.id);
    setDraft({
      id: def.id,
      name: def.name,
      unit: def.unit,
      decimals: String(def.decimals),
      max: String(def.max),
      expression: def.expression,
      description: def.description,
    });
    setError(null);
  };

  const remove = async (def: DerivedMetricInfo) => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteDerived(def.id);
      if (editingId === def.id) resetForm();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <h2>派生指标</h2>
        <span className="conn conn-on">共 {defs.length} 个 · 与原始指标一样实时推送、可设告警、进历史回放</span>
      </div>

      <div className="derived-layout">
        <ChartCard title={editingId ? `编辑派生指标（${editingId}）` : '新建派生指标'} subtitle="保存时会校验语法、未知引用与循环依赖">
          <div className="rules-form">
            <div className="form-row">
              <label>名称</label>
              <input type="text" placeholder="如：最近五分钟平均错误率" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="form-row">
              <label>标识 id</label>
              <input
                type="text"
                placeholder={editingId ? editingId : '可留空自动生成；其它计算式用它引用本指标'}
                value={draft.id}
                disabled={!!editingId}
                onChange={(e) => setDraft({ ...draft, id: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label>计算式</label>
              <input
                type="text"
                className="expr-input"
                placeholder="如：avg(error_rate, 5m) 或 (cpu + memory) / 2"
                value={draft.expression}
                onChange={(e) => setDraft({ ...draft, expression: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label>单位</label>
              <input type="text" placeholder="如：%、req/s" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} />
            </div>
            <div className="form-row">
              <label>小数位</label>
              <input type="number" min={0} max={6} value={draft.decimals} onChange={(e) => setDraft({ ...draft, decimals: e.target.value })} />
            </div>
            <div className="form-row">
              <label>满量程</label>
              <input type="number" min={0} value={draft.max} onChange={(e) => setDraft({ ...draft, max: e.target.value })} />
            </div>
            <div className="form-row">
              <label>说明</label>
              <input type="text" placeholder="可选" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </div>
            {error && <div className="form-error">{error}</div>}
            <div className="form-actions">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>
                {editingId ? '保存修改' : '创建指标'}
              </button>
              {editingId && (
                <button type="button" className="btn" onClick={resetForm}>
                  取消
                </button>
              )}
            </div>
          </div>
        </ChartCard>

        <ChartCard title="语法与可引用指标" subtitle="窗口聚合：avg / min / max / last(指标, 窗口)，窗口如 30s、5m、1h">
          <div className="derived-help">
            <div className="help-block">
              <h4>计算式语法</h4>
              <ul>
                <li>
                  四则运算与括号：<code>(cpu + memory) / 2</code>、<code>rps / online</code>
                </li>
                <li>
                  常数：<code>error_rate / 100 * rps</code>
                </li>
                <li>
                  窗口聚合：<code>avg(error_rate, 5m)</code>（最近 5 分钟平均）、<code>max(cpu, 30s)</code>、<code>min(rps, 1h)</code>、
                  <code>last(online, 5m)</code>
                </li>
                <li>可引用其它派生指标，多层依赖由系统按先后顺序自动计算；循环依赖会被拒绝。</li>
                <li>依赖的源被关闭或取不到数时，本指标暂停产点并标记异常，源恢复后自动恢复。</li>
              </ul>
            </div>
            <div className="help-block">
              <h4>当前可引用的指标</h4>
              <div className="ref-chips">
                {referable.map((r) => (
                  <span key={r.id} className="chip chip-static" title={r.name}>
                    {r.id}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </ChartCard>
      </div>

      <ChartCard title="已定义的派生指标" subtitle="实时值来自推送流；状态异常时鼠标悬停查看原因">
        {defs.length === 0 ? (
          <div className="rules-empty">还没有派生指标，先在上方创建一个，例如“最近五分钟平均错误率”。</div>
        ) : (
          <table className="source-table">
            <thead>
              <tr>
                <th>指标</th>
                <th>计算式</th>
                <th>状态</th>
                <th>当前值</th>
                <th>最近数据点</th>
                <th>依赖</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {defs.map((d) => {
                const st = stateOf(d.id);
                const enabled = st?.enabled ?? d.enabled;
                const errored = enabled && st?.status === 'error';
                return (
                  <tr key={d.id} className={!enabled ? 'row-off' : errored ? 'row-error' : ''}>
                    <td>
                      <strong>{d.name}</strong>
                      <span className="source-id">{d.id}</span>
                    </td>
                    <td>
                      <code className="expr-code">{d.expression}</code>
                      <span className="source-desc expr-meta">
                        {d.unit || '—'} · {d.decimals} 位小数
                      </span>
                    </td>
                    <td>
                      {!enabled ? (
                        <span className="tag tag-off">已关闭</span>
                      ) : errored ? (
                        <span className="tag tag-error" title={st?.lastError ?? ''}>
                          异常
                        </span>
                      ) : (
                        <span className="tag tag-ok">正常</span>
                      )}
                      {errored && <div className="source-err">{st?.lastError}</div>}
                    </td>
                    <td>{formatValue(latestOf(d.id), d.decimals, d.unit)}</td>
                    <td>{formatClock(st?.lastPointTs)}</td>
                    <td className="source-desc">
                      {d.refs.length ? d.refs.join('、') : '—'}
                      {d.dependents.length > 0 && <div>被引用：{d.dependents.join('、')}</div>}
                    </td>
                    <td>
                      <div className="rule-ops">
                        <button type="button" className="btn btn-mini" disabled={busy} onClick={() => startEdit(d)}>
                          编辑
                        </button>
                        <button type="button" className="btn btn-mini btn-danger" disabled={busy} onClick={() => remove(d)}>
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </ChartCard>
    </div>
  );
}
