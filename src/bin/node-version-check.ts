/**
 * Node.js version compatibility check.
 *
 * Node 25.x has a V8 turboshaft WASM JIT Zone allocator bug that
 * reliably crashes CodeGraph with `Fatal process out of memory: Zone`
 * during tree-sitter grammar compilation. Node 24.x is supported when
 * the native SQLite backend loads, but its WASM fallback path can hit
 * the same crash class. This module owns the user-facing runtime
 * guards. Kept side-effect-free so it's safe to import from tests
 * without triggering CLI bootstrap.
 */

export const MIN_UNSUPPORTED_NODE_MAJOR = 25;
export const MIN_UNSAFE_WASM_NODE_MAJOR = 24;

export function getNodeMajor(nodeVersion: string): number | null {
  const major = Number.parseInt(nodeVersion.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : null;
}

export function isUnsupportedNodeVersion(nodeVersion: string): boolean {
  const major = getNodeMajor(nodeVersion);
  return major !== null && major >= MIN_UNSUPPORTED_NODE_MAJOR;
}

export function isUnsafeWasmFallbackNodeVersion(nodeVersion: string): boolean {
  const major = getNodeMajor(nodeVersion);
  return major !== null && major >= MIN_UNSAFE_WASM_NODE_MAJOR;
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

export function shouldBlockWasmFallbackForNode(
  nodeVersion: string = process.versions.node,
  allowUnsafe: boolean = Boolean(process.env.CODEGRAPH_ALLOW_UNSAFE_NODE)
): boolean {
  return isUnsafeWasmFallbackNodeVersion(nodeVersion) && !allowUnsafe;
}

export function buildUnsafeWasmFallbackBlockBanner(
  nodeVersion: string,
  nativeError?: string
): string {
  const sep = '-'.repeat(72);
  const lines = [
    sep,
    `[CodeGraph] Unsafe WASM fallback blocked on Node.js ${nodeVersion}`,
    sep,
    'Node.js 24.x can run CodeGraph through the native better-sqlite3',
    'backend, but the WASM SQLite fallback may trigger the V8 WASM JIT',
    '(turboshaft) crash path while loading CodeGraph grammars.',
    '',
    'Fix the native backend, then retry:',
    '  npm rebuild better-sqlite3',
    '  npm install better-sqlite3 --save',
    '',
    'Or use Node.js 22 LTS:',
    '  nvm install 22 && nvm use 22',
    '',
    'To override (NOT recommended - you may OOM):',
    '  CODEGRAPH_ALLOW_UNSAFE_NODE=1 codegraph ...',
  ];
  if (nativeError) {
    lines.push('', `Native load error: ${nativeError}`);
  }
  lines.push(sep);
  return lines.join('\n');
}

/**
 * Build the bordered banner shown when CodeGraph detects an
 * unsupported Node.js major version (currently 25+). Pinned via unit
 * test so the recovery commands and override instructions can't be
 * silently stripped by future edits.
 *
 * Uses ASCII glyphs to stay readable on Windows OEM-codepage consoles
 * (see ../ui/glyphs.ts for the rationale).
 */
export function buildUnsupportedNodeBlockBanner(nodeVersion: string): string {
  const sep = '-'.repeat(72);
  return [
    sep,
    `[CodeGraph] Unsupported Node.js version: ${nodeVersion}`,
    sep,
    'Node.js 25.x has a V8 WASM JIT (turboshaft) Zone allocator bug that',
    'crashes with `Fatal process out of memory: Zone` when CodeGraph',
    'compiles tree-sitter grammars. CodeGraph WILL crash on this Node',
    'version mid-indexing. See https://github.com/colbymchenry/codegraph/issues/81',
    '',
    'Fix: install Node.js 22 LTS:',
    '  nvm install 22 && nvm use 22                          # nvm',
    '  brew install node@22 && brew link --overwrite --force node@22  # Homebrew',
    '',
    'To override (NOT recommended - you will likely OOM):',
    '  CODEGRAPH_ALLOW_UNSAFE_NODE=1 codegraph ...',
    sep,
  ].join('\n');
}
