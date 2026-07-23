export class ExpressionParseError extends Error {
  constructor(message: string, public readonly position: number) {
    super(`${message} (at position ${position})`);
    this.name = 'ExpressionParseError';
  }
}

export class ExpressionEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionEvalError';
  }
}
