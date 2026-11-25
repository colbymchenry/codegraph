/**
 * What the parameter-flow pass reads and writes (see
 * ../resolution/parameter-flow). A pass makes these reads by the thousand, so
 * each shape is prepared once, and the ones whose planner choice matters name
 * their index: a full index runs the pass before it has planner stats, and
 * left to itself SQLite scans a language's nodes, or every failed row, for each.
 */

import type { Edge, Language, Node, UnresolvedReference } from '../types';
import type { QueryBuilder } from './queries';
import { referenceNameTail } from './reference-tail';
import type { SqliteDatabase, SqliteStatement } from './sqlite-adapter';

/** One call a language's code makes, as the pass reads it. */
export interface CallSiteRow {
  callerId: string;
  filePath: string;
  line: number;
  column: number;
  refName: string;
  /** What it resolved to; null for a call that failed. */
  targetId: string | null;
  confidence: number;
  /** The edge that holds it, or the failed row. */
  edgeId?: number;
  rowId?: number;
  /** A parameter flow answered it: its edge says so, or its failed row was once a guess a flow ruled out. */
  viaFlow: boolean;
}

/** What a sync compares of a file before and after it changes it. */
export interface FlowFacts {
  /** Its classes, modules and constants, with what they inherit and mix in, as written. */
  classes: string[];
  /** The names of the methods it declares. */
  methods: string[];
  /** The references it calls. */
  calls: string[];
}

/** What the pass reads of a method, a function or a class. */
export type NodeOutline = Pick<Node, 'id' | 'kind' | 'name' | 'qualifiedName' | 'filePath' | 'startLine' | 'startColumn' | 'endLine'> & {
  /** 1 for a static method. */
  isStatic: number;
};

/** Where each caller a read of call sites takes is; a caller it doesn't know isn't one. */
type CallerFiles = { get(id: string): { filePath: string } | undefined };

type CallEdgeRow = { id: number; source: string; target: string; line: number | null; col: number | null; metadata: string | null };
type FailedCallRow = { id: number; from_node_id: string; line: number; col: number; reference_name: string; file_path: string; candidates: string | null };

/** How a failed row says a parameter flow ruled its guess out. */
const FLOW_MARK = '["parameter-flow"]';
/** Set once a pass has written to the index. */
const FLOW_MARK_KEY = 'parameter_flows';

/** The node columns of an outline. */
const NODE_OUTLINE = `id, kind, name, qualified_name AS qualifiedName, file_path AS filePath, start_line AS startLine,
  start_column AS startColumn, end_line AS endLine, is_static AS isStatic`;
/** What the pass reads as a method. */
const METHOD_KINDS = `kind IN ('method', 'function')`;

const REACHED_METHODS = `SELECT ${NODE_OUTLINE} FROM (SELECT DISTINCT target FROM edges WHERE kind = 'calls') CROSS JOIN nodes ON id = target
  WHERE ${METHOD_KINDS} AND language = ?`;
const SCOPES_IN_FILE = `SELECT ${NODE_OUTLINE} FROM nodes WHERE file_path = ? AND kind IN ('class', 'module')`;
const OUTLINE = `SELECT ${NODE_OUTLINE}, language FROM nodes WHERE id = ?`;
const METHOD_NAMED = `SELECT 1 FROM nodes INDEXED BY idx_nodes_name WHERE name = ? AND ${METHOD_KINDS} AND language = ? LIMIT 1`;
const CALL_INTO = `SELECT 1 FROM edges WHERE target = ? AND kind = 'calls' LIMIT 1`;

const EDGE_COLUMNS = 'id, source, target, line, col, metadata';
const CALLS_INTO = `SELECT ${EDGE_COLUMNS} FROM edges WHERE target = ? AND kind = 'calls'`;
const CALLS_OUT_OF = `SELECT ${EDGE_COLUMNS} FROM edges WHERE source = ? AND kind = 'calls'`;
const CALLS_OF_NAME = `SELECT e.id, e.source, e.target, e.line, e.col, e.metadata FROM nodes n CROSS JOIN edges e ON e.target = n.id
  WHERE n.name = ? AND e.kind = 'calls'`;

const FAILED_CALL_COLUMNS = 'SELECT id, from_node_id, line, col, reference_name, file_path, candidates FROM unresolved_refs';
const FAILED_CALL_SITE = `${FAILED_CALL_COLUMNS} WHERE status = 'failed' AND reference_kind = 'calls' AND language = ?`;
const FAILED_CALLS_OF_NAME = `${FAILED_CALL_SITE} AND name_tail = ?`;
const FAILED_CALLS_BY = `${FAILED_CALL_COLUMNS} INDEXED BY idx_unresolved_from_node
  WHERE from_node_id = ? AND status = 'failed' AND reference_kind = 'calls' AND language = ?`;

