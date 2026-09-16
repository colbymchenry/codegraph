/**
 * Identifier-like string literals — storage keys, CLI flags, event names,
 * config paths — attributed to the symbol whose body contains them, so an
 * explore query naming the literal seeds on its readers and writers instead
 * of degrading to bag-of-words FTS (the literal is never a symbol name).
 *
 * The capture is a regex over the file's source text, not a tree walk: the
 * per-node JS↔WASM crossing is the parse floor (docs/design/native-extraction-kernel.md),
 * and a second walk would pay it again for strings alone. Quotes inside a
 * comment can produce a spurious literal; the predicate below keeps only
 * identifier-shaped values, so prose never qualifies.
 */
import type { Node } from '../types';

/** Distinct literals kept per node; a table of keys beyond this is data, not a seam. */
const MAX_LITERALS_PER_NODE = 32;

/**
 * A value qualifies when it looks like an identifier an agent would quote
 * back verbatim: leading letter or underscore (or a `-`/`--` flag prefix),
 * only identifier, path, and namespace characters, and at least one
 * separator — `bompus_draft_state`, `--start`, `draft.pick`, `api/v1/users`.
 * A plain word (`ready`, `Error`) has no separator and stays out: it would
 * seed on every function that logs it.
 */
export function isSeedLiteral(value: string): boolean {
  return value.length <= 200 && /^-{0,2}[A-Za-z_][A-Za-z0-9_.:/-]{3,}$/.test(value) && /[_.:/-]/.test(value);
}

/**
 * Quoted spans in the query text, plus any bare whitespace-delimited run that
 * qualifies. Deduplicated, query order.
 */
export function seedLiteralsInQuery(query: string): string[] {
  const out = new Set<string>();
  for (const m of query.matchAll(/["'`]([^"'`\s]+)["'`]/g)) {
    const quoted = m[1] ?? '';
    if (isSeedLiteral(quoted)) out.add(quoted);
  }
  for (const run of query.split(/\s+/)) {
    const bare = run.replace(/^[("'`[]+|[)"'`\],.;:?!]+$/g, '');
    if (isSeedLiteral(bare)) out.add(bare);
  }
  return [...out];
}

/** Single-line quoted strings; template literals with `${` interpolation are skipped. */
const STRING_RE = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

/**
 * Attach qualifying literals in `source` to `nodes` (mutated): each literal
 * goes to the innermost non-file node whose source range contains it, else
 * the file node. Both extraction paths expose UTF-16 columns (the native
 * kernel converts its tree-sitter byte columns before emitting nodes).
 */
export function captureLiterals(source: string, nodes: Node[]): void {
  if (nodes.length === 0 || source.length === 0) return;
  const symbols = nodes.filter((n) => n.kind !== 'file' && n.kind !== 'import');
  const fileNode = nodes.find((n) => n.kind === 'file');
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const seen = new Map<string, Set<string>>();
  for (const m of source.matchAll(STRING_RE)) {
    const value = m[2] ?? '';
    if (m[1] === '`' && value.includes('${')) continue;
    if (!isSeedLiteral(value)) continue;
    const line = lineOf(m.index ?? 0);
    const startColumn = (m.index ?? 0) - (lineStarts[line - 1] ?? 0);
    const endColumn = startColumn + m[0].length;
    let owner: Node | undefined;
    for (const n of symbols) {
      if (n.startLine > line || n.endLine < line) continue;
      if (n.startLine === line && n.startColumn > startColumn) continue;
      if (n.endLine === line && n.endColumn < endColumn) continue;
      // A contained range is deeper; on identical ranges the later walker node wins.
      if (!owner || (n.startLine > owner.startLine ||
          (n.startLine === owner.startLine && n.startColumn >= owner.startColumn)) &&
          (n.endLine < owner.endLine ||
          (n.endLine === owner.endLine && n.endColumn <= owner.endColumn))) owner = n;
    }
    owner ??= fileNode;
    if (!owner) continue;
    let set = seen.get(owner.id);
    if (!set) seen.set(owner.id, (set = new Set()));
    if (set.size >= MAX_LITERALS_PER_NODE || set.has(value)) continue;
    set.add(value);
    (owner.literals ??= []).push(value);
  }
}
