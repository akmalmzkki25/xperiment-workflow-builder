import type { Ast } from './ast.js';
import type { ExpressionContext } from './context.js';
import { ExpressionEvalError } from './errors.js';
import { FUNCTIONS } from './functions.js';

// Re-exported so every existing import specifier keeps working.
export type { ExpressionContext } from './context.js';

/** The closed set of readable roots. Nothing writes into the context. */
export const CONTEXT_ROOTS: ReadonlySet<string> = new Set(['trigger', 'nodes', 'execution', 'loop']);

const ROOTS = CONTEXT_ROOTS;

export function evaluate(ast: Ast, ctx: ExpressionContext): unknown {
  switch (ast.type) {
    case 'lit':
      return ast.value;
    case 'chain': {
      const root = ast.parts[0]!;
      if (!ROOTS.has(root)) throw new ExpressionEvalError(`Unknown context root '${root}'`);
      let cur: unknown = (ctx as unknown as Record<string, unknown>)[root];
      for (const part of ast.parts.slice(1)) {
        if (cur === null || cur === undefined) return null;
        if (typeof cur !== 'object') return null;
        cur = (cur as Record<string, unknown>)[part];
      }
      return cur === undefined ? null : cur;
    }
    case 'call': {
      const fn = FUNCTIONS[ast.name];
      if (!fn) throw new ExpressionEvalError(`Unknown function '${ast.name}'`);
      return fn(
        ast.args.map((a) => evaluate(a, ctx)),
        ctx,
      );
    }
    case 'unary': {
      const v = evaluate(ast.operand, ctx);
      if (ast.op === '!') return !truthy(v);
      if (typeof v !== 'number') {
        throw new ExpressionEvalError(`Unary '-' requires a number, got ${typeof v}`);
      }
      return finite(-v);
    }
    case 'cond':
      // Only the taken branch is evaluated, so `x != null ? x.y : 'none'` is safe.
      return truthy(evaluate(ast.test, ctx)) ? evaluate(ast.consequent, ctx) : evaluate(ast.alternate, ctx);
    case 'binary': {
      if (ast.op === '&&') {
        const l = evaluate(ast.left, ctx);
        return truthy(l) ? truthy(evaluate(ast.right, ctx)) : false;
      }
      if (ast.op === '||') {
        const l = evaluate(ast.left, ctx);
        return truthy(l) ? true : truthy(evaluate(ast.right, ctx));
      }
      if (ast.op === '??') {
        const l = evaluate(ast.left, ctx);
        return l === null || l === undefined ? evaluate(ast.right, ctx) : l;
      }
      const l = evaluate(ast.left, ctx);
      const r = evaluate(ast.right, ctx);
      switch (ast.op) {
        case '==':
          return l === r;
        case '!=':
          return l !== r;
        case '+':
          // Two strings concatenate; two numbers add. A mixed pair throws rather than
          // coercing, so there is exactly one story: convert it yourself.
          if (typeof l === 'string' && typeof r === 'string') return l + r;
          return arith('+', l, r);
        case '-':
        case '*':
        case '/':
        case '%':
          return arith(ast.op, l, r);
        default:
          if (typeof l === 'number' && typeof r === 'number') return compare(ast.op, l, r);
          if (typeof l === 'string' && typeof r === 'string') return compare(ast.op, l, r);
          throw new ExpressionEvalError(
            `Operator '${ast.op}' requires two numbers or two strings, got ${typeof l} and ${typeof r}`,
          );
      }
    }
  }
}

type ArithOp = '+' | '-' | '*' | '/' | '%';

function arith(op: ArithOp, l: unknown, r: unknown): number {
  if (typeof l !== 'number' || typeof r !== 'number') {
    const shape = op === '+' ? 'two numbers or two strings' : 'two numbers';
    throw new ExpressionEvalError(`Operator '${op}' requires ${shape}, got ${typeof l} and ${typeof r}`);
  }
  if ((op === '/' || op === '%') && r === 0) {
    throw new ExpressionEvalError(op === '/' ? 'Division by zero' : 'Modulo by zero');
  }
  switch (op) {
    case '+':
      return finite(l + r);
    case '-':
      return finite(l - r);
    case '*':
      return finite(l * r);
    case '/':
      return finite(l / r);
    case '%':
      return finite(l % r);
  }
}

/**
 * Keeps NaN and +/-Infinity out of the value space. JSON.stringify(Infinity) is null,
 * so a non-finite value would corrupt a stored output payload silently.
 */
function finite(n: number): number {
  if (!Number.isFinite(n)) throw new ExpressionEvalError('Arithmetic overflow');
  return n;
}

function compare(op: '<' | '<=' | '>' | '>=', l: number | string, r: number | string): boolean {
  switch (op) {
    case '<':
      return l < r;
    case '<=':
      return l <= r;
    case '>':
      return l > r;
    case '>=':
      return l >= r;
  }
}

function truthy(v: unknown): boolean {
  return Boolean(v);
}
