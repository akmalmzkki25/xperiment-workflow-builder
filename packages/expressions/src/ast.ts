export type BinaryOp =
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '&&'
  | '||'
  | '??'
  | '+'
  | '-'
  | '*'
  | '/'
  | '%';

export type UnaryOp = '!' | '-';

export type Ast =
  | { type: 'lit'; value: string | number | boolean | null }
  | { type: 'chain'; parts: string[] }
  | { type: 'call'; name: string; args: Ast[] }
  | { type: 'unary'; op: UnaryOp; operand: Ast }
  | { type: 'binary'; op: BinaryOp; left: Ast; right: Ast }
  | { type: 'cond'; test: Ast; consequent: Ast; alternate: Ast };
