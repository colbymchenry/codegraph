/**
 * The read side of `codegraph blast`: every SQL query the walk runs, each an
 * indexed, batched query that reads only the rows the walk reaches. Nothing
 * loads the whole nodes or edges table.
 *
 * Indexes relied on (src/db/schema.sql):
 *   - `idx_nodes_file_line (file_path, start_line)` for the seed lookup;
 *   - `idx_edges_target_kind (target, kind)` for every incoming-edge query;
 *   - the `nodes.id` primary key for node fetches.
 */
import * as fs from 'fs';
import { DatabaseConnection, getDatabasePath } from '../db';
import type { SqliteDatabase } from '../db/sqlite-adapter';
import type { BlastNode } from './blast';
import { candidateEdgeSql } from './suspects';

/** One incoming edge, as the walk consumes it. */
export interface IncomingEdge {
  source: string;
  target: string;
  kind: string;
  /** A call edge the resolver bound by name only (`candidateEdgeSql` in `./suspects`). */
  questionable: boolean;
}

/** The queries `blastRadius` runs. An interface so the walk can be spied on and tested. */
export interface BlastStore {
  /** The `file` node for a path relative to the CodeGraph project root, or null when the file is not indexed. */
  fileNode(path: string): BlastNode | null;
  /** Symbols in `path` whose span overlaps lines `start..end` (inclusive), seed kinds only. */
  symbolsOverlapping(path: string, start: number, end: number): BlastNode[];
  /**
   * Edges of the given kinds pointing AT any of `targetIds`, ordered by target,
   * kind, source, each flagged when it is a questionable call.
   */
  incomingEdges(targetIds: readonly string[], kinds: readonly string[]): IncomingEdge[];
  /** The nodes for `ids`; ids with no node are absent from the result. */
  nodesByIds(ids: readonly string[]): BlastNode[];
  /**
   * Per target id, the file paths of the sources of every incoming edge, of ANY
   * kind. Feeds the area test signal, where a test file that merely contains a
   * reference still counts.
   */
  incomingSourcePaths(targetIds: readonly string[]): Map<string, Set<string>>;
  /** Per target id, the number of incoming edges of any kind (the hub ranking). */
  inDegree(targetIds: readonly string[]): Map<string, number>;
  close(): void;
}

/**
 * Node kinds never offered as seeds. `file` is the fallback seed, chosen
 * separately; `import`/`export` nodes span the import statement itself, and
 * `parameter` nodes sit inside the function they belong to, so either would
 * win the innermost rule over the symbol a reader means. `route` nodes are
 * framework-synthesized, not code a diff edits.
 */
const NON_SEED_KINDS = ['file', 'import', 'export', 'parameter', 'route'] as const;

/**
 * Ids per `IN (...)` list. SQLite's default bound-parameter limit is 32766 on
 * modern builds but 999 on old ones; 500 stays under both with room for the
 * `kind IN (...)` parameters that share the statement.
 */
const MAX_IDS_PER_QUERY = 500;

/** `?, ?, ...` with `n` placeholders, for an `IN (...)` list. */
function placeholders(n: number): string {
  return new Array<string>(n).fill('?').join(', ');
}

/** `xs` split into consecutive slices of at most `size`. */
function chunks<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

interface NodeRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  start_line: number;
  end_line: number;
}

/** A node row as a `BlastNode`, its span written `L<start>-L<end>` as every report field and renderer shows it. */
function toNode(row: NodeRow): BlastNode {
  return { id: row.id, name: row.name, kind: row.kind, path: row.file_path, span: `L${row.start_line}-L${row.end_line}` };
}

const NODE_COLUMNS = 'id, name, kind, file_path, start_line, end_line';

/**
 * Open the CodeGraph index at `root` read-only.
 *
 * Throws when there is no index; callers that want a message instead check
 * `fs.existsSync(getDatabasePath(root))` first (as `runBlast` does).
 */
