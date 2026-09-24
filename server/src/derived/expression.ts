/**
 * 派生指标计算式：词法分析、递归下降解析（生成 AST）、求值与引用收集。
 *
 * 语法：
 *   expr    := term (('+' | '-') term)*
 *   term    := factor (('*' | '/') factor)*
 *   factor  := ('-' | '+') factor | primary
 *   primary := 数字 | 标识符 | 聚合调用 | '(' expr ')'
 *   聚合调用:= ('avg'|'min'|'max'|'last') '(' 标识符 ',' 窗口 ')'
 *   窗口    := 数字 ('ms'|'s'|'m'|'h')        例如 30s、5m、1h
 *
 * 标识符可引用原始采集指标或其它派生指标；常数、四则运算与括号随意组合。
 */

export type AggFn = 'avg' | 'min' | 'max' | 'last';

export type AstNode =
  | { type: 'num'; value: number }
  | { type: 'ref'; id: string }
  | { type: 'bin'; op: '+' | '-' | '*' | '/'; left: AstNode; right: AstNode }
  | { type: 'neg'; operand: AstNode }
  | { type: 'agg'; fn: AggFn; ref: string; windowMs: number };

export const AGG_FNS: AggFn[] = ['avg', 'min', 'max', 'last'];

const WINDOW_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
};

/** 解析期错误：带位置信息，消息直接展示给用户 */
export class ExpressionParseError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.name = 'ExpressionParseError';
    this.pos = pos;
  }
}

/** 求值期错误：code 供引擎归类，message 展示在指标状态里 */
export type EvalErrorCode = 'missing_ref' | 'empty_window' | 'div_zero' | 'non_finite';

export class EvaluationError extends Error {
  readonly code: EvalErrorCode;
  constructor(code: EvalErrorCode, message: string) {
    super(message);
    this.name = 'EvaluationError';
    this.code = code;
  }
}

// ---------- 词法分析 ----------

type Token =
  | { kind: 'num'; value: number; pos: number }
  | { kind: 'ident'; name: string; pos: number }
  | { kind: 'op'; op: string; pos: number };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i));
      if (!m) throw new ExpressionParseError(`第 ${i + 1} 个字符附近：无法识别的数字`, i);
      tokens.push({ kind: 'num', value: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      tokens.push({ kind: 'ident', name: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if ('+-*/(),'.includes(ch)) {
      tokens.push({ kind: 'op', op: ch, pos: i });
      i += 1;
      continue;
    }
    throw new ExpressionParseError(`第 ${i + 1} 个字符附近：无法识别的符号 “${ch}”`, i);
  }
  return tokens;
}

// ---------- 语法分析 ----------

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new ExpressionParseError('表达式意外结束，似乎少了内容', this.srcLen());
    this.pos += 1;
    return t;
  }

  private srcLen(): number {
    const last = this.tokens[this.tokens.length - 1];
    return last ? last.pos + 1 : 0;
  }

  private expectOp(op: string): void {
    const t = this.next();
    if (t.kind !== 'op' || t.op !== op) {
      throw new ExpressionParseError(`第 ${t.pos + 1} 个字符附近：期望 “${op}”`, t.pos);
    }
  }

  parseExpr(): AstNode {
    let left = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t && t.kind === 'op' && (t.op === '+' || t.op === '-')) {
        this.next();
        left = { type: 'bin', op: t.op, left, right: this.parseTerm() };
      } else {
        return left;
      }
    }
  }

  private parseTerm(): AstNode {
    let left = this.parseFactor();
    for (;;) {
      const t = this.peek();
      if (t && t.kind === 'op' && (t.op === '*' || t.op === '/')) {
        this.next();
        left = { type: 'bin', op: t.op, left, right: this.parseFactor() };
      } else {
        return left;
      }
    }
  }

  private parseFactor(): AstNode {
    const t = this.peek();
    if (t && t.kind === 'op' && t.op === '-') {
      this.next();
      return { type: 'neg', operand: this.parseFactor() };
    }
    if (t && t.kind === 'op' && t.op === '+') {
      this.next();
      return this.parseFactor();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): AstNode {
    const t = this.next();
    if (t.kind === 'num') return { type: 'num', value: t.value };
    if (t.kind === 'op' && t.op === '(') {
      const inner = this.parseExpr();
      this.expectOp(')');
      return inner;
    }
    if (t.kind === 'ident') {
      const ahead = this.peek();
      if (ahead && ahead.kind === 'op' && ahead.op === '(') {
        return this.parseAggCall(t.name, t.pos);
      }
      return { type: 'ref', id: t.name };
    }
    throw new ExpressionParseError(`第 ${t.pos + 1} 个字符附近：此处应该是数字、指标名或括号`, t.pos);
  }

  private parseAggCall(name: string, pos: number): AstNode {
    if (!AGG_FNS.includes(name as AggFn)) {
      throw new ExpressionParseError(`第 ${pos + 1} 个字符附近：未知的聚合函数 “${name}”（支持 ${AGG_FNS.join('/')}）`, pos);
    }
    this.expectOp('(');
    const refTok = this.next();
    if (refTok.kind !== 'ident') {
      throw new ExpressionParseError(`第 ${refTok.pos + 1} 个字符附近：聚合函数的第一个参数必须是指标名`, refTok.pos);
    }
    this.expectOp(',');
    const windowMs = this.parseWindow();
    this.expectOp(')');
    return { type: 'agg', fn: name as AggFn, ref: refTok.name, windowMs };
  }

  /** 窗口字面量：数字 + 单位（ms/s/m/h），如 5m、30s */
  private parseWindow(): number {
    const numTok = this.next();
    if (numTok.kind !== 'num') {
      throw new ExpressionParseError(`第 ${numTok.pos + 1} 个字符附近：窗口需要写成 “数字+单位”，如 5m、30s`, numTok.pos);
    }
    const unitTok = this.next();
    if (unitTok.kind !== 'ident' || !(unitTok.name in WINDOW_UNITS)) {
      throw new ExpressionParseError(`第 ${unitTok.pos + 1} 个字符附近：窗口单位必须是 ms/s/m/h，如 5m`, unitTok.pos);
    }
    const ms = numTok.value * WINDOW_UNITS[unitTok.name];
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new ExpressionParseError(`第 ${numTok.pos + 1} 个字符附近：窗口时长必须大于 0`, numTok.pos);
    }
    return ms;
  }

  /** 表达式整体解析完后必须没有剩余 token */
  ensureDone(): void {
    const t = this.peek();
    if (t) {
      const got = t.kind === 'op' ? `“${t.op}”` : t.kind === 'num' ? `数字 ${t.value}` : `“${t.name}”`;
      throw new ExpressionParseError(`第 ${t.pos + 1} 个字符附近：多余的 ${got}`, t.pos);
    }
  }
}

