/**
 * NeuG Backend
 *
 * Drop-in replacement for QueryBuilder that stores the code graph in NeuG
 * (embedded graph database with Cypher). Implements the same public method
 * signatures so the rest of the codebase (GraphTraverser, MCP tools, etc.)
 * works unchanged via duck typing.
 *
 * Requires the `neug` npm package (N-API binding to NeuG C++).
 */

import {
  Node,
  Edge,
  FileRecord,
  UnresolvedReference,
  NodeKind,
  EdgeKind,
  Language,
  GraphStats,
  SearchOptions,
  SearchResult,
} from '../types';
import { safeJsonParse } from '../utils';
import { kindBonus, nameMatchBonus, scorePathRelevance } from '../search/query-utils';
import { parseQuery, boundedEditDistance } from '../search/query-parser';
import { isGeneratedFile } from '../extraction/generated-detection';

// NeuG types — imported dynamically, declared here for type safety

interface NeuGRawQueryResult {
  length(): number;
  hasNext(): boolean;
  getNext(): any[];
  getAt(index: number): any[];
}

interface NeuGConnection {
  execute(query: string, accessMode?: string, parameters?: Record<string, any> | null): NeuGQueryResult;
  close(): void;
}

class NeuGQueryResult implements Iterable<any[]> {
  private rows: any[][];
  readonly length: number;

  constructor(raw: NeuGRawQueryResult) {
    this.rows = [];
    const len = typeof raw.length === 'function' ? raw.length() : (raw as any).length;
    for (let i = 0; i < len; i++) {
      this.rows.push(raw.getAt(i));
    }
    this.length = this.rows.length;
  }

  toArray(): any[][] {
    return [...this.rows];
  }

  *[Symbol.iterator](): Iterator<any[]> {
    for (const row of this.rows) {
      yield row;
    }
  }
}

export class NeuGConnectionWrapper implements NeuGConnection {
  private raw: any;

  constructor(rawConn: any) {
    this.raw = rawConn;
  }

  execute(query: string, accessMode?: string, parameters?: Record<string, any> | null): NeuGQueryResult {
    const rawResult = this.raw.execute(query, accessMode, parameters);
    if (rawResult && typeof rawResult.getAt === 'function') {
      return new NeuGQueryResult(rawResult);
    }
    return rawResult;
  }

