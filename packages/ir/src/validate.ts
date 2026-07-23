import { ExpressionParseError, parseExpression } from '@xperiment/expressions';
import { validateGraph } from './graph.js';
import type { RegistryLike } from './registryLike.js';
import { workflowIrSchema } from './schema.js';
import type { WorkflowIR } from './types.js';

export interface ValidationFinding {
  layer: 'schema' | 'graph' | 'parameters' | 'expressions';
  code: string;
  message: string;
  nodeId?: string;
  path?: string;
  position?: number;
}

export interface ValidationResult {
  valid: boolean;
  findings: ValidationFinding[];
  ir?: WorkflowIR;
}

const EXPR_RE = /\{\{([\s\S]+?)\}\}/g;

function* walkStrings(value: unknown, path: string): Generator<{ path: string; text: string }> {
  if (typeof value === 'string') {
    yield { path, text: value };
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) yield* walkStrings(value[i], `${path}[${i}]`);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* walkStrings(v, path ? `${path}.${k}` : k);
  }
}

export function validateWorkflow(raw: unknown, opts: { registry: RegistryLike }): ValidationResult {
  // Layer 1: schema
  const parsed = workflowIrSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      findings: parsed.error.issues.map((i) => ({
        layer: 'schema' as const,
        code: 'schema_violation',
        message: i.message,
        path: i.path.join('.'),
      })),
    };
  }
  const ir = parsed.data as WorkflowIR;
  const findings: ValidationFinding[] = [];

  // Layer 2: graph
  findings.push(...validateGraph(ir, opts.registry));

  // Layer 3: parameters
  for (const node of ir.nodes) {
    const info = opts.registry.get(node.type);
    if (!info) {
      findings.push({
        layer: 'parameters',
        code: 'unknown_node_type',
        message: `Unknown node type '${node.type}'`,
        nodeId: node.id,
      });
      continue;
    }
    const r = info.paramsSchema.safeParse(node.parameters);
    if (!r.success) {
      for (const issue of r.error.issues) {
        findings.push({
          layer: 'parameters',
          code: 'invalid_parameters',
          message: issue.message,
          nodeId: node.id,
          path: issue.path.join('.'),
        });
      }
    }
  }

  // Layer 4: expressions
  for (const node of ir.nodes) {
    for (const { path, text } of walkStrings(node.parameters, '')) {
      for (const m of text.matchAll(EXPR_RE)) {
        try {
          parseExpression(m[1]!.trim());
        } catch (e) {
          findings.push({
            layer: 'expressions',
            code: 'invalid_expression',
            message: e instanceof Error ? e.message : String(e),
            nodeId: node.id,
            path,
            ...(e instanceof ExpressionParseError ? { position: e.position } : {}),
          });
        }
      }
    }
  }

  return { valid: findings.length === 0, findings, ir };
}
