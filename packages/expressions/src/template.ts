import { evaluate, type ExpressionContext } from './evaluator.js';
import { parseExpression } from './parser.js';

const EXPR_RE = /\{\{([\s\S]+?)\}\}/g;
const WHOLE_RE = /^\s*\{\{([\s\S]+?)\}\}\s*$/;

export function resolveTemplate(value: unknown, ctx: ExpressionContext): unknown {
  if (typeof value === 'string') {
    const whole = WHOLE_RE.exec(value);
    if (whole) return evaluate(parseExpression(whole[1]!.trim()), ctx);
    return value.replace(EXPR_RE, (_m, src: string) => {
      const v = evaluate(parseExpression(src.trim()), ctx);
      if (v === null || v === undefined) return '';
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplate(v, ctx));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveTemplate(v, ctx);
    return out;
  }
  return value;
}