  close(): void {
    this.raw.close();
  }
}

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const SCHEMA_DDL = [
  `CREATE NODE TABLE IF NOT EXISTS CodeNode (
    id STRING, kind STRING, name STRING, qualified_name STRING,
    file_path STRING, language STRING,
    start_line INT64, end_line INT64, start_column INT64, end_column INT64,
    docstring STRING, signature STRING, visibility STRING,
    is_exported INT64, is_async INT64, is_static INT64, is_abstract INT64,
    decorators STRING, type_parameters STRING, updated_at INT64,
    PRIMARY KEY(id)
  )`,
  `CREATE NODE TABLE IF NOT EXISTS CodeFile (
    path STRING, content_hash STRING, language STRING,
    size INT64, modified_at INT64, indexed_at INT64, node_count INT64, errors STRING,
    PRIMARY KEY(path)
  )`,
  `CREATE NODE TABLE IF NOT EXISTS UnresolvedRef (
    id STRING, from_node_id STRING, reference_name STRING, reference_kind STRING,
    line INT64, col INT64, candidates STRING, file_path STRING, language STRING,
    PRIMARY KEY(id)
  )`,
  `CREATE NODE TABLE IF NOT EXISTS ProjectMeta (
    key STRING, value STRING, updated_at INT64,
    PRIMARY KEY(key)
  )`,
  `CREATE NODE TABLE IF NOT EXISTS SchemaVersion (
    version STRING, applied_at INT64, description STRING,
    PRIMARY KEY(version)
  )`,
  `CREATE REL TABLE IF NOT EXISTS CodeEdge (
    FROM CodeNode TO CodeNode,
    kind STRING, metadata STRING, line INT64, col INT64, provenance STRING
  )`,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToNode(row: any[]): Node {
  return {
    id: row[0],
    kind: row[1] as NodeKind,
    name: row[2],
    qualifiedName: row[3],
    filePath: row[4],
    language: row[5] as Language,
    startLine: row[6] ?? 0,
    endLine: row[7] ?? 0,
    startColumn: row[8] ?? 0,
    endColumn: row[9] ?? 0,
    docstring: row[10] ?? undefined,
    signature: row[11] ?? undefined,
    visibility: row[12] as Node['visibility'],
    isExported: row[13] === 1,
    isAsync: row[14] === 1,
    isStatic: row[15] === 1,
    isAbstract: row[16] === 1,
    decorators: row[17] ? safeJsonParse(row[17], undefined) : undefined,
    typeParameters: row[18] ? safeJsonParse(row[18], undefined) : undefined,
    updatedAt: row[19] ?? 0,
  };
}

function rowToFileRecord(row: any[]): FileRecord {
  return {
    path: row[0],
    contentHash: row[1],
    language: row[2] as Language,
    size: row[3] ?? 0,
    modifiedAt: row[4] ?? 0,
    indexedAt: row[5] ?? 0,
    nodeCount: row[6] ?? 0,
    errors: row[7] ? safeJsonParse(row[7], undefined) : undefined,
  };
}

function escapeCypherLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function cypherInList(values: readonly string[]): string {
  return '[' + values.map(v => `'${escapeCypherLiteral(v)}'`).join(', ') + ']';
}

function isLowValueFile(filePath: string): boolean {
  const lp = filePath.toLowerCase();
  return (
    /(?:^|\/)(tests?|__tests?__|spec)\//.test(lp) ||
    /_test\.go$/.test(lp) ||
    /(?:^|\/)test_[^/]+\.py$/.test(lp) ||
    /_test\.py$/.test(lp) ||
    /_spec\.rb$/.test(lp) ||
    /_test\.rb$/.test(lp) ||
    /\.(test|spec)\.[jt]sx?$/.test(lp) ||
    /(test|spec|tests)\.(java|kt|scala)$/.test(lp) ||
    /(tests?|spec)\.cs$/.test(lp) ||
    /tests?\.swift$/.test(lp) ||
    /_test\.dart$/.test(lp) ||
    isGeneratedFile(filePath)
  );
}

function rowToUnresolved(row: any[]): UnresolvedReference {
  return {
    fromNodeId: row[1],
    referenceName: row[2],
    referenceKind: row[3] as EdgeKind,
    line: row[4],
    column: row[5],
    candidates: row[6] ? safeJsonParse(row[6], undefined) : undefined,
    filePath: row[7],
    language: row[8] as Language,
  };
}


// ---------------------------------------------------------------------------
// NeuGQueryBuilder
// ---------------------------------------------------------------------------

export class NeuGQueryBuilder {
  private conn: NeuGConnection;
  private nodeCache: Map<string, Node> = new Map();
  private readonly maxCacheSize = 1000;
  private unresolvedIdCounter = 0;

  constructor(conn: NeuGConnection) {
    this.conn = conn;
  }

  /**
   * Initialize the NeuG schema (called once after database creation)
   */
  initSchema(): void {
    for (const ddl of SCHEMA_DDL) {
      this.conn.execute(ddl, 'schema');
    }
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  insertNode(node: Node): void {
    if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
      return;
    }
    this.nodeCache.delete(node.id);
    const params = {
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName ?? node.name,
      filePath: node.filePath,
      language: node.language,
      startLine: node.startLine ?? 0,
      endLine: node.endLine ?? 0,
      startColumn: node.startColumn ?? 0,
      endColumn: node.endColumn ?? 0,
      docstring: node.docstring ?? '',
      signature: node.signature ?? '',
      visibility: node.visibility ?? '',
      isExported: node.isExported ? 1 : 0,
      isAsync: node.isAsync ? 1 : 0,
      isStatic: node.isStatic ? 1 : 0,
      isAbstract: node.isAbstract ? 1 : 0,
      decorators: node.decorators ? JSON.stringify(node.decorators) : '',
      typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : '',
      updatedAt: node.updatedAt ?? Date.now(),
    };
    const setClause = `
         n.kind = $kind, n.name = $name, n.qualified_name = $qualifiedName,
         n.file_path = $filePath, n.language = $language,
         n.start_line = $startLine, n.end_line = $endLine,
         n.start_column = $startColumn, n.end_column = $endColumn,
         n.docstring = $docstring, n.signature = $signature, n.visibility = $visibility,
         n.is_exported = $isExported, n.is_async = $isAsync,
         n.is_static = $isStatic, n.is_abstract = $isAbstract,
         n.decorators = $decorators, n.type_parameters = $typeParameters,
         n.updated_at = $updatedAt`;
    this.conn.execute(
      `MERGE (n:CodeNode {id: $id})
       ON CREATE SET ${setClause}
       ON MATCH SET ${setClause}`,
      'update', params
    );
  }

  insertNodes(nodes: Node[]): void {
    for (const node of nodes) {
      this.insertNode(node);
    }
  }

  updateNode(node: Node): void {
    this.insertNode(node);
  }

  deleteNode(id: string): void {
    this.nodeCache.delete(id);
    this.conn.execute(
      `MATCH (n:CodeNode {id: $id}) DETACH DELETE n`,
      'update', { id }
    );
  }

  deleteNodesByFile(filePath: string): void {
    for (const [id, node] of this.nodeCache) {
      if (node.filePath === filePath) this.nodeCache.delete(id);
    }
    this.conn.execute(
      `MATCH (n:CodeNode {file_path: $fp}) DETACH DELETE n`,
      'update', { fp: filePath }
    );
  }

  getNodeById(id: string): Node | null {
    if (this.nodeCache.has(id)) {
      const cached = this.nodeCache.get(id)!;
      this.nodeCache.delete(id);
      this.nodeCache.set(id, cached);
      return cached;
    }
    const result = this.conn.execute(
      `MATCH (n:CodeNode {id: $id})
       RETURN n.id, n.kind, n.name, n.qualified_name, n.file_path, n.language,
              n.start_line, n.end_line, n.start_column, n.end_column,
              n.docstring, n.signature, n.visibility,
              n.is_exported, n.is_async, n.is_static, n.is_abstract,
              n.decorators, n.type_parameters, n.updated_at`,
      'read', { id }
    );
    if (result.length === 0) return null;
    const node = rowToNode(result.toArray()[0]!);
    this.cacheNode(node);
    return node;
  }

  getNodesByIds(ids: readonly string[]): Map<string, Node> {
    const out = new Map<string, Node>();
    if (ids.length === 0) return out;

    const misses: string[] = [];
    for (const id of ids) {
      const cached = this.nodeCache.get(id);
      if (cached !== undefined) {
        this.nodeCache.delete(id);
        this.nodeCache.set(id, cached);
        out.set(id, cached);
      } else {
        misses.push(id);
      }
    }
    if (misses.length === 0) return out;

    const result = this.conn.execute(
      `MATCH (n:CodeNode) WHERE n.id IN ${cypherInList(misses)}
       RETURN n.id, n.kind, n.name, n.qualified_name, n.file_path, n.language,
              n.start_line, n.end_line, n.start_column, n.end_column,
              n.docstring, n.signature, n.visibility,
              n.is_exported, n.is_async, n.is_static, n.is_abstract,
              n.decorators, n.type_parameters, n.updated_at`,
      'read'
    );
    for (const row of result) {
      const node = rowToNode(row);
      out.set(node.id, node);
      this.cacheNode(node);
    }
    return out;
  }

  private cacheNode(node: Node): void {
    if (this.nodeCache.size >= this.maxCacheSize) {
      const firstKey = this.nodeCache.keys().next().value;
      if (firstKey) this.nodeCache.delete(firstKey);
    }
    this.nodeCache.set(node.id, node);
  }

  clearCache(): void {
    this.nodeCache.clear();
  }

  getNodesByFile(filePath: string): Node[] {
    const result = this.conn.execute(
      `MATCH (n:CodeNode {file_path: $fp})
       RETURN n.id, n.kind, n.name, n.qualified_name, n.file_path, n.language,
              n.start_line, n.end_line, n.start_column, n.end_column,
              n.docstring, n.signature, n.visibility,
              n.is_exported, n.is_async, n.is_static, n.is_abstract,
              n.decorators, n.type_parameters, n.updated_at
       ORDER BY n.start_line`,
      'read', { fp: filePath }
    );
    return result.toArray().map(rowToNode);
  }

  getNodesByKind(kind: NodeKind): Node[] {
    const result = this.conn.execute(
      `MATCH (n:CodeNode {kind: $kind})
       RETURN n.id, n.kind, n.name, n.qualified_name, n.file_path, n.language,
              n.start_line, n.end_line, n.start_column, n.end_column,
              n.docstring, n.signature, n.visibility,
              n.is_exported, n.is_async, n.is_static, n.is_abstract,
              n.decorators, n.type_parameters, n.updated_at`,
      'read', { kind }
    );
    return result.toArray().map(rowToNode);
  }

  getAllNodes(): Node[] {
    const result = this.conn.execute(
      `MATCH (n:CodeNode)
       RETURN n.id, n.kind, n.name, n.qualified_name, n.file_path, n.language,
              n.start_line, n.end_line, n.start_column, n.end_column,
              n.docstring, n.signature, n.visibility,
              n.is_exported, n.is_async, n.is_static, n.is_abstract,
              n.decorators, n.type_parameters, n.updated_at`,
      'read'
    );
    return result.toArray().map(rowToNode);
  }

  getNodesByName(name: string): Node[] {
    const result = this.conn.execute(
      `MATCH (n:CodeNode {name: $name})
       RETURN n.id, n.kind, n.name, n.qualified_name, n.file_path, n.language,
              n.start_line, n.end_line, n.start_column, n.end_column,
              n.docstring, n.signature, n.visibility,
              n.is_exported, n.is_async, n.is_static, n.is_abstract,
              n.decorators, n.type_parameters, n.updated_at`,
      'read', { name }
    );
    return result.toArray().map(rowToNode);
  }

  getNodesByQualifiedNameExact(qualifiedName: string): Node[] {
    const result = this.conn.execute(
      `MATCH (n:CodeNode {qualified_name: $qn})
       RETURN n.id, n.kind, n.name, n.qualified_name, n.file_path, n.language,
              n.start_line, n.end_line, n.start_column, n.end_column,
              n.docstring, n.signature, n.visibility,
              n.is_exported, n.is_async, n.is_static, n.is_abstract,
              n.decorators, n.type_parameters, n.updated_at`,
      'read', { qn: qualifiedName }
    );
    return result.toArray().map(rowToNode);
  }

  getNodesByLowerName(lowerName: string): Node[] {
    const result = this.conn.execute(
      `MATCH (n:CodeNode) WHERE lower(n.name) = $ln
       RETURN n.id, n.kind, n.name, n.qualified_name, n.file_path, n.language,
              n.start_line, n.end_line, n.start_column, n.end_column,
              n.docstring, n.signature, n.visibility,
              n.is_exported, n.is_async, n.is_static, n.is_abstract,
              n.decorators, n.type_parameters, n.updated_at`,
      'read', { ln: lowerName }
    );
    return result.toArray().map(rowToNode);
  }

  searchNodes(query: string, options: SearchOptions = {}): SearchResult[] {
    const { limit = 100 } = options;

    const parsed = parseQuery(query);
    const mergedKinds =
      parsed.kinds.length > 0
        ? Array.from(new Set([...(options.kinds ?? []), ...parsed.kinds]))
        : options.kinds;
    const mergedLanguages =
      parsed.languages.length > 0
        ? Array.from(new Set([...(options.languages ?? []), ...parsed.languages]))
        : options.languages;
    const pathFilters = parsed.pathFilters;
    const nameFilters = parsed.nameFilters;
    const text = parsed.text;
    const kinds = mergedKinds;
    const languages = mergedLanguages;

    let results: SearchResult[] = [];

    if (text) {
      // NeuG CONTAINS requires a string literal (parameters not supported for regex-compiled predicates)
      const escaped = escapeCypherLiteral(text);
      let cypher = `MATCH (n:CodeNode) WHERE n.name CONTAINS '${escaped}'`;
      if (kinds && kinds.length > 0) {
        cypher += ` AND n.kind IN ${cypherInList(kinds)}`;
      }
      if (languages && languages.length > 0) {
        cypher += ` AND n.language IN ${cypherInList(languages)}`;
      }
      cypher += ` RETURN n.id, n.kind, n.name, n.qualified_name, n.file_path, n.language,
                         n.start_line, n.end_line, n.start_column, n.end_column,
                         n.docstring, n.signature, n.visibility,
                         n.is_exported, n.is_async, n.is_static, n.is_abstract,
                         n.decorators, n.type_parameters, n.updated_at
                  LIMIT ${limit * 5}`;
      const r = this.conn.execute(cypher, 'read');
      results = r.toArray().map(row => ({ node: rowToNode(row), score: 1 }));
    } else {
      // Filter-only search
      let cypher = `MATCH (n:CodeNode) WHERE true`;
      if (kinds && kinds.length > 0) {
        cypher += ` AND n.kind IN ${cypherInList(kinds)}`;
      }
      if (languages && languages.length > 0) {
        cypher += ` AND n.language IN ${cypherInList(languages)}`;
      }
      cypher += ` RETURN n.id, n.kind, n.name, n.qualified_name, n.file_path, n.language,
                         n.start_line, n.end_line, n.start_column, n.end_column,
                         n.docstring, n.signature, n.visibility,
                         n.is_exported, n.is_async, n.is_static, n.is_abstract,
                         n.decorators, n.type_parameters, n.updated_at
                  ORDER BY n.name LIMIT ${limit * 5}`;
      const r = this.conn.execute(cypher, 'read');
      results = r.toArray().map(row => ({ node: rowToNode(row), score: 1 }));
    }

    // Fuzzy fallback when CONTAINS found nothing
    if (results.length === 0 && text && text.length >= 3) {
      const allNames = this.getAllNodeNames();
      const lowered = text.toLowerCase();
      const maxDist = lowered.length <= 4 ? 1 : 2;
      const candidates: Array<{ name: string; dist: number }> = [];
      for (const name of allNames) {
        const dist = boundedEditDistance(name.toLowerCase(), lowered, maxDist);
        if (dist <= maxDist) candidates.push({ name, dist });
      }
      candidates.sort((a, b) => a.dist - b.dist);
      for (const c of candidates.slice(0, limit * 2)) {
        if (results.length >= limit) break;
        const nodes = this.getNodesByName(c.name);
        for (const node of nodes) {
          results.push({ node, score: 1 / (c.dist + 1) });
        }
      }
    }

    // Multi-signal scoring
    if (results.length > 0 && (text || query)) {
      const scoringQuery = text || query;
      results = results.map(r => ({
        ...r,
        score: r.score
          + kindBonus(r.node.kind)
          + scorePathRelevance(r.node.filePath, scoringQuery)
          + nameMatchBonus(r.node.name, scoringQuery),
      }));
      results.sort((a, b) => b.score - a.score);
      if (results.length > limit) results = results.slice(0, limit);
    }

    // Apply path: + name: filters
    if (pathFilters.length > 0) {
      const lowered = pathFilters.map(p => p.toLowerCase());
      results = results.filter(r => {
        const fp = r.node.filePath.toLowerCase();
        return lowered.some(p => fp.includes(p));
      });
    }
    if (nameFilters.length > 0) {
      const lowered = nameFilters.map(n => n.toLowerCase());
      results = results.filter(r => {
        const nm = r.node.name.toLowerCase();
        return lowered.some(n => nm.includes(n));
      });
    }

    return results;
  }

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  insertEdge(edge: Edge): void {
    this.conn.execute(
      `MATCH (a:CodeNode {id: $src}), (b:CodeNode {id: $tgt})
       CREATE (a)-[:CodeEdge {kind: $kind, metadata: $metadata, line: $line, col: $col, provenance: $provenance}]->(b)`,
      'update',
      {
        src: edge.source,
        tgt: edge.target,
        kind: edge.kind,
        metadata: edge.metadata ? JSON.stringify(edge.metadata) : '',
        line: edge.line ?? 0,
        col: edge.column ?? 0,
        provenance: edge.provenance ?? '',
      }
    );
  }

  insertEdges(edges: Edge[]): void {
    for (const edge of edges) {
      this.insertEdge(edge);
    }
  }

  deleteEdgesBySource(sourceId: string): void {
    this.conn.execute(
      `MATCH (a:CodeNode {id: $src})-[e:CodeEdge]->() DELETE e`,
      'update', { src: sourceId }
    );
  }

  getOutgoingEdges(sourceId: string, kinds?: EdgeKind[], provenance?: string): Edge[] {
    let cypher = `MATCH (a:CodeNode {id: $src})-[e:CodeEdge]->(b:CodeNode)`;
    const params: Record<string, any> = { src: sourceId };
    const conditions: string[] = [];

    if (kinds && kinds.length > 0) {
      conditions.push(`e.kind IN ${cypherInList(kinds)}`);
    }
    if (provenance) {
      conditions.push('e.provenance = $prov');
      params.prov = provenance;
    }
    if (conditions.length > 0) {
      cypher += ` WHERE ${conditions.join(' AND ')}`;
    }
    cypher += ` RETURN e.kind, e.metadata, e.line, e.col, e.provenance, a.id, b.id`;

    const result = this.conn.execute(cypher, 'read', params);
    return result.toArray().map(row => ({
      source: row[5],
      target: row[6],
      kind: row[0] as EdgeKind,
      metadata: row[1] ? safeJsonParse(row[1], undefined) : undefined,
      line: row[2] || undefined,
      column: row[3] || undefined,
      provenance: row[4] as Edge['provenance'],
    }));
  }

  getIncomingEdges(targetId: string, kinds?: EdgeKind[]): Edge[] {
    let cypher = `MATCH (a:CodeNode)-[e:CodeEdge]->(b:CodeNode {id: $tgt})`;
    const params: Record<string, any> = { tgt: targetId };

    if (kinds && kinds.length > 0) {
      cypher += ` WHERE e.kind IN ${cypherInList(kinds)}`;
    }
    cypher += ` RETURN e.kind, e.metadata, e.line, e.col, e.provenance, a.id, b.id`;

    const result = this.conn.execute(cypher, 'read', params);
    return result.toArray().map(row => ({
      source: row[5],
      target: row[6],
      kind: row[0] as EdgeKind,
      metadata: row[1] ? safeJsonParse(row[1], undefined) : undefined,
      line: row[2] || undefined,
      column: row[3] || undefined,
      provenance: row[4] as Edge['provenance'],
    }));
  }

  findEdgesBetweenNodes(nodeIds: string[], kinds?: EdgeKind[]): Edge[] {
    if (nodeIds.length === 0) return [];

    const idList = cypherInList(nodeIds);
    let cypher = `MATCH (a:CodeNode)-[e:CodeEdge]->(b:CodeNode)
                  WHERE a.id IN ${idList} AND b.id IN ${idList}`;

    if (kinds && kinds.length > 0) {
      cypher += ` AND e.kind IN ${cypherInList(kinds)}`;
    }
    cypher += ` RETURN e.kind, e.metadata, e.line, e.col, e.provenance, a.id, b.id`;

    const result = this.conn.execute(cypher, 'read');
    return result.toArray().map(row => ({
      source: row[5],
      target: row[6],
      kind: row[0] as EdgeKind,
      metadata: row[1] ? safeJsonParse(row[1], undefined) : undefined,
      line: row[2] || undefined,
      column: row[3] || undefined,
      provenance: row[4] as Edge['provenance'],
    }));
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  upsertFile(file: FileRecord): void {
    const params = {
      path: file.path,
      contentHash: file.contentHash,
      language: file.language,
      size: file.size,
      modifiedAt: file.modifiedAt,
      indexedAt: file.indexedAt,
      nodeCount: file.nodeCount,
      errors: file.errors ? JSON.stringify(file.errors) : '',
    };
    const setClause = `
         f.content_hash = $contentHash, f.language = $language,
         f.size = $size, f.modified_at = $modifiedAt, f.indexed_at = $indexedAt,
         f.node_count = $nodeCount, f.errors = $errors`;
    this.conn.execute(
      `MERGE (f:CodeFile {path: $path})
       ON CREATE SET ${setClause}
       ON MATCH SET ${setClause}`,
      'update', params
    );
  }

  deleteFile(filePath: string): void {
    this.deleteNodesByFile(filePath);
    this.conn.execute(
      `MATCH (f:CodeFile {path: $path}) DELETE f`,
      'update', { path: filePath }
    );
  }

  getFileByPath(filePath: string): FileRecord | null {
    const result = this.conn.execute(
      `MATCH (f:CodeFile {path: $path})
       RETURN f.path, f.content_hash, f.language, f.size, f.modified_at,
              f.indexed_at, f.node_count, f.errors`,
      'read', { path: filePath }
    );
    if (result.length === 0) return null;
    return rowToFileRecord(result.toArray()[0]!);
  }

  getAllFiles(): FileRecord[] {
    const result = this.conn.execute(
      `MATCH (f:CodeFile)
       RETURN f.path, f.content_hash, f.language, f.size, f.modified_at,
              f.indexed_at, f.node_count, f.errors
       ORDER BY f.path`,
      'read'
    );
    return result.toArray().map(rowToFileRecord);
  }

  getStaleFiles(currentHashes: Map<string, string>): FileRecord[] {
    const files = this.getAllFiles();
    return files.filter(f => {
      const currentHash = currentHashes.get(f.path);
      return currentHash && currentHash !== f.contentHash;
    });
  }

  getAllFilePaths(): string[] {
    const result = this.conn.execute(
      `MATCH (f:CodeFile) RETURN f.path ORDER BY f.path`,
      'read'
    );
    return result.toArray().map(row => row[0]);
  }

  // ===========================================================================
  // Unresolved References
  // ===========================================================================

  insertUnresolvedRef(ref: UnresolvedReference): void {
    this.unresolvedIdCounter++;
    this.conn.execute(
      `CREATE (r:UnresolvedRef {
        id: $id, from_node_id: $fromNodeId, reference_name: $refName,
        reference_kind: $refKind, line: $line, col: $col,
        candidates: $candidates, file_path: $filePath, language: $language
      })`,
      'update',
      {
        id: String(this.unresolvedIdCounter),
        fromNodeId: ref.fromNodeId,
        refName: ref.referenceName,
        refKind: ref.referenceKind,
        line: ref.line,
        col: ref.column,
        candidates: ref.candidates ? JSON.stringify(ref.candidates) : '',
        filePath: ref.filePath ?? '',
        language: ref.language ?? 'unknown',
      }
    );
  }

  insertUnresolvedRefsBatch(refs: UnresolvedReference[]): void {
    for (const ref of refs) {
      this.insertUnresolvedRef(ref);
    }
  }

  deleteUnresolvedByNode(nodeId: string): void {
    this.conn.execute(
      `MATCH (r:UnresolvedRef {from_node_id: $nodeId}) DELETE r`,
      'update', { nodeId }
    );
  }

  getUnresolvedByName(name: string): UnresolvedReference[] {
    const result = this.conn.execute(
      `MATCH (r:UnresolvedRef {reference_name: $name})
       RETURN r.id, r.from_node_id, r.reference_name, r.reference_kind,
              r.line, r.col, r.candidates, r.file_path, r.language`,
      'read', { name }
    );
    return result.toArray().map(rowToUnresolved);
  }

  getUnresolvedReferences(): UnresolvedReference[] {
    const result = this.conn.execute(
      `MATCH (r:UnresolvedRef)
       RETURN r.id, r.from_node_id, r.reference_name, r.reference_kind,
              r.line, r.col, r.candidates, r.file_path, r.language`,
      'read'
    );
    return result.toArray().map(rowToUnresolved);
  }

  getUnresolvedReferencesCount(): number {
    const result = this.conn.execute(
      `MATCH (r:UnresolvedRef) RETURN count(r)`,
      'read'
    );
    return result.toArray()[0]?.[0] ?? 0;
  }

  getUnresolvedReferencesBatch(offset: number, limit: number): UnresolvedReference[] {
    const result = this.conn.execute(
      `MATCH (r:UnresolvedRef)
       RETURN r.id, r.from_node_id, r.reference_name, r.reference_kind,
              r.line, r.col, r.candidates, r.file_path, r.language
       SKIP ${offset} LIMIT ${limit}`,
      'read'
    );
    return result.toArray().map(rowToUnresolved);
  }

  getUnresolvedReferencesByFiles(filePaths: string[]): UnresolvedReference[] {
    if (filePaths.length === 0) return [];
    const result = this.conn.execute(
      `MATCH (r:UnresolvedRef) WHERE r.file_path IN ${cypherInList(filePaths)}
       RETURN r.id, r.from_node_id, r.reference_name, r.reference_kind,
              r.line, r.col, r.candidates, r.file_path, r.language`,
      'read'
    );
    return result.toArray().map(rowToUnresolved);
  }

  clearUnresolvedReferences(): void {
    this.conn.execute(
      `MATCH (r:UnresolvedRef) DELETE r`,
      'update'
    );
  }

  deleteResolvedReferences(fromNodeIds: string[]): void {
    if (fromNodeIds.length === 0) return;
    this.conn.execute(
      `MATCH (r:UnresolvedRef) WHERE r.from_node_id IN ${cypherInList(fromNodeIds)} DELETE r`,
      'update'
    );
  }

  deleteSpecificResolvedReferences(refs: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }>): void {
    for (const ref of refs) {
      this.conn.execute(
        `MATCH (r:UnresolvedRef {from_node_id: $fni, reference_name: $rn, reference_kind: $rk}) DELETE r`,
        'update', { fni: ref.fromNodeId, rn: ref.referenceName, rk: ref.referenceKind }
      );
    }
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  getStats(): GraphStats {
    const nodeCountResult = this.conn.execute(
      `MATCH (n:CodeNode) RETURN count(n)`, 'read'
    );
    const edgeCountResult = this.conn.execute(
      `MATCH ()-[e:CodeEdge]->() RETURN count(e)`, 'read'
    );
    const fileCountResult = this.conn.execute(
      `MATCH (f:CodeFile) RETURN count(f)`, 'read'
    );

    const nodeCount = nodeCountResult.toArray()[0]?.[0] ?? 0;
    const edgeCount = edgeCountResult.toArray()[0]?.[0] ?? 0;
    const fileCount = fileCountResult.toArray()[0]?.[0] ?? 0;

    const nodesByKind = {} as Record<NodeKind, number>;
    const nkResult = this.conn.execute(
      `MATCH (n:CodeNode) RETURN n.kind, count(n) ORDER BY n.kind`,
      'read'
    );
    for (const row of nkResult) {
      nodesByKind[row[0] as NodeKind] = row[1];
    }

    const edgesByKind = {} as Record<EdgeKind, number>;
    const ekResult = this.conn.execute(
      `MATCH ()-[e:CodeEdge]->() RETURN e.kind, count(e) ORDER BY e.kind`,
      'read'
    );
    for (const row of ekResult) {
      edgesByKind[row[0] as EdgeKind] = row[1];
    }

    const filesByLanguage = {} as Record<Language, number>;
    const flResult = this.conn.execute(
      `MATCH (f:CodeFile) RETURN f.language, count(f) ORDER BY f.language`,
      'read'
    );
    for (const row of flResult) {
      filesByLanguage[row[0] as Language] = row[1];
    }

    return {
      nodeCount,
      edgeCount,
      fileCount,
      nodesByKind,
      edgesByKind,
      filesByLanguage,
      dbSizeBytes: 0,
      lastUpdated: Date.now(),
    };
  }

  getAllNodeNames(): string[] {
    const result = this.conn.execute(
      `MATCH (n:CodeNode) RETURN DISTINCT n.name`,
      'read'
    );
    return result.toArray().map(row => row[0]);
  }

  // ===========================================================================
  // Project Metadata
  // ===========================================================================

  getMetadata(key: string): string | null {
    const result = this.conn.execute(
      `MATCH (m:ProjectMeta {key: $key}) RETURN m.value`,
      'read', { key }
    );
    if (result.length === 0) return null;
    return result.toArray()[0]![0];
  }

  setMetadata(key: string, value: string): void {
    const ts = Date.now();
    this.conn.execute(
      `MERGE (m:ProjectMeta {key: $key})
       ON CREATE SET m.value = $val, m.updated_at = $ts
       ON MATCH SET m.value = $val, m.updated_at = $ts`,
      'update', { key, val: value, ts }
    );
  }

  getAllMetadata(): Record<string, string> {
    const result = this.conn.execute(
      `MATCH (m:ProjectMeta) RETURN m.key, m.value`,
      'read'
    );
    const out: Record<string, string> = {};
    for (const row of result) {
      out[row[0]] = row[1];
    }
    return out;
  }

  // ===========================================================================
  // Additional Query Methods (needed by GraphQueryManager, ContextBuilder, MCP)
  // ===========================================================================

  getNodeAndEdgeCount(): { nodes: number; edges: number } {
    const nc = this.conn.execute('MATCH (n:CodeNode) RETURN count(n)', 'read');
    const ec = this.conn.execute('MATCH ()-[e:CodeEdge]->() RETURN count(e)', 'read');
    return { nodes: nc.toArray()[0]?.[0] ?? 0, edges: ec.toArray()[0]?.[0] ?? 0 };
  }

  getDominantFile(): { filePath: string; edgeCount: number; nextEdgeCount: number } | null {
    const result = this.conn.execute(
      `MATCH (n:CodeNode)-[e:CodeEdge]-(m:CodeNode)
       WHERE n.file_path = m.file_path
       RETURN n.file_path, count(e) AS edge_count
       ORDER BY edge_count DESC LIMIT 20`,
      'read'
    );
    const rows = result.toArray().filter(r => r[0] && !isLowValueFile(r[0]));
    if (rows.length === 0 || rows[0]![1] < 20) return null;
    return {
      filePath: rows[0]![0],
      edgeCount: rows[0]![1],
      nextEdgeCount: rows[1]?.[1] ?? 0,
    };
  }

  getTopRouteFile(): { filePath: string; routeCount: number; totalRoutes: number } | null {
    const result = this.conn.execute(
      `MATCH (n:CodeNode {kind: 'route'})
       RETURN n.file_path, count(n) AS cnt
       ORDER BY cnt DESC LIMIT 20`,
      'read'
    );
    const rows = result.toArray().filter(r => r[0] && !isLowValueFile(r[0]));
    if (rows.length === 0) return null;
    const totalRoutes = rows.reduce((sum, r) => sum + r[1], 0);
    const top = rows[0]!;
    if (totalRoutes < 3 || top[1] < 3) return null;
    if (top[1] / totalRoutes < 0.30) return null;
    return { filePath: top[0], routeCount: top[1], totalRoutes };
  }

  getRoutingManifest(limit: number = 40): {
    entries: Array<{ url: string; handler: string; handlerFile: string; handlerLine: number; handlerKind: string }>;
    topHandlerFile: string | null;
    topHandlerFileCount: number;
    totalRoutes: number;
  } | null {
    const result = this.conn.execute(
      `MATCH (r:CodeNode {kind: 'route'})-[e:CodeEdge]->(h:CodeNode)
       WHERE e.kind IN ['references', 'calls'] AND h.kind IN ['function', 'method', 'class']
       RETURN r.name, h.name, h.file_path, h.start_line, h.kind
       ORDER BY r.file_path, r.start_line LIMIT ${limit}`,
      'read'
    );
    const rows = result.toArray().filter(r => r[2] && !isLowValueFile(r[2]));
    if (rows.length < 3) return null;

    const fileCounts = new Map<string, number>();
    for (const r of rows) {
      fileCounts.set(r[2], (fileCounts.get(r[2]) ?? 0) + 1);
    }
    let topHandlerFile: string | null = null;
    let topHandlerFileCount = 0;
    for (const [file, count] of fileCounts) {
      if (count > topHandlerFileCount) {
        topHandlerFile = file;
        topHandlerFileCount = count;
      }
    }

    return {
      entries: rows.map(r => ({
        url: r[0],
        handler: r[1],
        handlerFile: r[2],
        handlerLine: r[3] ?? 0,
        handlerKind: r[4],
      })),
      topHandlerFile,
      topHandlerFileCount,
      totalRoutes: rows.length,
    };
  }

  findNodesByExactName(names: string[], options: SearchOptions = {}): SearchResult[] {
    if (names.length === 0) return [];
    const { kinds, languages, limit = 50 } = options;

    const nameToFiles = new Map<string, Set<string>>();
    for (const name of names) {
      let cypher = `MATCH (n:CodeNode {name: $name}) RETURN DISTINCT n.file_path LIMIT 100`;
      const r = this.conn.execute(cypher, 'read', { name });
      nameToFiles.set(name.toLowerCase(), new Set(r.toArray().map(row => row[0]).filter(Boolean)));
    }

    const distinctiveFiles = new Set<string>();
    for (const [, files] of nameToFiles) {
      if (files.size > 0 && files.size < 10) {
        for (const f of files) distinctiveFiles.add(f);
      }
    }

    const perNameLimit = Math.max(8, Math.ceil(limit / names.length));
    const allResults: SearchResult[] = [];
    const seenIds = new Set<string>();

    for (const name of names) {
      let cypher = `MATCH (n:CodeNode {name: $name})`;
      const conditions: string[] = [];
      if (kinds && kinds.length > 0) {
        conditions.push(`n.kind IN ${cypherInList(kinds)}`);
      }
      if (languages && languages.length > 0) {
        conditions.push(`n.language IN ${cypherInList(languages)}`);
      }
      if (conditions.length > 0) cypher += ` WHERE ${conditions.join(' AND ')}`;
      cypher += ` RETURN n.id, n.kind, n.name, n.qualified_name, n.file_path, n.language,
                         n.start_line, n.end_line, n.start_column, n.end_column,
                         n.docstring, n.signature, n.visibility,
                         n.is_exported, n.is_async, n.is_static, n.is_abstract,
                         n.decorators, n.type_parameters, n.updated_at
                  LIMIT ${perNameLimit * 3}`;
      const r = this.conn.execute(cypher, 'read', { name });
      const nameResults: SearchResult[] = [];
      for (const row of r) {
        const node = rowToNode(row);
        if (seenIds.has(node.id)) continue;
        const coLocationBoost = distinctiveFiles.has(node.filePath) ? 20 : 0;
        nameResults.push({ node, score: 1 + coLocationBoost });
      }
      nameResults.sort((a, b) => b.score - a.score);
      for (const r of nameResults.slice(0, perNameLimit)) {
        seenIds.add(r.node.id);
        allResults.push(r);
      }
    }

    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, limit);
  }

  findNodesByNameSubstring(
    substring: string,
    options: SearchOptions & { excludePrefix?: boolean } = {}
  ): SearchResult[] {
    const { kinds, languages, limit = 30 } = options;
    const escaped = escapeCypherLiteral(substring);
    let cypher = `MATCH (n:CodeNode) WHERE n.name CONTAINS '${escaped}'`;
    if (kinds && kinds.length > 0) {
      cypher += ` AND n.kind IN ${cypherInList(kinds)}`;
    }
    if (languages && languages.length > 0) {
      cypher += ` AND n.language IN ${cypherInList(languages)}`;
    }
    cypher += ` RETURN n.id, n.kind, n.name, n.qualified_name, n.file_path, n.language,
                       n.start_line, n.end_line, n.start_column, n.end_column,
                       n.docstring, n.signature, n.visibility,
                       n.is_exported, n.is_async, n.is_static, n.is_abstract,
                       n.decorators, n.type_parameters, n.updated_at
                LIMIT ${limit}`;
    const result = this.conn.execute(cypher, 'read');
    return result.toArray().map(row => ({ node: rowToNode(row), score: 1 }));
  }

  // ===========================================================================
  // Raw Cypher Execution (NeuG-only capability)
  // ===========================================================================

  executeCypher(query: string, params?: Record<string, any>): any[][] {
    const result = this.conn.execute(query, 'read', params ?? null);
    return result.toArray();
  }

  // ===========================================================================
  // Clear
  // ===========================================================================

  clear(): void {
    this.nodeCache.clear();
    this.conn.execute(`MATCH (n:CodeNode) DETACH DELETE n`, 'update');
    this.conn.execute(`MATCH (f:CodeFile) DELETE f`, 'update');
    this.conn.execute(`MATCH (r:UnresolvedRef) DELETE r`, 'update');
  }
}
