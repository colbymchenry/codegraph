/**
 * Terminal color detection for CLI output (issue #1281).
 *
 * One switch decides whether any codegraph-authored output carries ANSI
 * color codes. Precedence, strongest first:
 *
 *   1. `--no-color` anywhere on the command line   -> off
 *   2. `--color` anywhere on the command line      -> on
 *   3. `NO_COLOR` set and non-empty (no-color.org) -> off
 *   4. `FORCE_COLOR` set and non-empty             -> on ('0'/'false' -> off)
 *   5. stdout is a TTY and TERM != 'dumb'          -> on
 *   6. `CI` set and non-empty                      -> on (CI log viewers render ANSI)
 *   7. otherwise (piped/redirected stdout)         -> off
 *
 * This intentionally tracks the detection @clack/prompts inherits from
 * picocolors closely enough that one run never mixes colored clack frames
 * with uncolored codegraph lines (or vice versa) for the common cases:
 * both honor NO_COLOR, --no-color/--color, FORCE_COLOR, TTY, and CI.
 */
export function ansiColorsEnabled(): boolean {
  if (process.argv.includes('--no-color')) return false;
  if (process.argv.includes('--color')) return true;

  const noColor = process.env.NO_COLOR;
  if (noColor !== undefined && noColor !== '') return false;

  const forceColor = process.env.FORCE_COLOR;
  if (forceColor !== undefined && forceColor !== '') {
    return forceColor !== '0' && forceColor.toLowerCase() !== 'false';
  }

  if (process.stdout.isTTY === true && process.env.TERM !== 'dumb') return true;

  const ci = process.env.CI;
  if (ci !== undefined && ci !== '') return true;

  return false;
}
