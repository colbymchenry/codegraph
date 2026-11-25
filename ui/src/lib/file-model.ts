/**
 * The File view's models (design spec §3.4, task CG-46).
 *
 * Pure functions over `/api/file`'s payload, kept out of the components so the
 * decisions below can be tested without a browser.
 *
 * The one decision worth stating up front: **the import rails are drawn from
 * `dependencies` / `dependents`, not from `imports` / `importedBy`.** They are
 * different questions. An `imports` edge means an import STATEMENT resolved to
 * a symbol in another file; `getFileDependencies` follows every cross-file edge
 * — the calls, the type references, the instantiations. On this repo
 * `src/graph/traversal.ts` imports two files and depends on four: it reaches
 * `src/resolution/lru-cache.ts` through a call, with no import naming it. A
 * rail labelled "Imports 2" would be quietly wrong about what breaking that
 * file would touch, which is the only reason to look at this screen.
 *
 * The import rows are not discarded — they are merged in, because they carry
 * the SYMBOL names, which is the detail a bare file path cannot give.
 */

import type { WireFilePayload, WireImportRow, WireOutlineEntry } from './api';
import { basename } from './symbol-model';

export { basename } from './symbol-model';

/** Kinds that are dimmed in an outline: data, not behaviour. */
const QUIET_KINDS = new Set(['property', 'field', 'enum_member', 'variable', 'constant']);

/** Above this many rows the outline is windowed rather than fully rendered. */
export const OUTLINE_VIRTUAL_THRESHOLD = 250;

/** Fixed row height the windowed outline measures with — pinned in the CSS. */
export const OUTLINE_ROW_HEIGHT = 28;

/* ----------------------------------------------------------------- rails -- */

export interface RailSymbol {
  id: string;
  name: string;
  kind: string;
  line: number;
}

export interface FileRailRow {
  path: string;
  /** Test or fixture code — sorted below production rows and marked. */
  test: boolean;
  /** An import statement names this file, so its symbols are known. */
  imported: boolean;
  /** Symbols the import edges name. Empty is normal — see `namedSymbols`. */
  symbols: RailSymbol[];
  symbolCount: number;
}

/** An import that resolved to nothing indexed: a package, a runtime builtin. */
export interface OutsideRow {
  name: string;
  /** Every line importing it — the same package is often imported twice. */
  lines: number[];
}

export interface FileRailModel {
  rows: FileRailRow[];
  /** Files in the index — equal to `rows.length`, and to the engine's count. */
  total: number;
  testCount: number;
  outside: OutsideRow[];
}

/**
 * Symbols worth naming on a rail row.
 *
 * An `importedBy` edge's far end is the *importing file's own file node*, so
 * its "symbols" are a single entry repeating the path already in the row. Only
 * real symbols say anything, so file nodes are dropped and a row with none
 * shows no count rather than a misleading `1`.
 */
function namedSymbols(row: WireImportRow | undefined): RailSymbol[] {
  if (!row) return [];
  return row.symbols.filter((s) => s.kind !== 'file');
}

/**
 * One rail: every file the engine says this one is related to, in reading
 * order, with the import detail merged in.
 *
 * Production files first, then tests, each alphabetically. Tests are last
 * because a file's test callers answer a different question than its callers —
 * and on a hub like `src/types.ts` they would otherwise be most of the rail.
 */
export function buildFileRail(
  paths: readonly string[],
  importRows: readonly WireImportRow[],
  unresolved: ReadonlyArray<{ name: string; line: number }> = []
): FileRailModel {
  const detail = new Map(importRows.map((row) => [row.file, row]));

  const rows: FileRailRow[] = [...new Set(paths)].map((path) => {
    const row = detail.get(path);
    const symbols = namedSymbols(row);
    return {
      path,
      test: row?.test ?? looksLikeTest(path),
      imported: row !== undefined,
      symbols,
      symbolCount: symbols.length,
    };
  });

  rows.sort(
    (a, b) => Number(a.test) - Number(b.test) || a.path.localeCompare(b.path)
  );

  const byName = new Map<string, number[]>();
  for (const item of unresolved) {
    const lines = byName.get(item.name);
    if (lines) lines.push(item.line);
    else byName.set(item.name, [item.line]);
  }

  return {
    rows,
    total: rows.length,
    testCount: rows.filter((row) => row.test).length,
    outside: [...byName.entries()]
      .map(([name, lines]) => ({ name, lines: [...lines].sort((a, b) => a - b) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Whether a path looks like test code, for the rows no import edge described.
 *
 * The server's `isTestFile` reads more than a path — this is the fallback for
 * a dependency that arrived as a bare string, and it errs towards *not* calling
 * something a test: a production file sorted with the tests is a worse mistake
 * than a test file sorted with production.
 */
export function looksLikeTest(path: string): boolean {
  return (
    /(^|\/)(__tests__|__mocks__|__fixtures__|tests?|spec|fixtures)(\/|$)/.test(path) ||
    /\.(test|spec)\.[a-z0-9]+$/i.test(path)
  );
}

/* --------------------------------------------------------------- outline -- */

export interface OutlineEntryRow {
  entry: WireOutlineEntry;
  /** Indent step: 0 top level, 1 a member, 2 a member of a member. */
  indent: number;
  /** Data rather than behaviour — drawn quieter. */
  dimmed: boolean;
}

/**
 * The file's symbols in source order, nested under their container.
 *
 * The server has already sorted by line and resolved each entry's parent, so
 * this only decides how a row is drawn. Depth is clamped: a deeply nested
 * closure would otherwise indent itself off the right edge of the column.
 */
export function buildFileOutline(payload: WireFilePayload): OutlineEntryRow[] {
  return payload.outline.items.map((entry) => ({
    entry,
    indent: Math.min(entry.depth, 3),
    dimmed: QUIET_KINDS.has(entry.kind),
  }));
}

/* ---------------------------------------------------------------- header -- */

/** `24.2 KB` — sizes on this screen are for scale, never for accounting. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The line under the file name: `typescript · 24.2 KB · 23 symbols · generated`.
 *
 * The symbol count is the outline's `total`, not the file record's node count —
 * the record counts the file node and its import declarations, neither of which
 * is a row, and a header that disagrees with the list under it is a bug the
 * reader has no way to resolve.
 */
export function fileMetaLine(payload: WireFilePayload): string {
  const parts = [payload.file.language, formatBytes(payload.file.size)];
  parts.push(`${payload.outline.total} ${payload.outline.total === 1 ? 'symbol' : 'symbols'}`);
  if (payload.file.generated) parts.push('generated');
  if (payload.file.test) parts.push('test');
  return parts.join(' · ');
}

/** The document title / heading for a file: its basename. */
export function fileTitle(path: string): string {
  return basename(path);
}
