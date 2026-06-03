import * as fs from 'fs';

/**
 * Remove the block delimited by `begin` and `end` (inclusive) from `content`.
 * Idempotent. When `begin` is present but `end` is absent, strips from `begin`
 * to end-of-string (preserves compatibility with legacy partial writes).
 * When `end` is present but `begin` is absent, returns content unchanged.
 */
export function stripMarkerBlock(content: string, begin: string, end: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === begin) { inBlock = true; continue; }
    if (trimmed === end && inBlock) { inBlock = false; continue; }
    if (!inBlock) kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Returns true iff every line in `content` is blank or a shebang (`#!` prefix).
 * Call AFTER stripMarkerBlock — marker lines are not "empty" and return false,
 * guarding against incorrect file deletion when a strip was skipped.
 */
export function isEffectivelyEmpty(content: string): boolean {
  return content
    .split('\n')
    .map((l) => l.trim())
    .every((l) => l.length === 0 || l.startsWith('#!'));
}

/** Sets the executable bit (0o755) on `file`. No-op when chmod is unsupported. */
export function chmodExecutable(file: string): void {
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    /* no-op on Windows or when file does not exist */
  }
}
