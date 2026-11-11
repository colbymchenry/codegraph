/**
 * Whether a symbol is test code — one answer for the surfaces that mark
 * implementors, callers or dead-code candidates as tests.
 *
 * Three readings, cheapest first: the file path (`isTestFile`), the qualified
 * name (a nested `Tests` class, a `tests` module the extractor names), and, for
 * Rust, the source itself: `#[cfg(test)] mod tests { … }` lives inside `src/`,
 * and the extractor neither mints a node for the module nor prefixes the names
 * declared in it, so a mock there is invisible to the first two readings. The
 * same holds for the module's out-of-line form, `src/store/tests.rs` behind a
 * `#[cfg(test)] mod tests;` in `src/store.rs`, which only the parent shows.
 */

import type { Node } from '../types';
import { blankRustCode } from '../resolution/rust-scopes';
import { isTestFile } from '../search/query-utils';
import { isTestScope } from './dead-code';

/** `#[cfg(test)]`, or `test` as one condition of `#[cfg(all(…))]`. `not(test)` is neither. */
const CFG_TEST = /^#\[cfg\((?:test\)|all\((?:.*,\s*)?test\s*[,)])/;

/** A project file's source, or undefined when it can't be read. */
export type SourceReader = (filePath: string) => string | undefined;

/** `node` is test code. `readSource` reads project files, for the Rust readings; without it they are skipped. */
export function isTestCode(node: Node, readSource?: SourceReader): boolean {
  if (isTestFile(node.filePath)) return true;
  if (node.qualifiedName && isTestScope(node.qualifiedName)) return true;
  if (node.language !== 'rust' || !readSource) return false;
  const source = readSource(node.filePath);
  if (source !== undefined && inCfgTestModule(source, node.startLine)) return true;
  return inCfgTestFile(node.filePath.replace(/\\/g, '/'), readSource);
}

/**
 * `filePath` (project-relative) is a Rust module file its parent declares
 * under a test `cfg`: `src/store/tests.rs` or `src/store/tests/mod.rs` behind
 * `#[cfg(test)] mod tests;` in `src/store.rs`, `src/store/mod.rs` or a crate
 * root in `src/store/`. A module that such a file declares is test code too.
 * `#[path]` and modules declared inside inline blocks are not followed.
 */
export function inCfgTestFile(filePath: string, readSource: SourceReader, depth = 0): boolean {
  if (depth > 4 || !filePath.endsWith('.rs')) return false;
  const parts = filePath.split('/');
  const base = parts.pop()!;
  if (base === 'lib.rs' || base === 'main.rs') return false;
  const name = base === 'mod.rs' ? parts.pop() : base.slice(0, -3);
  if (!name || parts.length === 0) return false;
  const dir = parts.join('/');
  for (const owner of [`${dir}.rs`, `${dir}/mod.rs`, `${dir}/lib.rs`, `${dir}/main.rs`]) {
    const source = readSource(owner);
    if (source === undefined) continue;
    const declared = rustModDeclaration(source, name);
    if (declared === 'cfg-test') return true;
    if (declared === 'plain' && inCfgTestFile(owner, readSource, depth + 1)) return true;
  }
  return false;
}

/** How `source` declares the out-of-line module `name` at its top level: under a test `cfg`, plainly, or not at all. */
function rustModDeclaration(source: string, name: string): 'cfg-test' | 'plain' | undefined {
  const decl = new RegExp(`^(?:pub(?:\\([^)]*\\))?\\s+)?mod\\s+${name}\\s*;`);
  let armed = false;
  let found: 'plain' | undefined;
  for (const raw of blankRustCode(source).split('\n')) {
    const text = raw.trimEnd();
    // Indented: inside a block, where a `mod x;` loads a file further down.
    if (/^\s/.test(text)) { armed = false; continue; }
    if (CFG_TEST.test(text)) { armed = true; continue; }
    if (text.startsWith('#[') || text === '') continue;
    if (decl.test(text)) {
      if (armed) return 'cfg-test';
      found = 'plain';
    }
    armed = false;
  }
  return found;
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