const FACT_NODES = `SELECT kind, name, qualified_name AS owner, start_line AS line, start_column AS col FROM nodes
  WHERE file_path = ? AND kind IN ('class', 'module', 'variable', 'constant', 'method', 'function')`;
const FACT_EDGES = `SELECT e.kind, json_extract(e.metadata, '$.refName') AS ref, e.line, e.col, n.qualified_name AS owner
  FROM nodes n CROSS JOIN edges e ON e.source = n.id
  WHERE n.file_path = ? AND e.kind IN ('calls', 'extends', 'implements') ORDER BY e.id`;
const FACT_REFS = `SELECT r.reference_kind AS kind, r.reference_name AS ref, r.line, r.col, n.qualified_name AS owner
  FROM unresolved_refs r LEFT JOIN nodes n ON n.id = r.from_node_id
  WHERE r.file_path = ? AND r.reference_kind IN ('calls', 'extends', 'implements') ORDER BY r.id`;

const NAMES_PER_READ = 500;

function toFailedCallSite(row: FailedCallRow): CallSiteRow {
  return {
    callerId: row.from_node_id, filePath: row.file_path, line: row.line, column: row.col, refName: row.reference_name,
    targetId: null, confidence: 0, rowId: row.id, viaFlow: row.candidates === FLOW_MARK,
  };
}

export class ParameterFlowQueries {
  private readonly statements = new Map<string, SqliteStatement>();

  constructor(private readonly db: SqliteDatabase, private readonly queries: QueryBuilder) {}

  private statement(sql: string): SqliteStatement {
    let statement = this.statements.get(sql);
    if (!statement) this.statements.set(sql, (statement = this.db.prepare(sql)));
    return statement;
  }

  /** The indexed files of a language. */
  getFilePathsByLanguage(language: Language): string[] {
    const rows = this.statement('SELECT path FROM files WHERE language = ?').all(language) as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }

  /** A language's methods that a call reaches, as outlines. */
  getReachedMethods(language: Language): NodeOutline[] {
    return this.statement(REACHED_METHODS).all(language) as NodeOutline[];
  }

  /** A language's methods of these names, as outlines. */
  getMethodsNamed(names: readonly string[], language: Language): NodeOutline[] {
    const outlines: NodeOutline[] = [];
    for (let i = 0; i < names.length; i += NAMES_PER_READ) {
      const chunk = names.slice(i, i + NAMES_PER_READ);
      outlines.push(...this.db.prepare(
        `SELECT ${NODE_OUTLINE} FROM nodes INDEXED BY idx_nodes_name WHERE name IN (${chunk.map(() => '?').join(', ')}) AND ${METHOD_KINDS} AND language = ?`
      ).all(...chunk, language) as NodeOutline[]);
    }
    return outlines;
  }

  /** The classes and modules a file declares, as outlines. */
  getScopesInFile(filePath: string): NodeOutline[] {
    return this.statement(SCOPES_IN_FILE).all(filePath) as NodeOutline[];
  }

  /** One node's outline, with its language. */
  getNodeOutline(id: string): (NodeOutline & { language: Language }) | undefined {
    return this.statement(OUTLINE).get(id) as (NodeOutline & { language: Language }) | undefined;
  }

  /** Whether a language has a method of this name. */
  hasMethodNamed(name: string, language: Language): boolean {
    return this.statement(METHOD_NAMED).get(name, language) !== undefined;
  }

  /** Whether any call reaches a node. */
  hasCallInto(id: string): boolean {
    return this.statement(CALL_INTO).get(id) !== undefined;
  }