export function openBlastStore(root: string): BlastStore {
  const dbPath = getDatabasePath(root);
  if (!fs.existsSync(dbPath)) throw new Error(`no CodeGraph index at ${root}`);
  const conn = DatabaseConnection.open(dbPath, { readOnly: true });
  // A statement that fails to prepare (an index from an incompatible schema)
  // must not leave the connection open behind the throw.
  try {
    return storeOver(conn);
  } catch (err) {
    conn.close();
    throw err;
  }
}

/** The store's queries over an open connection; the store's `close` closes it. */
function storeOver(conn: DatabaseConnection): BlastStore {
  const db: SqliteDatabase = conn.getDb();

  const fileStmt = db.prepare(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ? AND kind = 'file'`);
  // Ordered by position, outermost first at a shared start line, so the seed
  // list reads top to bottom.
  const overlapStmt = db.prepare(
    `SELECT ${NODE_COLUMNS} FROM nodes
     WHERE file_path = ? AND start_line <= ? AND end_line >= ?
       AND kind NOT IN (${placeholders(NON_SEED_KINDS.length)})
     ORDER BY start_line, end_line DESC, id`,
  );

  return {
    fileNode(path) {
      // File node ids are `file:<path>` (extraction), so this is a primary-key hit.
      const row = fileStmt.get(`file:${path}`) as NodeRow | undefined;
      return row ? toNode(row) : null;
    },

    symbolsOverlapping(path, start, end) {
      return (overlapStmt.all(path, end, start, ...NON_SEED_KINDS) as NodeRow[]).map(toNode);
    },

    incomingEdges(targetIds, kinds) {
      if (targetIds.length === 0 || kinds.length === 0) return [];
      const out: IncomingEdge[] = [];
      for (const ids of chunks(targetIds, MAX_IDS_PER_QUERY)) {
        const stmt = db.prepare(
          `SELECT source, target, kind, ${candidateEdgeSql('edges')} AS questionable FROM edges
           WHERE target IN (${placeholders(ids.length)}) AND kind IN (${placeholders(kinds.length)})`,
        );
        // SQLite returns the boolean expression as 0/1.
        const rows = stmt.all(...ids, ...kinds) as { source: string; target: string; kind: string; questionable: number }[];
        for (const r of rows) out.push({ source: r.source, target: r.target, kind: r.kind, questionable: Number(r.questionable) === 1 });
      }
      // Sorted once over all chunks (not per statement) so the order is the same
      // whether the frontier needed one query or several.
      return out.sort(
        (a, b) => cmp(a.target, b.target) || cmp(a.kind, b.kind) || cmp(a.source, b.source),
      );
    },

    nodesByIds(ids) {
      const out: BlastNode[] = [];
      for (const part of chunks(ids, MAX_IDS_PER_QUERY)) {
        const stmt = db.prepare(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id IN (${placeholders(part.length)})`);
        out.push(...(stmt.all(...part) as NodeRow[]).map(toNode));
      }
      return out;
    },

    incomingSourcePaths(targetIds) {
      const out = new Map<string, Set<string>>();
      for (const ids of chunks(targetIds, MAX_IDS_PER_QUERY)) {
        // The join drops edges whose source node is missing: they have no file.
        const stmt = db.prepare(
          `SELECT DISTINCT e.target AS target, n.file_path AS path
           FROM edges e JOIN nodes n ON n.id = e.source
           WHERE e.target IN (${placeholders(ids.length)})`,
        );
        for (const row of stmt.all(...ids) as { target: string; path: string }[]) {
          const at = out.get(row.target) ?? new Set<string>();
          at.add(row.path);
          out.set(row.target, at);
        }
      }
      return out;
    },

    inDegree(targetIds) {
      const out = new Map<string, number>();
      for (const ids of chunks(targetIds, MAX_IDS_PER_QUERY)) {
        const stmt = db.prepare(
          `SELECT target, COUNT(*) AS c FROM edges WHERE target IN (${placeholders(ids.length)}) GROUP BY target`,
        );
        for (const row of stmt.all(...ids) as { target: string; c: number }[]) out.set(row.target, Number(row.c));
      }
      return out;
    },

    close() {
      conn.close();
    },
  };
}

/** Code-unit comparison: SQLite's default BINARY collation, independent of locale. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
