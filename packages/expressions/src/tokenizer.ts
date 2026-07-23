import { ExpressionParseError } from './errors.js';

export type TokenKind = 'ident' | 'number' | 'string' | 'punct' | 'eof';
export interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

const PUNCT = ['==', '!=', '<=', '>=', '&&', '||', '??', '(', ')', '[', ']', '.', ',', '<', '>', '!'];

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'ident', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j]!)) j += 1;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j]!)) j += 1;
      }
      tokens.push({ kind: 'number', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && (src[j + 1] === ch || src[j + 1] === '\\')) {
          out += src[j + 1];
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      if (j >= src.length) throw new ExpressionParseError('Unterminated string', i);
      tokens.push({ kind: 'string', value: out, pos: i });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (PUNCT.includes(two)) {
      tokens.push({ kind: 'punct', value: two, pos: i });
      i += 2;
      continue;
    }
    if (PUNCT.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch, pos: i });
      i += 1;
      continue;
    }
    throw new ExpressionParseError(`Unexpected character '${ch}'`, i);
  }
  tokens.push({ kind: 'eof', value: '', pos: src.length });
  return tokens;
}