/** 解析计算式为 AST；语法错误抛 ExpressionParseError（消息面向用户）。 */
export function parseExpression(src: string): AstNode {
  if (!src || !src.trim()) throw new ExpressionParseError('计算式不能为空', 0);
  const parser = new Parser(tokenize(src));
  const ast = parser.parseExpr();
  parser.ensureDone();
  return ast;
}

/** 收集 AST 引用的全部指标 id（普通引用 + 聚合引用），去重。 */
export function collectRefs(ast: AstNode): string[] {
  const refs = new Set<string>();
  const walk = (node: AstNode): void => {
    switch (node.type) {
      case 'ref':
        refs.add(node.id);
        break;
      case 'agg':
        refs.add(node.ref);
        break;
      case 'bin':
        walk(node.left);
        walk(node.right);
        break;
      case 'neg':
        walk(node.operand);
        break;
      case 'num':
        break;
    }
  };
  walk(ast);
  return [...refs];
}

// ---------- 求值 ----------

export interface EvalContext {
  /** 取某指标“本拍”的值；本拍没有新点时返回 undefined */
  get(id: string): number | undefined;
  /** 对某指标在 (ts - windowMs, ts] 窗口内聚合；窗口内无点返回 undefined */
  aggregate(id: string, fn: AggFn, windowMs: number): number | undefined;
}

function evalNode(node: AstNode, ctx: EvalContext): number {
  switch (node.type) {
    case 'num':
      return node.value;
    case 'ref': {
      const v = ctx.get(node.id);
      if (v === undefined) throw new EvaluationError('missing_ref', `指标 ${node.id} 当前没有可用数据`);
      return v;
    }
    case 'neg':
      return -evalNode(node.operand, ctx);
    case 'bin': {
      const l = evalNode(node.left, ctx);
      const r = evalNode(node.right, ctx);
      switch (node.op) {
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          if (r === 0) throw new EvaluationError('div_zero', '除数为零');
          return l / r;
      }
      // 穷尽分支，不会到这里
      throw new Error(`未知运算符 ${node.op}`);
    }
    case 'agg': {
      const v = ctx.aggregate(node.ref, node.fn, node.windowMs);
      if (v === undefined) {
        throw new EvaluationError('empty_window', `指标 ${node.ref} 在聚合窗口内没有数据点`);
      }
      return v;
    }
  }
}

/** 求值；结果必须是有限数，否则视为本路计算失败（不产点）。 */
export function evaluateAst(ast: AstNode, ctx: EvalContext): number {
  const value = evalNode(ast, ctx);
  if (!Number.isFinite(value)) {
    throw new EvaluationError('non_finite', '计算结果不是有限数值');
  }
  return value;
}
