/**
 * 计算式（公式）的词法、语法解析与求值 —— 派生指标的独立一块。
 *
 * 语法：
 *   expr   := term (('+' | '-') term)*
 *   term   := factor (('*' | '/') factor)*
 *   factor := ('+' | '-') factor | atom
 *   atom   := 数字[时间单位] | 指标引用 | 窗口聚合调用 | '(' expr ')'
 *   call   := ('avg'|'max'|'min'|'last') '(' 指标id ',' 数字时间单位 ')'
 *
 * 时间单位仅用于窗口参数：ms（毫秒）/ s（秒，默认）/ m（分）/ h（时）。
 * 指标引用为裸标识符，如 cpu、error_rate，可引用原始指标或其它派生指标。
 *
 * 解析期错误（语法错、引用了不存在的指标、非法窗口）抛 FormulaSyntaxError；
 * 运行期错误（被零除、依赖当前无数据、结果非有限数）抛 FormulaEvalError，
 * 由派生引擎把对应那一路单独标成异常，绝不连累其它指标。
 */

export type WindowFn = 'avg' | 'max' | 'min' | 'last';
const WINDOW_FNS: ReadonlySet<string> = new Set(['avg', 'max', 'min', 'last']);

export type AstNode =
  | { kind: 'num'; value: number }
  | { kind: 'ref'; id: string }
  | { kind: 'unary'; op: '+' | '-'; arg: AstNode }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: AstNode; right: AstNode }
  | { kind: 'window'; fn: WindowFn; refId: string; windowMs: number };

export interface ParsedFormula {
  source: string;
  ast: AstNode;
  /** 全部被引用的指标 id（去重，保持首次出现顺序） */
  refs: string[];
}

export class FormulaSyntaxError extends Error {
  constructor(
    message: string,
    /** 出错位置（字符下标），便于前端定位 */
    readonly position: number,
  ) {
    super(message);
    this.name = 'FormulaSyntaxError';
  }
}

export type EvalErrorCode = 'no_data' | 'div_zero' | 'not_finite';

export class FormulaEvalError extends Error {
  constructor(
    readonly code: EvalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FormulaEvalError';
  }
}

// ---------------- 词法 ----------------

type TokenKind = 'num' | 'ident' | 'op';
interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      const start = i;
      while (i < input.length && input[i] >= '0' && input[i] <= '9') i += 1;
      if (input[i] === '.') {
        i += 1;
        while (i < input.length && input[i] >= '0' && input[i] <= '9') i += 1;
      }
      tokens.push({ kind: 'num', value: input.slice(start, i), pos: start });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) i += 1;
      tokens.push({ kind: 'ident', value: input.slice(start, i), pos: start });
      continue;
    }
    if ('+-*/(),'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch, pos: i });
      i += 1;
      continue;
    }
    throw new FormulaSyntaxError(`无法识别的字符 "${ch}"`, i);
  }
  return tokens;
}

