/**
 * 配置存储：数据源开关、告警规则、用户布局、派生指标定义落到容器内 data/config.json。
 * 写入采用临时文件 + rename 原子替换，避免半写文件损坏配置。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AlertRule, DerivedMetricDef, LayoutConfig } from '../types';
import { shortId } from '../util/random';

export interface PersistedConfig {
  /** sourceId -> 采集开关（原始指标与派生指标共用） */
  sourceEnabled: Record<string, boolean>;
  rules: AlertRule[];
  layout: LayoutConfig;
  /** 用户定义的派生指标（算出来的指标），重启后仍在 */
  derived: DerivedMetricDef[];
}

export class ConfigStore {
  private filePath: string;
  private data: PersistedConfig;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, 'config.json');
    this.data = this.load();
  }

  private load(): PersistedConfig {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedConfig>;
      return {
        sourceEnabled: parsed.sourceEnabled ?? {},
        rules: Array.isArray(parsed.rules) ? parsed.rules : [],
        layout: Array.isArray(parsed.layout) ? parsed.layout : [],
        derived: Array.isArray(parsed.derived) ? parsed.derived : [],
      };
    } catch {
      return { sourceEnabled: {}, rules: [], layout: [], derived: [] };
    }
  }

  private save(): void {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  isEnabled(sourceId: string, fallback: boolean): boolean {
    return this.data.sourceEnabled[sourceId] ?? fallback;
  }

  setEnabled(sourceId: string, enabled: boolean): void {
    this.data.sourceEnabled[sourceId] = enabled;
    this.save();
  }

  getRules(): AlertRule[] {
    return this.data.rules;
  }

  getRule(id: string): AlertRule | undefined {
    return this.data.rules.find((r) => r.id === id);
  }

  addRule(input: Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>): AlertRule {
    const now = Date.now();
    const rule: AlertRule = { ...input, id: shortId('rule_'), createdAt: now, updatedAt: now };
    this.data.rules.push(rule);
    this.save();
    return rule;
  }

  updateRule(id: string, patch: Partial<Pick<AlertRule, 'level' | 'operator' | 'threshold' | 'enabled' | 'note' | 'sourceId'>>): AlertRule | undefined {
    const rule = this.data.rules.find((r) => r.id === id);
    if (!rule) return undefined;
    Object.assign(rule, patch, { updatedAt: Date.now() });
    this.save();
    return rule;
  }

  deleteRule(id: string): boolean {
    const before = this.data.rules.length;
    this.data.rules = this.data.rules.filter((r) => r.id !== id);
    if (this.data.rules.length === before) return false;
    this.save();
    return true;
  }

  getLayout(): LayoutConfig {
    return this.data.layout;
  }

  saveLayout(layout: LayoutConfig): void {
    this.data.layout = layout;
    this.save();
  }

  // ---------- 派生指标定义 ----------

  getDerived(): DerivedMetricDef[] {
    return this.data.derived;
  }

  getDerivedById(id: string): DerivedMetricDef | undefined {
    return this.data.derived.find((d) => d.id === id);
  }

  addDerived(def: DerivedMetricDef): void {
    this.data.derived.push(def);
    this.save();
  }

  updateDerived(id: string, patch: Partial<Omit<DerivedMetricDef, 'id' | 'createdAt'>>): DerivedMetricDef | undefined {
    const def = this.data.derived.find((d) => d.id === id);
    if (!def) return undefined;
    Object.assign(def, patch, { updatedAt: Date.now() });
    this.save();
    return def;
  }

  deleteDerived(id: string): boolean {
    const before = this.data.derived.length;
    this.data.derived = this.data.derived.filter((d) => d.id !== id);
    if (this.data.derived.length === before) return false;
    this.save();
    return true;
  }
}
