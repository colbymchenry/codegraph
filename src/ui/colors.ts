/**
 * Whether human-format CLI output should include ANSI color codes (#1281).
 *
 * Follows https://no-color.org and common CLI convention:
 * - `--no-color` anywhere on the command line disables color
 * - a non-empty `NO_COLOR` environment variable disables color
 * - otherwise color is only enabled when stdout is a TTY, so piped /
 *   redirected / agent-captured output is always escape-free
 *
 * `--json` output was already escape-free; this gate covers the human format,
 * which is the most token-efficient shape for agent consumers.
 */
export function colorEnabled(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTTY: boolean = process.stdout.isTTY === true,
): boolean {
  if (argv.includes('--no-color')) return false;
  // Per no-color.org, NO_COLOR disables color when present and non-empty.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  return stdoutIsTTY;
}