  /**
   * What a file holds that a flow reads: see FlowFacts. A call that failed counts
   * as much as one that resolved, so it reads the same whichever way a sync's
   * resolution goes. The order is the file's, which an ancestor's depends on.
   */
  getFlowFacts(filePath: string): FlowFacts {
    type Fact = { kind: string; line: number | null; col: number | null; owner: string | null; ref?: string | null; name?: string };
    const facts = [FACT_NODES, FACT_EDGES, FACT_REFS].flatMap((sql) => this.statement(sql).all(filePath)) as Fact[];
    facts.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.col ?? 0) - (b.col ?? 0));
    const found: FlowFacts = { classes: [], methods: [], calls: [] };
    for (const fact of facts) {
      if (fact.kind === 'method' || fact.kind === 'function') found.methods.push(fact.name!);
      else if (fact.kind === 'calls') {
        if (fact.ref) found.calls.push(fact.ref);
      } else if (fact.ref !== null) found.classes.push(`${fact.kind} ${fact.owner} ${fact.ref ?? ''}`);
    }
    return found;
  }

  /**
   * The calls edges into a node, out of one, or into any node of a name, from
   * `callers`, with what they reached and how sure that was. Synthesized edges
   * carry no reference.
   */
  getCallEdges(of: { target: string } | { source: string } | { targetName: string }, callers: CallerFiles): CallSiteRow[] {
    const rows = ('target' in of ? this.statement(CALLS_INTO).all(of.target)
      : 'source' in of ? this.statement(CALLS_OUT_OF).all(of.source)
        : this.statement(CALLS_OF_NAME).all(of.targetName)) as CallEdgeRow[];
    return this.toCallSites(rows, callers);
  }

  private toCallSites(rows: CallEdgeRow[], callers: CallerFiles): CallSiteRow[] {
    const sites: CallSiteRow[] = [];
    for (const row of rows) {
      const caller = callers.get(row.source);
      if (!caller || row.line === null || row.metadata === null) continue;
      const metadata = JSON.parse(row.metadata) as { refName?: string; confidence?: number; parameterFlow?: string };
      if (metadata.refName === undefined) continue;
      sites.push({
        callerId: row.source, filePath: caller.filePath, line: row.line, column: row.col ?? 0, refName: metadata.refName,
        targetId: row.target, confidence: metadata.confidence ?? 0, edgeId: row.id, viaFlow: metadata.parameterFlow !== undefined,
      });
    }
    return sites;
  }

  /** A language's failed calls of a method name, or made by one caller. */
  getFailedCallSites(language: Language, of: { tail: string } | { callerId: string }): CallSiteRow[] {
    const rows = ('tail' in of ? this.statement(FAILED_CALLS_OF_NAME).all(language, of.tail)
      : this.statement(FAILED_CALLS_BY).all(of.callerId, language)) as FailedCallRow[];
    return rows.map(toFailedCallSite);
  }

  /**
   * What an earlier pass did and left in the index: its edges, and the failed
   * rows of the guesses it ruled out. Nothing until a pass has written one: on a
   * fresh index, looking is a scan of every edge.
   */
  getFlowCallSites(language: Language, callers: CallerFiles): CallSiteRow[] {
    if (this.queries.getMetadata(FLOW_MARK_KEY) === null) return [];
    const edges = this.db.prepare(
      `SELECT ${EDGE_COLUMNS} FROM edges WHERE kind = 'calls' AND metadata LIKE '%"parameterFlow"%'`
    ).all() as CallEdgeRow[];
    const rows = this.db.prepare(`${FAILED_CALL_SITE} AND candidates = ?`).all(language, FLOW_MARK) as FailedCallRow[];
    return [...this.toCallSites(edges, callers), ...rows.map(toFailedCallSite)];
  }

  /** Remember that a pass wrote to this index. */
  noteParameterFlows(): void {
    this.queries.setMetadata(FLOW_MARK_KEY, '1');
  }

  /**
   * Swap what held each call a flow answers, an edge or a failed row, for its new
   * edge, as one transaction: a call left with neither has nothing to bring it back.
   */
  retargetCalls(edgeIds: number[], rowIds: number[], edges: Edge[]): void {
    this.db.transaction(() => {
      this.queries.deleteEdgesByIds(edgeIds);
      this.queries.deleteReferencesByRowIds(rowIds);
      this.queries.insertEdges(edges);
    })();
  }

  /** Put the calls no flow answers now back as references to resolve, as one transaction, for the same reason. */
  restoreCalls(edgeIds: number[], rowIds: number[], refs: UnresolvedReference[]): void {
    this.db.transaction(() => {
      this.queries.deleteReferencesByRowIds(rowIds);
      this.queries.replaceResolutionEdgesWithUnresolvedRefs(edgeIds, refs);
    })();
  }

  /**
   * Replace guesses a flow ruled out with failed rows that say so, as one
   * transaction: the edge is gone, and a later pass whose flow is gone puts the
   * reference back through resolution.
   */
  replaceEdgesWithFlowMarkedRefs(edgeIds: number[], refs: UnresolvedReference[]): void {
    const insert = this.db.prepare(
      `INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language, status, name_tail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?)`
    );
    if (refs.length === 0) return;
    this.db.transaction(() => {
      this.queries.deleteEdgesByIds(edgeIds);
      for (const ref of refs) {
        insert.run(ref.fromNodeId, ref.referenceName, ref.referenceKind, ref.line, ref.column, FLOW_MARK, ref.filePath ?? '', ref.language ?? 'unknown',
          referenceNameTail(ref.referenceName, ref.referenceKind));
      }
    })();
  }

  /** What the last pass over a language left for the next sync: null or blank for nothing to go on. */
  getRecord(language: Language): string | null {
    return this.queries.getMetadata(`parameter_flow_record_${language}`);
  }

  setRecord(language: Language, record: string): void {
    this.queries.setMetadata(`parameter_flow_record_${language}`, record);
  }
}
