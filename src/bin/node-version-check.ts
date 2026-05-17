/**
 * Node.js version compatibility check.
 *
 * Current Node 24.x and 25.x releases have a V8 turboshaft WASM JIT
 * Zone allocator bug that reliably crashes CodeGraph with
 * `Fatal process out of memory: Zone` during tree-sitter grammar
 * compilation. This module owns the user-facing banner shown before
 * exit. Kept side-effect-free so it's safe to import from tests without
 * triggering CLI bootstrap.
 */

export const MIN_UNSAFE_NODE_MAJOR = 24;

export function getNodeMajor(nodeVersion: string): number | null {
  const major = Number.parseInt(nodeVersion.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : null;
}

export function isUnsupportedNodeVersion(nodeVersion: string): boolean {
  const major = getNodeMajor(nodeVersion);
  return major !== null && major >= MIN_UNSAFE_NODE_MAJOR;
}

export function shouldBlockUnsupportedNodeVersion(
  nodeVersion: string,
  allowUnsafe: boolean = Boolean(process.env.CODEGRAPH_ALLOW_UNSAFE_NODE)
): boolean {
  return isUnsupportedNodeVersion(nodeVersion) && !allowUnsafe;
}

export function assertSupportedNodeVersion(
  nodeVersion: string = process.versions.node,
  allowUnsafe?: boolean
): void {
  if (shouldBlockUnsupportedNodeVersion(nodeVersion, allowUnsafe)) {
    throw new Error(buildUnsupportedNodeBlockBanner(nodeVersion));
  }
}

/**
 * Build the bordered banner shown when CodeGraph detects an
 * unsupported Node.js major version (currently 24+). Pinned via unit
 * test so the recovery commands and override instructions can't be
 * silently stripped by future edits.
 */
export function buildUnsupportedNodeBlockBanner(nodeVersion: string): string {
  const sep = '─'.repeat(72);
  return [
    sep,
    `[CodeGraph] Unsupported Node.js version: ${nodeVersion}`,
    sep,
    'Current Node.js 24.x and 25.x releases have a V8 WASM JIT',
    '(turboshaft) Zone allocator bug that crashes with',
    '`Fatal process out of memory: Zone` when CodeGraph compiles',
    'tree-sitter grammars. CodeGraph WILL crash on this Node version',
    'mid-indexing. See https://github.com/colbymchenry/codegraph/issues/81',
    '',
    'Fix: install Node.js 22 LTS:',
    '  nvm install 22 && nvm use 22                          # nvm',
    '  brew install node@22 && brew link --overwrite --force node@22  # Homebrew',
    '',
    'To override (NOT recommended — you will likely OOM):',
    '  CODEGRAPH_ALLOW_UNSAFE_NODE=1 codegraph ...',
    sep,
  ].join('\n');
}
