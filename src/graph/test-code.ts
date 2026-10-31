/**
 * Whether a symbol is test code — one answer for the surfaces that mark
 * implementors, callers or dead-code candidates as tests.
 *
 * Three readings, cheapest first: the file path (`isTestFile`), the qualified
 * name (a nested `Tests` class, a `tests` module the extractor names), and, for
 * Rust, the source itself: `#[cfg(test)] mod tests { … }` lives inside `src/`,
 * and the extractor neither mints a node for the module nor prefixes the names
 * declared in it, so a mock there is invisible to the first two readings.
 */

import type { Node } from '../types';
import { blankRustCode } from '../resolution/rust-scopes';
import { isTestFile } from '../search/query-utils';
import { isTestScope } from './dead-code';

/** `#[cfg(test)]`, or `test` as one condition of `#[cfg(all(…))]`. `not(test)` is neither. */
const CFG_TEST = /^#\[cfg\((?:test\)|all\((?:.*,\s*)?test\s*[,)])/;

/** `node` is test code. `source` is the node's file, read when the caller has it. */
export function isTestCode(node: Node, source?: string): boolean {
  if (isTestFile(node.filePath)) return true;
  if (node.qualifiedName && isTestScope(node.qualifiedName)) return true;
  return node.language === 'rust' && source !== undefined && inCfgTestModule(source, node.startLine);
}

/**
 * `line` (1-based) is inside a module declared under a test `cfg`. The
 * module's extent is its brace block, counted with comments and the contents
 * of strings and characters blanked, which is as far as a module-level reading
 * needs to go.
 */
export function inCfgTestModule(source: string, line: number): boolean {
  const lines = blankRustCode(source).split('\n');
  let armed = false;
  for (let i = 0; i < lines.length && i < line; i++) {
    const text = lines[i]!.trim();
    if (CFG_TEST.test(text)) { armed = true; continue; }
    if (!armed) continue;
    if (text.startsWith('#[') || text === '') continue;
    armed = false;
    if (!/^(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/.test(text)) continue;
    // Walk the block: it ends on the line where its braces close.
    let depth = 0;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]!) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (depth <= 0) {
        if (line - 1 > i && line - 1 <= j) return true;
        i = j;
        break;
      }
    }
  }
  return false;
}
