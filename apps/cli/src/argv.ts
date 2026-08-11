/**
 * Strip the options terminator the root `pnpm xperiment` script forwards verbatim.
 *
 * The root script is `pnpm --filter @xperiment/cli xperiment --`, and pnpm needs that `--` so it
 * stops claiming the user's flags for itself. But it then reaches `main.ts` as a literal
 * first argument, and commander treats everything after a `--` as an operand rather than
 * an option. The failure is silent and it is not cosmetic: `xperiment prune --dry-run` parsed
 * as a run with no flags and deleted for real.
 *
 * Only a terminator in the FIRST user position is removed, so a deliberate later `--`
 * still separates operands the way the user meant.
 */
export function normalizeArgv(argv: readonly string[]): string[] {
  if (argv[2] !== '--') return [...argv];
  return [...argv.slice(0, 2), ...argv.slice(3)];
}
