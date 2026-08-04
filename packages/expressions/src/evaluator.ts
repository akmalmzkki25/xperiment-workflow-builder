import type { Ast } from './ast.js';
import { ExpressionEvalError } from './errors.js';
import { FUNCTIONS } from './functions.js';

export interface ExpressionContext {
  trigger: { body: unknown };
  nodes: Record<string, { output: unknown }>;
  execution: { id: string };
  /** Present only while a loop body node is running. */
  loop?: { index: number; item: unknown };
}

const ROOTS = new Set(['trigger', 'nodes', 'execution', 'loop']);

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
      return fn(ast.args.map((a) => evaluate(a, ctx)));
    }
    case 'unary':
      return !truthy(evaluate(ast.operand, ctx));
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
      if (ast.op === '==') return l === r;
      if (ast.op === '!=') return l !== r;
      if (typeof l === 'number' && typeof r === 'number') return compare(ast.op, l, r);
      if (typeof l === 'string' && typeof r === 'string') return compare(ast.op, l, r);
      throw new ExpressionEvalError(
        `Operator '${ast.op}' requires two numbers or two strings, got ${typeof l} and ${typeof r}`,
      );
    }
  }
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
