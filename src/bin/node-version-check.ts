/**
 * Node.js version compatibility check.
 *
 * CodeGraph supports Node.js {@link MIN_NODE_MAJOR} and later, with no upper
 * bound. This module owns the user-facing banner the CLI bootstrap shows before
 * exiting on a Node major below that floor. Kept side-effect-free so it's safe
 * to import from tests without triggering CLI bootstrap.
 */

/**
 * Lowest supported Node.js major version. Matches the `engines` floor in
 * package.json. Below this, CodeGraph relies on language features / native APIs
 * that aren't present, and the combination is untested. `engines` alone only
 * *warns* on install (unless the user set `engine-strict`), so the CLI bootstrap
 * also hard-blocks here to actually enforce the floor.
 */
export const MIN_NODE_MAJOR = 20;

/**
 * Build the bordered banner shown when CodeGraph detects a Node.js major below
 * {@link MIN_NODE_MAJOR}. Pinned via unit test so the recovery commands and the
 * override env var can't be silently stripped by future edits.
 *
 * Uses ASCII glyphs to stay readable on Windows OEM-codepage consoles
 * (see ../ui/glyphs.ts for the rationale).
 */
export function buildNodeTooOldBanner(nodeVersion: string): string {
  const sep = '-'.repeat(72);
  return [
    sep,
    `[CodeGraph] Unsupported Node.js version: ${nodeVersion}`,
    sep,
    `CodeGraph requires Node.js ${MIN_NODE_MAJOR} or newer. Older versions lack`,
    'language features and native APIs CodeGraph depends on, and are not',
    'tested or supported.',
    '',
    'Fix: install Node.js 22 LTS:',
    '  nvm install 22 && nvm use 22                          # nvm',
    '  brew install node@22 && brew link --overwrite --force node@22  # Homebrew',
    '',
    'To override (NOT recommended - unsupported):',
    '  CODEGRAPH_ALLOW_UNSAFE_NODE=1 codegraph ...',
    sep,
  ].join('\n');
}