// ---------------- 语法 ----------------

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly source: string,
    private readonly knownIds?: Set<string>,
  ) {}

  parse(): ParsedFormula {
    if (this.tokens.length === 0) throw new FormulaSyntaxError('计算式为空', 0);
    const ast = this.parseExpr();
    if (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos];
      throw new FormulaSyntaxError(`计算式在 "${t.value}" 之后还有多余内容`, t.pos);
    }
    const refs: string[] = [];
    collectRefs(ast, refs);
    return { source: this.source, ast, refs };
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new FormulaSyntaxError('计算式不完整，缺少操作数', this.source.length);
    this.pos += 1;
    return t;
  }
  private acceptOp(op: string): boolean {
    const t = this.peek();
    if (t && t.kind === 'op' && t.value === op) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private parseExpr(): AstNode {
    let left = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t && t.kind === 'op' && (t.value === '+' || t.value === '-')) {
        this.pos += 1;
        const right = this.parseTerm();
        left = { kind: 'binary', op: t.value as '+' | '-', left, right };
      } else return left;
    }
  }

  private parseTerm(): AstNode {
    let left = this.parseFactor();
    for (;;) {
      const t = this.peek();
      if (t && t.kind === 'op' && (t.value === '*' || t.value === '/')) {
        this.pos += 1;
        const right = this.parseFactor();
        left = { kind: 'binary', op: t.value as '*' | '/', left, right };
      } else return left;
    }
  }

  private parseFactor(): AstNode {
    const t = this.peek();
    if (t && t.kind === 'op' && (t.value === '-' || t.value === '+')) {
      this.pos += 1;
      return { kind: 'unary', op: t.value as '-' | '+', arg: this.parseFactor() };
    }
    return this.parseAtom();
  }

  private parseAtom(): AstNode {
    const t = this.next();
    if (t.kind === 'op' && t.value === '(') {
      const node = this.parseExpr();
      const close = this.next();
      if (close.value !== ')') throw new FormulaSyntaxError('缺少右括号 ")"', close.pos);
      return node;
    }
    if (t.kind === 'num') {
      const value = Number(t.value);
      if (!Number.isFinite(value)) throw new FormulaSyntaxError(`数字 "${t.value}" 不合法`, t.pos);
      return { kind: 'num', value };
    }
    if (t.kind === 'ident') {
      // 标识符后紧跟 '(' => 窗口聚合调用
      const next = this.peek();
      if (next && next.kind === 'op' && next.value === '(') {
        if (!WINDOW_FNS.has(t.value)) {
          throw new FormulaSyntaxError(`未知函数 "${t.value}"，仅支持 avg / max / min / last`, t.pos);
        }
        return this.parseCall(t.value as WindowFn, t.pos);
      }
      this.assertKnown(t.value, t.pos);
      return { kind: 'ref', id: t.value };
    }
    throw new FormulaSyntaxError(`此处应为数字、指标或括号，却得到 "${t.value}"`, t.pos);
  }

  private parseCall(fn: WindowFn, fnPos: number): AstNode {
    this.next(); // 吃掉 '('
    const refTok = this.next();
    if (refTok.kind !== 'ident') throw new FormulaSyntaxError(`${fn}() 的第一个参数必须是指标 id`, refTok.pos);
    if (WINDOW_FNS.has(refTok.value)) throw new FormulaSyntaxError(`${fn}() 不能嵌套聚合函数，第一个参数必须是一路指标`, refTok.pos);
    this.assertKnown(refTok.value, refTok.pos);
    const comma = this.next();
    if (comma.value !== ',') throw new FormulaSyntaxError(`${fn}() 参数之间缺少逗号 ","`, comma.pos);
    const numTok = this.next();
    if (numTok.kind !== 'num') throw new FormulaSyntaxError(`${fn}() 的窗口时长必须是正数`, numTok.pos);
    const amount = Number(numTok.value);
    if (!(amount > 0)) throw new FormulaSyntaxError(`${fn}() 的窗口时长必须大于 0`, numTok.pos);
    // 可选时间单位（默认秒）
    let multiplier = 1000;
    const after = this.peek();
    if (after && after.kind === 'ident') {
      this.pos += 1;
      switch (after.value) {
        case 'ms':
          multiplier = 1;
          break;
        case 's':
          multiplier = 1000;
          break;
        case 'm':
        case 'min':
          multiplier = 60 * 1000;
          break;
        case 'h':
          multiplier = 60 * 60 * 1000;
          break;
        default:
          throw new FormulaSyntaxError(`未知时间单位 "${after.value}"，支持 ms/s/m/h`, after.pos);
      }
    }
    const close = this.next();
    if (close.value !== ')') throw new FormulaSyntaxError(`${fn}() 缺少右括号 ")"`, close.pos);
    const windowMs = Math.round(amount * multiplier);
    if (!(windowMs > 0)) throw new FormulaSyntaxError(`${fn}() 窗口时长超出范围`, fnPos);
    return { kind: 'window', fn, refId: refTok.value, windowMs };
  }

  private assertKnown(id: string, pos: number): void {
    if (this.knownIds && !this.knownIds.has(id)) {
      throw new FormulaSyntaxError(`引用了不存在的指标 "${id}"`, pos);
    }
  }
}

