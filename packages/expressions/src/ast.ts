export type BinaryOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||' | '??';

export type Ast =
  | { type: 'lit'; value: string | number | boolean | null }
  | { type: 'chain'; parts: string[] }
  | { type: 'call'; name: string; args: Ast[] }
  | { type: 'unary'; op: '!'; operand: Ast }
  | { type: 'binary'; op: BinaryOp; left: Ast; right: Ast };
