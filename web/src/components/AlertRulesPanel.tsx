/**
 * 告警规则管理面板：规则增删改，区分警告/严重两档。
 * 指标下拉统一展示原始采集指标与派生（算出来的）指标。
 */
import { useState } from 'react';
import { api } from '../api/client';
import type { AlertLevel, AlertOperator, AlertRule } from '../types';
import { useDashboard } from '../store/useDashboard';
import { buildMetricViews, type MetricView } from '../utils/metrics';

interface Props {
  /** 只展示/管理某一路指标的规则；不传则管理全部 */
  fixedSourceId?: string;
  /** 显式传入指标视图；不传则用全局 store（原始 + 派生） */
  metrics?: MetricView[];
}

const emptyDraft = {
  level: 'warning' as AlertLevel,
  operator: '>' as AlertOperator,
  threshold: '',
  note: '',
};

export default function AlertRulesPanel({ fixedSourceId, metrics }: Props) {
  const sources = useDashboard((s) => s.sources);
  const derived = useDashboard((s) => s.derived);
  const rules = useDashboard((s) => s.rules);
  const actives = useDashboard((s) => s.actives);
  const refreshRules = useDashboard((s) => s.refreshRules);

  const allMetrics = metrics ?? buildMetricViews(sources, derived).filter((m) => (m.kind === 'derived' ? !m.broken : m.enabled));

  const [sourceId, setSourceId] = useState(fixedSourceId ?? allMetrics[0]?.id ?? '');
  const [draft, setDraft] = useState({ ...emptyDraft });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shownRules = rules.filter((r) => !fixedSourceId || r.sourceId === fixedSourceId);
  const nameOf = (id: string) => allMetrics.find((m) => m.id === id)?.name ?? id;
  const unitOf = (id: string) => allMetrics.find((m) => m.id === id)?.unit ?? '';

  const resetForm = () => {
    setDraft({ ...emptyDraft });
    setEditingId(null);
    setError(null);
  };

  const submit = async () => {
    const threshold = Number(draft.threshold);
    if (!sourceId) return setError('请选择指标');
    if (!Number.isFinite(threshold)) return setError('阈值必须是数字');
    try {
      if (editingId) {
        await api.updateRule(editingId, { sourceId, level: draft.level, operator: draft.operator, threshold, note: draft.note });
      } else {
        await api.createRule({ sourceId, level: draft.level, operator: draft.operator, threshold, enabled: true, note: draft.note });
      }
      await refreshRules();
      resetForm();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const startEdit = (rule: AlertRule) => {
    setEditingId(rule.id);
    setSourceId(rule.sourceId);
    setDraft({ level: rule.level, operator: rule.operator, threshold: String(rule.threshold), note: rule.note ?? '' });
    setError(null);
  };

  const toggle = async (rule: AlertRule) => {
    await api.updateRule(rule.id, { enabled: !rule.enabled });
    await refreshRules();
  };

  const remove = async (rule: AlertRule) => {
    await api.deleteRule(rule.id);
    if (editingId === rule.id) resetForm();
    await refreshRules();
  };

  return (
    <div className="rules-panel">
      <div className="rules-form">
        <h4>{editingId ? '编辑告警规则' : '新增告警规则'}</h4>
        <div className="form-row">
          <label>指标</label>
          <select value={sourceId} disabled={!!fixedSourceId} onChange={(e) => setSourceId(e.target.value)}>
            {allMetrics.map((m) => (
              <option key={m.id} value={m.id}>
                {m.kind === 'derived' ? 'Σ ' : ''}
                {m.name}（{m.unit || '—'}）
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label>级别</label>
          <div className="seg">
            <button type="button" className={draft.level === 'warning' ? 'seg-btn seg-warning active' : 'seg-btn seg-warning'} onClick={() => setDraft({ ...draft, level: 'warning' })}>
              警告
            </button>
            <button type="button" className={draft.level === 'critical' ? 'seg-btn seg-critical active' : 'seg-btn seg-critical'} onClick={() => setDraft({ ...draft, level: 'critical' })}>
              严重
            </button>
          </div>
        </div>
        <div className="form-row">
          <label>条件</label>
          <select value={draft.operator} onChange={(e) => setDraft({ ...draft, operator: e.target.value as AlertOperator })}>
            <option value=">">&gt; 大于</option>
            <option value=">=">&gt;= 大于等于</option>
            <option value="<">&lt; 小于</option>
            <option value="<=">&lt;= 小于等于</option>
          </select>
          <input
            type="number"
            step="0.01"
            placeholder={`阈值 ${unitOf(sourceId) || ''}`}
            value={draft.threshold}
            onChange={(e) => setDraft({ ...draft, threshold: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label>备注</label>
          <input type="text" placeholder="如：近五分钟平均错误率过高" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={submit}>
            {editingId ? '保存修改' : '添加规则'}
          </button>
          {editingId && (
            <button type="button" className="btn" onClick={resetForm}>
              取消
            </button>
          )}
        </div>
      </div>

      <div className="rules-list">
        <h4>已有规则（{shownRules.length}）</h4>
        {shownRules.length === 0 && <div className="rules-empty">还没有规则，先在上方添加一条。</div>}
        {shownRules.map((rule) => {
          const active = actives.some((a) => a.ruleId === rule.id);
          const metric = allMetrics.find((m) => m.id === rule.sourceId);
          const derivedRule = metric?.kind === 'derived';
          return (
            <div key={rule.id} className={`rule-item ${!rule.enabled ? 'rule-disabled' : ''} ${active ? (rule.level === 'critical' ? 'rule-active-critical' : 'rule-active-warning') : ''}`}>
              <div className="rule-main">
                <span className={`rule-level level-${rule.level}`}>{rule.level === 'critical' ? '严重' : '警告'}</span>
                <span className="rule-expr">
                  {derivedRule && <span className="tag tag-derived tag-mini">派生</span>}
                  <strong>{nameOf(rule.sourceId)}</strong> {rule.operator} {rule.threshold}
                  {unitOf(rule.sourceId) ? ` ${unitOf(rule.sourceId)}` : ''}
                </span>
                {active && <span className="rule-firing">已触发</span>}
                {rule.note && <span className="rule-note">{rule.note}</span>}
              </div>
              <div className="rule-ops">
                <button type="button" className="btn btn-mini" onClick={() => toggle(rule)}>
                  {rule.enabled ? '停用' : '启用'}
                </button>
                <button type="button" className="btn btn-mini" onClick={() => startEdit(rule)}>
                  编辑
                </button>
                <button type="button" className="btn btn-mini btn-danger" onClick={() => remove(rule)}>
                  删除
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
