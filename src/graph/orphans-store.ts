/**
 * The read side of `codegraph orphans`: one read-only connection to the index,
 * blast's queries over it (`symbolsOverlapping`, `nodesByIds`, through
 * `storeOver` in `./blast-store`) and the queries only orphans runs.
 *
 * The connection has exactly one owner: this store. Its `close` closes the
 * connection once; blast's store over the same connection is never closed on
 * its own.
 *
 * Every `IN (...)` list is split by blast's chunking helpers, so no statement
 * passes SQLite's bound-parameter limit. Indexes relied on (src/db/schema.sql):
 *   - `idx_edges_target_kind (target, kind)` for incoming edges and parents;
 *   - `idx_edges_source_kind (source, kind)` for outgoing conformances and
 *     members;
 *   - `idx_nodes_name (name)` for same-named type nodes;
 *   - `idx_unresolved_from_node (from_node_id)` for external conformances;
 *   - `idx_unresolved_failed_tail (name_tail) WHERE status = 'failed'` for
 *     the failed references naming a candidate (the unresolved-reference check);
 *   - the `nodes.id` primary key for node fetches.
 */
import * as fs from 'fs';
import { DatabaseConnection, getDatabasePath } from '../db';
import type { SqliteDatabase } from '../db/sqlite-adapter';
import type { BlastNode } from './blast';
import { MAX_IDS_PER_QUERY, chunks, placeholders, storeOver } from './blast-store';

/** One failed unresolved reference whose name tail names a candidate (the unresolved-reference check), with its from-node's span. */
export interface FailedRef {
  /** `unresolved_refs.name_tail`: the reference name's last segment. */
  nameTail: string;
  referenceName: string;
  referenceKind: string;
  /** `unresolved_refs.language`: the language of the file the reference is in (the same-language rule compares it to S's). */
  language: string;
  /** The reference's file (`unresolved_refs.file_path`, or the from-node's when that is empty). */
  path: string;
  line: number;
  fromNode: string;
  fromPath: string;
  fromStart: number;
  fromEnd: number;
}

/** A node with the numeric span and language the orphan rules need. */
export interface OrphanNode {
  id: string;
  name: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  language: string;
}

/** One incoming edge with its source node's position, its target node's file and the edge's resolution metadata. */
export interface IncomingUse {
  source: string;
  target: string;
  /**
   * The target node's file. A type's counted uses span its same-name group, so
   * the guess rule reads this, not the candidate's own file.
   */
  targetPath: string;
  kind: string;
  /** The edge's own line, or the source node's start line when the edge has none. */
  line: number;
  /** edges.metadata parsed; empty when the edge carries none (extraction-local). */
  metadata: Record<string, unknown>;
  sourceName: string;
  sourcePath: string;
  sourceStart: number;
  sourceEnd: number;
}

export interface OrphansStore {
  /** Blast's lookup: symbols in `path` whose span overlaps `start..end`. */
  symbolsOverlapping(path: string, start: number, end: number): BlastNode[];
  /** Blast's lookup: the nodes for `ids`. */
  nodesByIds(ids: readonly string[]): BlastNode[];
  /** `nodes.language` per id. */
  languages(ids: readonly string[]): Map<string, string>;
  /** Every edge pointing at any of `targetIds` except `contains` and `exports`, with its source node and its target's file. */
  incomingUses(targetIds: readonly string[]): IncomingUse[];
  /** Per child id, the ids of the nodes that hold it by a `contains` edge. */
  parents(childIds: readonly string[]): Map<string, string[]>;
  /** Type-kind nodes named any of `names`, any language (the caller groups them by language and name, Swift extensions as one type). */
  typesNamed(names: readonly string[], kinds: readonly string[]): OrphanNode[];
  /** Per source id, the targets of its outgoing `implements` / `extends` edges. */
  conformances(sourceIds: readonly string[]): Map<string, string[]>;
  /** Per container id, the names of the nodes it holds by a `contains` edge. */
  memberNames(containerIds: readonly string[]): Map<string, Set<string>>;
  /**
   * Per node id, the reference names of its FAILED `extends` / `implements`
   * unresolved refs: conformances to a type the index does not hold.
   */
  externalConformances(nodeIds: readonly string[]): Map<string, string[]>;
  /** Every FAILED unresolved ref whose `name_tail` is one of `names`, any language (the unresolved-reference check; the caller keeps S's language, the same-language rule). */
  failedRefsNamed(names: readonly string[]): FailedRef[];
  close(): void;
}

