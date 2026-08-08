import type { Ast, BinaryOp } from './ast.js';
import { ExpressionParseError } from './errors.js';
import { FUNCTION_NAMES } from './functions.js';
import { tokenize, type Token } from './tokenizer.js';

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Each grouping level costs about ten stack frames, so without a cap well under a
 * kilobyte of source overflows the stack — and a RangeError is reported as an
 * internal_error rather than an expression error.
 */
const MAX_NESTING = 64;

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) {
      throw new ExpressionParseError(`Expected '${value}'`, t.pos);
    }
  }
  private atPunct(value: string): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.value === value;
  }

  parse(): Ast {
    const ast = this.conditional();
    const t = this.peek();
    if (t.kind !== 'eof') throw new ExpressionParseError(`Unexpected '${t.value}'`, t.pos);
    return ast;
  }

  private binaryLevel(ops: BinaryOp[], nextLevel: () => Ast): Ast {
    let left = nextLevel();
    while (this.peek().kind === 'punct' && (ops as string[]).includes(this.peek().value)) {
      const op = this.next().value as BinaryOp;
      left = { type: 'binary', op, left, right: nextLevel() };
    }
    return left;
  }

  /** Loosest level, and right-associative: `a ? b : c ? d : e` groups to the right. */
  private conditional(): Ast {
    // Every nesting construct — parens, call arguments, ternary branches — enters here,
    // so one counter bounds them all.
    if (this.depth >= MAX_NESTING) {
      throw new ExpressionParseError('Expression is nested too deeply', this.peek().pos);
    }
    this.depth += 1;
    try {
      const test = this.nullish();
      if (!this.atPunct('?')) return test;
      this.next();
      const consequent = this.conditional();
      this.expectPunct(':');
      return { type: 'cond', test, consequent, alternate: this.conditional() };
    } finally {
      this.depth -= 1;
    }
  }

  private nullish(): Ast {
    return this.binaryLevel(['??'], () => this.logicalOr());
  }
  private logicalOr(): Ast {
    return this.binaryLevel(['||'], () => this.logicalAnd());
  }
  private logicalAnd(): Ast {
    return this.binaryLevel(['&&'], () => this.equality());
  }
  private equality(): Ast {
    return this.binaryLevel(['==', '!='], () => this.relational());
  }
  private relational(): Ast {
    return this.binaryLevel(['<', '<=', '>', '>='], () => this.additive());
  }
  private additive(): Ast {
    return this.binaryLevel(['+', '-'], () => this.multiplicative());
  }
  private multiplicative(): Ast {
    return this.binaryLevel(['*', '/', '%'], () => this.unary());
  }

  private unary(): Ast {
    if (this.atPunct('!')) {
      this.next();
      return { type: 'unary', op: '!', operand: this.unary() };
    }
    if (this.atPunct('-')) {
      this.next();
      return { type: 'unary', op: '-', operand: this.unary() };
    }
    return this.primary();
  }

  private primary(): Ast {
    const t = this.peek();
    if (t.kind === 'number') {
      this.next();
      return { type: 'lit', value: Number(t.value) };
    }
    if (t.kind === 'string') {
      this.next();
      return { type: 'lit', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '(') {
      this.next();
      // conditional(), not nullish(): a parenthesised ternary must parse.
      const inner = this.conditional();
      this.expectPunct(')');
      return inner;
    }
    if (t.kind === 'ident') {
      if (t.value === 'true' || t.value === 'false') {
        this.next();
        return { type: 'lit', value: t.value === 'true' };
      }
      if (t.value === 'null') {
        this.next();
        return { type: 'lit', value: null };
      }
      if (this.tokens[this.pos + 1]?.kind === 'punct' && this.tokens[this.pos + 1]?.value === '(') {
        const name = this.next().value;
        if (!FUNCTION_NAMES.has(name)) {
          throw new ExpressionParseError(`Unknown function '${name}'`, t.pos);
        }
        this.expectPunct('(');
        const args: Ast[] = [];
        if (!this.atPunct(')')) {
          // conditional() so a ternary can be passed as an argument.
          args.push(this.conditional());
          while (this.atPunct(',')) {
            this.next();
            args.push(this.conditional());
          }
        }
        this.expectPunct(')');
        return { type: 'call', name, args };
      }
      return this.chain();
    }
    throw new ExpressionParseError(`Unexpected '${t.value || 'end of input'}'`, t.pos);
  }

  private chain(): Ast {
    const first = this.next();
    this.assertAllowedIdent(first.value, first.pos);
    const parts = [first.value];
    for (;;) {
      if (this.atPunct('.')) {
        this.next();
        const t = this.next();
        if (t.kind !== 'ident') throw new ExpressionParseError('Expected property name', t.pos);
        this.assertAllowedIdent(t.value, t.pos);
        parts.push(t.value);
      } else if (this.atPunct('[')) {
        this.next();
        const t = this.next();
        if (t.kind === 'number') {
          // Literal whole-number indices only. A dynamic index would put an Ast into a
          // value position, and the closed value space is what lets an unknown function
          // stay a *parse* error — which is what the IR validator relies on.
          if (!/^[0-9]+$/.test(t.value)) {
            throw new ExpressionParseError('Array index must be a whole number', t.pos);
          }
          parts.push(t.value);
        } else if (t.kind === 'string') {
          this.assertAllowedIdent(t.value, t.pos);
          parts.push(t.value);
        } else {
          throw new ExpressionParseError('Expected a string key or a whole-number index in brackets', t.pos);
        }
        this.expectPunct(']');
      } else {
        break;
      }
    }
    return { type: 'chain', parts };
  }

  private assertAllowedIdent(name: string, pos: number): void {
    if (FORBIDDEN.has(name)) {
      throw new ExpressionParseError(`Forbidden identifier '${name}'`, pos);
    }
  }
}

export function parseExpression(src: string): Ast {
  return new Parser(tokenize(src)).parse();
}
