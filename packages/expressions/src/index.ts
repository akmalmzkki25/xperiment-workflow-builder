export type { Ast, BinaryOp, UnaryOp } from './ast.js';
export type { ExpressionContext } from './context.js';
export { ExpressionParseError, ExpressionEvalError } from './errors.js';
export { parseExpression } from './parser.js';
export { FUNCTION_NAMES, FUNCTIONS, type Fn } from './functions.js';
export { evaluate, CONTEXT_ROOTS } from './evaluator.js';
export { resolveTemplate } from './template.js';