function collectRefs(node: AstNode, out: string[]): void {
  switch (node.kind) {
    case 'num':
      return;
    case 'ref':
      if (!out.includes(node.id)) out.push(node.id);
      return;
    case 'unary':
      collectRefs(node.arg, out);
      return;
    case 'binary':
      collectRefs(node.left, out);
      collectRefs(node.right, out);
      return;
    case 'window':
      if (!out.includes(node.refId)) out.push(node.refId);
      return;
  }
}

/** 解析计算式；knownIds 给定时，引用集合外的指标直接在定义阶段拦下。 */
export function parseFormula(source: string, knownIds?: Set<string>): ParsedFormula {
  return new Parser(tokenize(source), source, knownIds).parse();
}

/** 仅提取引用（语法仍需合法；不校验指标是否存在）。 */
export function extractReferences(source: string): string[] {
  return parseFormula(source).refs;
}

// ---------------- 求值 ----------------

export interface EvalContext {
  /**
   * 瞬时引用的当前拍取值。返回 undefined 表示该指标本拍没有新值
   * （源被关闭 / 采集中断 / 上游派生本拍异常），调用方据此拒绝拿旧值凑算。
   */
  valueAt: (id: string) => number | undefined;
  /**
   * 窗口内（半开区间 (ts-windowMs, ts]）该指标真实留存点的取值，按时间升序。
   * 空数组同样视为“当前无数据”。
   */
  windowValues: (id: string, windowMs: number) => number[];
  /** 指标 id -> 展示名，用于写清楚异常原因 */
  nameOf?: (id: string) => string;
}

function label(id: string, nameOf?: (id: string) => string): string {
  const name = nameOf?.(id);
  return name && name !== id ? `「${name}」(${id})` : id;
}

function aggregate(fn: WindowFn, values: number[]): number {
  if (values.length === 0) throw new FormulaEvalError('no_data', '窗口内没有数据点');
  switch (fn) {
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'max':
      return Math.max(...values);
    case 'min':
      return Math.min(...values);
    case 'last':
      return values[values.length - 1];
  }
}

export function evaluateNode(node: AstNode, ctx: EvalContext): number {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'ref': {
      const v = ctx.valueAt(node.id);
      if (v === undefined || Number.isNaN(v)) {
        throw new FormulaEvalError('no_data', `依赖的指标 ${label(node.id, ctx.nameOf)} 当前无数据（数据源可能已关闭或采集中断），不使用旧值凑算`);
      }
      return v;
    }
    case 'unary':
      return node.op === '-' ? -evaluateNode(node.arg, ctx) : evaluateNode(node.arg, ctx);
    case 'binary': {
      const left = evaluateNode(node.left, ctx);
      const right = evaluateNode(node.right, ctx);
      if (node.op === '/' && right === 0) {
        throw new FormulaEvalError('div_zero', '除数为 0');
      }
      switch (node.op) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return left / right;
      }
      break;
    }
    case 'window': {
      // 新鲜度闸门：被聚合的源本拍必须在正常产出（table 里有当前值），
      // 源一旦关闭/中断，窗口聚合立即标异常，而不是继续拿窗内旧值。
      const fresh = ctx.valueAt(node.refId);
      if (fresh === undefined || Number.isNaN(fresh)) {
        throw new FormulaEvalError('no_data', `依赖的指标 ${label(node.refId, ctx.nameOf)} 当前无数据（数据源可能已关闭或采集中断），窗口聚合不使用旧值凑算`);
      }
      const values = ctx.windowValues(node.refId, node.windowMs);
      return aggregate(node.fn, values);
    }
  }
  // 理论上不可达
  throw new FormulaEvalError('not_finite', '无法识别的表达式节点');
}

export function evaluateFormula(parsed: ParsedFormula, ctx: EvalContext): number {
  const v = evaluateNode(parsed.ast, ctx);
  if (!Number.isFinite(v)) throw new FormulaEvalError('not_finite', '计算结果不是有限数值');
  return v;
}
