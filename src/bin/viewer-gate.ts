/**
 * The browser viewer (`codegraph ui`, alias `web`) ships in the package but is
 * not part of a release yet: it has been exercised on Expo apps, not on API,
 * Laravel, Spring, Angular or Swift projects. Until it launches, both spellings
 * are refused before any startup work unless `CODEGRAPH_UI=1` is set, which
 * keeps it usable for the people testing it. Dependency-free on purpose: the
 * entry point checks this before loading anything else.
 */

/** Setting this to `1` enables the viewer commands. */
export const VIEWER_ENV = 'CODEGRAPH_UI';

const VIEWER_COMMANDS = new Set(['ui', 'web']);
/** The program-level flags, which take no value and may precede the command. */
const PROGRAM_FLAGS = new Set(['--color', '--no-color']);

export function viewerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[VIEWER_ENV] === '1';
}

/**
 * The viewer command these arguments ask for (`ui` or `web`), whether run
 * directly or through `help`, or null when they ask for something else.
 */
export function requestedViewerCommand(args: readonly string[]): string | null {
  const positional = args.filter((arg) => !PROGRAM_FLAGS.has(arg));
  const command = positional[0] === 'help' ? positional[1] : positional[0];
  return command !== undefined && VIEWER_COMMANDS.has(command) ? command : null;
}