/** Edge kinds that are not a use: containment and export. */
const NOT_A_USE = ['contains', 'exports'] as const;

/** Edge kinds that make one type conform to another. */
const CONFORMANCE_KINDS = ['implements', 'extends'] as const;

const NODE_COLUMNS = 'id, name, kind, file_path, start_line, end_line, language';

interface NodeRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  start_line: number;
  end_line: number;
  language: string;
}

function toOrphanNode(r: NodeRow): OrphanNode {
  return {
    id: r.id, name: r.name, kind: r.kind, path: r.file_path,
    startLine: Number(r.start_line), endLine: Number(r.end_line), language: r.language,
  };
}

/** Parse edges.metadata; anything that is not a JSON object reads as no metadata. */
function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Push `value` onto the list at `key`. */
function add<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const at = map.get(key);
  if (at) at.push(value);
  else map.set(key, [value]);
}

/**
 * Open the index at `root` read-only, or throw when there is none (callers
 * check `fs.existsSync(getDatabasePath(root))` first, as `runOrphans` does).
 */
export function openOrphansStore(root: string): OrphansStore {
  const dbPath = getDatabasePath(root);
  if (!fs.existsSync(dbPath)) throw new Error(`no CodeGraph index at ${root}`);
  const conn = DatabaseConnection.open(dbPath, { readOnly: true });
  // A statement that fails to prepare must not leave the connection open behind the throw.
  try {
    return storeOn(conn);
  } catch (err) {
    conn.close();
    throw err;
  }
}

