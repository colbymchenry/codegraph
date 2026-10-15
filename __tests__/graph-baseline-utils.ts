/**
 * Natural-key snapshot of an indexed graph, for the committed end-to-end baseline.
 *
 * The kernel↔wasm parity suite compares two live extractors against each other; this compares one
 * extractor against a file in the repository. That is the only check that can see a relationship
 * *disappear* — parity stays green when both implementations drop the same edge.
 *
 * The normalization is the one `scripts/dump-graph.mjs` uses, and for the same reason: two dumps
 * must differ iff the graphs differ semantically. So the rowids go (`edges.id`,
 * `unresolved_refs.id`), the timestamps go (`nodes.updated_at`, and `files.content_hash/size/*_at`,
 * which depend on the machine and the checkout), and `nodes.id` — an internal identifier whose
 * format is not a contract — is replaced with a key derived from what the row *is*:
 * `kind|file_path|name|start_line|start_column`.
 *
 * Not a `.test.ts` file on purpose: it is a helper, and `scripts/test-changed.mjs` walks test files.
 */
import * as path from 'node:path';

/** The four sections, each a sorted list of canonical JSON lines. */
export interface GraphSnapshot {
  nodes: string[];
  edges: string[];
  unresolvedRefs: string[];
  files: string[];
}

/** Columns whose value is a JSON document and must be re-serialized with sorted keys. */
const JSON_COLUMNS = new Set(['metadata', 'candidates', 'decorators', 'type_parameters']);

/**
 * Line endings are a property of the checkout, not of the graph.
 *
 * The fixture's docstrings travel into the graph verbatim, so a Windows working tree (CRLF) and a
 * Linux CI checkout (LF) would produce different snapshots of the same program and the golden
 * would only ever be valid on one of them. Normalizing here — rather than by making the fixture
 * single-line — keeps multi-line comment extraction inside what the baseline covers.
 */
const normalizeEol = (text: string): string => text.replace(/\r\n?/g, '\n');

/**
 * Serialize a value the same way regardless of the order its keys came out of SQLite.
 *
 * A `metadata` object written as `{"confidence":1,"resolvedBy":"import"}` and the same object
 * written in the other key order are the same metadata, and a baseline that treated them as
 * different would fail on a refactor that changed nothing.
 */
function canonical(value: unknown): unknown {
  if (typeof value === 'string') return normalizeEol(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Parse a JSON column if it holds JSON; leave anything else (null, plain text) alone. */
function canonicalCell(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  const text = normalizeEol(value);
  if (!/^[[{"]/.test(text.trim())) return text;
  try {
    return canonical(JSON.parse(text));
  } catch {
    return text;
  }
}

/**
 * Turn the selected rows into a row per line, in the order the caller listed the columns, with
 * JSON columns canonicalized and every other value left as SQLite returned it.
 */
function project(rows: Array<Record<string, unknown>>, columns: string[]): string[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const column of columns) {
      const value = row[column];
      if (JSON_COLUMNS.has(column)) out[column] = canonicalCell(value);
      else if (typeof value === 'string') out[column] = normalizeEol(value);
      else out[column] = value ?? null;
    }
    return JSON.stringify(out);
  });
}

/**
 * Read the graph out of `<projectRoot>/.codegraph/codegraph.db` without touching the engine.
 *
 * Straight SQL on purpose: the baseline exists to pin what the extractor *wrote*, and asking the
 * query layer to describe it would let a query-layer bug hide a storage bug.
 */
export function readGraphSnapshot(projectRoot: string): GraphSnapshot {
  // `require`, not a top-level `import`: vite tries to resolve a dynamic import specifier and this
  // is a builtin it should leave alone. Same reason `__tests__/status-json.test.ts` does it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(projectRoot, '.codegraph', 'codegraph.db'), { readOnly: true });
  try {
    const nodeRows = db
      .prepare(
        `SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line,
                start_column, end_column, docstring, signature, visibility, is_exported,
                is_async, is_static, is_abstract, decorators, type_parameters, return_type
           FROM nodes`
      )
      .all() as Array<Record<string, unknown>>;

    // A natural key is what the row IS, not where it landed. Ties are resolved by a suffix in
    // sorted-id order so the mapping stays a deterministic function of the graph even if two rows
    // describe the same position.
    const keyOfNode = new Map<unknown, string>();
    const baseCounts = new Map<string, number>();
    const sortedNodes = [...nodeRows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const row of sortedNodes) {
      const base = `${row.kind}|${row.file_path}|${row.name}|${row.start_line}|${row.start_column}`;
      baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
    }
    const baseSeen = new Map<string, number>();
    for (const row of sortedNodes) {
      const base = `${row.kind}|${row.file_path}|${row.name}|${row.start_line}|${row.start_column}`;
      const seen = (baseSeen.get(base) ?? 0) + 1;
      baseSeen.set(base, seen);
      keyOfNode.set(row.id, (baseCounts.get(base) ?? 0) > 1 ? `${base}#${seen}` : base);
    }
    const naturalKey = (id: unknown): string => keyOfNode.get(id) ?? `unresolved:${String(id)}`;

    const edgeRows = db
      .prepare(
        `SELECT source, target, kind, metadata, line, col, provenance
           FROM edges`
      )
      .all() as Array<Record<string, unknown>>;

    const refRows = db
      .prepare(
        `SELECT from_node_id, reference_name, reference_kind, line, col, candidates,
                file_path, language, status, name_tail
           FROM unresolved_refs`
      )
      .all() as Array<Record<string, unknown>>;

    const fileRows = db
      .prepare('SELECT path, language, node_count FROM files')
      .all() as Array<Record<string, unknown>>;

    return {
      nodes: project(nodeRows, [
        'kind', 'name', 'qualified_name', 'file_path', 'language', 'start_line', 'end_line',
        'start_column', 'end_column', 'docstring', 'signature', 'visibility', 'is_exported',
        'is_async', 'is_static', 'is_abstract', 'decorators', 'type_parameters', 'return_type',
      ]).sort(),
      edges: project(
        edgeRows.map((row) => ({
          ...row,
          source: naturalKey(row.source),
          target: naturalKey(row.target),
        })),
        ['source', 'target', 'kind', 'metadata', 'line', 'col', 'provenance']
      ).sort(),
      unresolvedRefs: project(
        refRows.map((row) => ({ ...row, from_node_id: naturalKey(row.from_node_id) })),
        [
          'from_node_id', 'reference_name', 'reference_kind', 'line', 'col', 'candidates',
          'file_path', 'language', 'status', 'name_tail',
        ]
      ).sort(),
      files: project(fileRows, ['path', 'language', 'node_count']).sort(),
    };
  } finally {
    db.close();
  }
}

/**
 * The snapshot as the text that gets committed.
 *
 * Sorted keys and a trailing newline so the file is diff-stable and reads as a normal JSON
 * document: a reviewer has to be able to see what changed, which is the whole point of committing
 * it rather than hashing it.
 */
export function serializeSnapshot(snapshot: GraphSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
