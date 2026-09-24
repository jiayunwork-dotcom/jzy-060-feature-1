/**
 * 派生（算出来的）指标管理面板：新增、编辑、删除。
 * 算式支持四则运算、括号、常数、引用其它指标，以及窗口聚合
 * avg/max/min/last(指标, 时长)，时长支持 ms/s/m/h。
 * 环、坏算式、引用不存在的指标由后端在保存时拒绝，错误直接展示给用户。
 */
import { useMemo, useState } from 'react';
import { api } from '../api/client';
import { useDashboard } from '../store/useDashboard';
import { buildMetricViews } from '../utils/metrics';
import { formatClock } from '../utils/format';

interface Draft {
  name: string;
  unit: string;
  decimals: string;
  max: string;
  formula: string;
  description: string;
}

const emptyDraft: Draft = { name: '', unit: '', decimals: '2', max: '100', formula: '', description: '' };

/** jsonFetch 失败时 message 形如 "400 Bad Request: {json}"，提取后端给的中文原因。 */
function errorMessage(e: unknown): string {
  const raw = (e as Error).message ?? '保存失败';
  const brace = raw.indexOf('{');
  if (brace >= 0) {
    try {
      const body = JSON.parse(raw.slice(brace));
      return body.message ?? raw;
    } catch {
      /* 不是 JSON，回退原文 */
    }
  }
  return raw;
}

export default function DerivedPanel() {
  const sources = useDashboard((s) => s.sources);
  const derived = useDashboard((s) => s.derived);
  const refreshDerived = useDashboard((s) => s.refreshDerived);

  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const metrics = useMemo(() => buildMetricViews(sources, derived), [sources, derived]);
  const nameOf = (id: string) => metrics.find((m) => m.id === id)?.name ?? id;

  const reset = () => {
    setDraft(emptyDraft);
    setEditingId(null);
    setError(null);
  };

  const submit = async () => {
    setError(null);
    const payload = {
      name: draft.name.trim(),
      unit: draft.unit.trim(),
      decimals: Number(draft.decimals),
      max: draft.max === '' ? 100 : Number(draft.max),
      formula: draft.formula.trim(),
      description: draft.description.trim(),
    };
    if (!payload.name) return setError('请填写名称');
    if (!payload.formula) return setError('请填写计算式');
    if (!Number.isInteger(payload.decimals) || payload.decimals < 0 || payload.decimals > 8) return setError('小数位需为 0~8 的整数');
    setBusy(true);
    try {
      if (editingId) {
        await api.updateDerived(editingId, payload);
      } else {
        await api.createDerived(payload);
      }
      await refreshDerived();
      reset();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (id: string) => {
    const d = derived.find((x) => x.def.id === id);
    if (!d) return;
    setEditingId(id);
    setDraft({
      name: d.def.name,
      unit: d.def.unit,
      decimals: String(d.def.decimals),
      max: String(d.def.max),
      formula: d.def.formula,
      description: d.def.description,
    });
    setError(null);
  };

  const remove = async (id: string) => {
    const d = derived.find((x) => x.def.id === id);
    if (!d) return;
    if (!window.confirm(`确认删除派生指标「${d.def.name}」？此操作不影响原始采集数据。`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteDerived(id);
      if (editingId === id) reset();
      await refreshDerived();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const insertToken = (token: string) => setDraft((d) => ({ ...d, formula: d.formula + token }));  return (
    <div className="derived-panel">
      <div className="rules-form derived-form">
        <h4>{editingId ? '编辑派生指标' : '新增派生指标'}</h4>
        <div className="form-row">
          <label>名称</label>
          <input type="text" placeholder="如：最近五分钟平均错误率" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="form-row form-row-3">
          <label>单位</label>
          <input type="text" placeholder="如 %、req/s" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} />
          <label>小数位</label>
          <input type="number" min={0} max={8} value={draft.decimals} onChange={(e) => setDraft({ ...draft, decimals: e.target.value })} />
          <label>满量程</label>
          <input type="number" min={1} value={draft.max} onChange={(e) => setDraft({ ...draft, max: e.target.value })} />
        </div>
        <div className="form-row form-row-block">
          <label>计算式</label>
          <textarea
            rows={2}
            placeholder={'如：error_rate / 100、(cpu + memory) / 2、avg(error_rate, 5m)'}
            value={draft.formula}
            onChange={(e) => setDraft({ ...draft, formula: e.target.value })}
            spellCheck={false}
          />
        </div>

        {/* 点选插入：指标引用与窗口函数，避免手滑写错 id */}
        <div className="derived-insert">
          <span className="derived-insert-label">引用指标：</span>
          {metrics
            .filter((m) => m.id !== editingId)
            .map((m) => (
              <button key={m.id} type="button" className="chip chip-mini" title={m.kind === 'derived' ? m.formula : m.description} onClick={() => insertToken(m.id)}>
                {m.kind === 'derived' ? 'Σ ' : ''}
                {m.name}
              </button>
            ))}
        </div>
        <div className="derived-insert">
          <span className="derived-insert-label">窗口聚合：</span>
          {(['avg', 'max', 'min', 'last'] as const).map((fn) => (
            <button
              key={fn}
              type="button"
              className="chip chip-mini"
              title={`在算式末尾插入 ${fn}(，随后点选指标并补充 , 时长)；时长支持 ms/s/m/h`}
              onClick={() => insertToken(`${fn}(`)}
            >
              {fn}()
            </button>
          ))}
        </div>

        <div className="form-row">
          <label>说明</label>
          <input type="text" placeholder="可选" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
            {editingId ? '保存修改' : '创建派生指标'}
          </button>
          {editingId && (
            <button type="button" className="btn" onClick={reset}>
              取消
            </button>
          )}
        </div>
      </div>

      <div className="rules-list derived-list">
        <h4>已有派生指标（{derived.length}）</h4>
        {derived.length === 0 && <div className="rules-empty">还没有派生指标。用上方表单定义一个，例如 avg(error_rate, 5m)。</div>}
        {derived.map((d) => (
          <div key={d.def.id} className={`derived-item ${d.broken ? 'derived-broken' : d.status === 'error' ? 'derived-error' : ''}`}>
            <div className="derived-item-main">
              <div className="derived-item-head">
                <span className="tag tag-derived">派生</span>
                <strong>{d.def.name}</strong>
                <span className="source-id">{d.def.id}</span>
                {d.broken ? (
                  <span className="tag tag-error">定义失效</span>
                ) : d.status === 'error' ? (
                  <span className="tag tag-error" title={d.lastError ?? ''}>
                    异常
                  </span>
                ) : (
                  <span className="tag tag-ok">正常</span>
                )}
              </div>
              <code className="derived-formula">{d.def.formula}</code>
              <div className="derived-meta">
                <span>{d.def.unit || '无单位'}</span>
                <span>· {d.def.decimals} 位小数</span>
                <span>· 依赖：{d.dependsOn.length ? d.dependsOn.map((id) => nameOf(id)).join('、') : '无（纯常数式）'}</span>
                <span>· 最近产出 {formatClock(d.lastPointTs)}</span>
              </div>
              {d.lastError && <div className="source-err">{d.lastError}</div>}
            </div>
            <div className="rule-ops">
              <button type="button" className="btn btn-mini" disabled={busy} onClick={() => startEdit(d.def.id)}>
                编辑
              </button>
              <button type="button" className="btn btn-mini btn-danger" disabled={busy} onClick={() => remove(d.def.id)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