function storeOn(conn: DatabaseConnection): OrphansStore {
  const db: SqliteDatabase = conn.getDb();
  // Shares `conn`; its own close is never called (this store owns the connection).
  const blast = storeOver(conn);

  /** Run `sql(n)` once per chunk of `ids`, with `extra` bound after the chunk. */
  function perChunk<R>(ids: readonly string[], sql: (n: number) => string, extra: readonly string[] = []): R[] {
    const out: R[] = [];
    for (const part of chunks(ids, MAX_IDS_PER_QUERY)) {
      out.push(...(db.prepare(sql(part.length)).all(...part, ...extra) as R[]));
    }
    return out;
  }

  return {
    symbolsOverlapping: (path, start, end) => blast.symbolsOverlapping(path, start, end),
    nodesByIds: (ids) => blast.nodesByIds(ids),

    languages(ids) {
      const rows = perChunk<{ id: string; language: string }>(
        ids, (n) => `SELECT id, language FROM nodes WHERE id IN (${placeholders(n)})`);
      return new Map(rows.map((r) => [r.id, r.language]));
    },

    incomingUses(targetIds) {
      interface Row {
        source: string; target: string; kind: string; line: number | null; metadata: string | null;
        sname: string; spath: string; sstart: number; send: number; tpath: string;
      }
      const rows = perChunk<Row>(
        targetIds,
        (n) => `SELECT e.source AS source, e.target AS target, e.kind AS kind, e.line AS line, e.metadata AS metadata,
                       s.name AS sname, s.file_path AS spath, s.start_line AS sstart, s.end_line AS send,
                       t.file_path AS tpath
                FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
                WHERE e.target IN (${placeholders(n)}) AND e.kind NOT IN (${placeholders(NOT_A_USE.length)})`,
        NOT_A_USE,
      );
      return rows.map((r) => ({
        source: r.source,
        target: r.target,
        targetPath: r.tpath,
        kind: r.kind,
        line: r.line === null ? Number(r.sstart) : Number(r.line),
        metadata: parseMetadata(r.metadata),
        sourceName: r.sname,
        sourcePath: r.spath,
        sourceStart: Number(r.sstart),
        sourceEnd: Number(r.send),
      }));
    },

    parents(childIds) {
      const out = new Map<string, string[]>();
      const rows = perChunk<{ source: string; target: string }>(
        childIds, (n) => `SELECT source, target FROM edges WHERE target IN (${placeholders(n)}) AND kind = 'contains'`);
      for (const r of rows) add(out, r.target, r.source);
      return out;
    },

    typesNamed(names, kinds) {
      if (kinds.length === 0) return [];
      return perChunk<NodeRow>(
        names,
        (n) => `SELECT ${NODE_COLUMNS} FROM nodes
                WHERE name IN (${placeholders(n)}) AND kind IN (${placeholders(kinds.length)})`,
        kinds,
      ).map(toOrphanNode);
    },

    conformances(sourceIds) {
      const out = new Map<string, string[]>();
      const rows = perChunk<{ source: string; target: string }>(
        sourceIds,
        (n) => `SELECT source, target FROM edges
                WHERE source IN (${placeholders(n)}) AND kind IN (${placeholders(CONFORMANCE_KINDS.length)})`,
        CONFORMANCE_KINDS,
      );
      for (const r of rows) add(out, r.source, r.target);
      return out;
    },

    memberNames(containerIds) {
      const out = new Map<string, Set<string>>();
      const rows = perChunk<{ source: string; name: string }>(
        containerIds,
        (n) => `SELECT e.source AS source, m.name AS name
                FROM edges e JOIN nodes m ON m.id = e.target
                WHERE e.source IN (${placeholders(n)}) AND e.kind = 'contains'`,
      );
      for (const r of rows) {
        const at = out.get(r.source) ?? new Set<string>();
        at.add(r.name);
        out.set(r.source, at);
      }
      return out;
    },

    externalConformances(nodeIds) {
      const out = new Map<string, string[]>();
      const rows = perChunk<{ from_node_id: string; reference_name: string }>(
        nodeIds,
        (n) => `SELECT from_node_id, reference_name FROM unresolved_refs
                WHERE from_node_id IN (${placeholders(n)}) AND status = 'failed'
                  AND reference_kind IN (${placeholders(CONFORMANCE_KINDS.length)})`,
        CONFORMANCE_KINDS,
      );
      for (const r of rows) add(out, r.from_node_id, r.reference_name);
      return out;
    },

    failedRefsNamed(names) {
      interface Row {
        name_tail: string; reference_name: string; reference_kind: string; language: string; file_path: string; line: number;
        from_node_id: string; fpath: string; fstart: number; fend: number;
      }
      const rows = perChunk<Row>(
        names,
        (n) => `SELECT u.name_tail AS name_tail, u.reference_name AS reference_name, u.reference_kind AS reference_kind,
                       u.language AS language, u.file_path AS file_path, u.line AS line, u.from_node_id AS from_node_id,
                       f.file_path AS fpath, f.start_line AS fstart, f.end_line AS fend
                FROM unresolved_refs u JOIN nodes f ON f.id = u.from_node_id
                WHERE u.status = 'failed' AND u.name_tail IN (${placeholders(n)})`,
      );
      return rows.map((r) => ({
        nameTail: r.name_tail,
        referenceName: r.reference_name,
        referenceKind: r.reference_kind,
        language: r.language,
        path: r.file_path !== '' ? r.file_path : r.fpath,
        line: Number(r.line),
        fromNode: r.from_node_id,
        fromPath: r.fpath,
        fromStart: Number(r.fstart),
        fromEnd: Number(r.fend),
      }));
    },

    close() {
      conn.close();
    },
  };
}
