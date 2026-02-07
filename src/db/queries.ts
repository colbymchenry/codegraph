/**
 * Database Queries
 *
 * Prepared statements for CRUD operations on the knowledge graph.
 */

import Database from 'better-sqlite3';
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

/**
 * Database row types (snake_case from SQLite)
 */
interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
  docstring: string | null;
  signature: string | null;
  visibility: string | null;
  is_exported: number;
  is_async: number;
  is_static: number;
  is_abstract: number;
  decorators: string | null;
  type_parameters: string | null;
  updated_at: number;
}

interface EdgeRow {
  id: number;
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
  line: number | null;
  col: number | null;
}

interface FileRow {
  path: string;
  content_hash: string;
  language: string;
  size: number;
  modified_at: number;
  indexed_at: number;
  node_count: number;
  errors: string | null;
}

interface UnresolvedRefRow {
  id: number;
  from_node_id: string;
  reference_name: string;
  reference_kind: string;
  line: number;
  col: number;
  file_path: string;
  language: string;
  candidates: string | null;
}

interface ProjectMetadataRow {
  key: string;
  value: string;
  updated_at: number;
}

/**
 * Convert database row to Node object
 */
function rowToNode(row: NodeRow): Node {
  return {
    id: row.id,
    kind: row.kind as NodeKind,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    language: row.language as Language,
    startLine: row.start_line,
    endLine: row.end_line,
    startColumn: row.start_column,
    endColumn: row.end_column,
    docstring: row.docstring ?? undefined,
    signature: row.signature ?? undefined,
    visibility: row.visibility as Node['visibility'],
    isExported: row.is_exported === 1,
    isAsync: row.is_async === 1,
    isStatic: row.is_static === 1,
    isAbstract: row.is_abstract === 1,
    decorators: row.decorators ? JSON.parse(row.decorators) : undefined,
    typeParameters: row.type_parameters ? JSON.parse(row.type_parameters) : undefined,
    updatedAt: row.updated_at,
  };
}

/**
 * Convert database row to Edge object
 */
function rowToEdge(row: EdgeRow): Edge {
  return {
    source: row.source,
    target: row.target,
    kind: row.kind as EdgeKind,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    line: row.line ?? undefined,
    column: row.col ?? undefined,
  };
}

/**
 * Convert database row to FileRecord object
 */
function rowToFileRecord(row: FileRow): FileRecord {
  return {
    path: row.path,
    contentHash: row.content_hash,
    language: row.language as Language,
    size: row.size,
    modifiedAt: row.modified_at,
    indexedAt: row.indexed_at,
    nodeCount: row.node_count,
    errors: row.errors ? JSON.parse(row.errors) : undefined,
  };
}

/**
 * Query builder for the knowledge graph database
 */
export class QueryBuilder {
  private db: Database.Database;

  // Node cache for frequently accessed nodes (LRU-style, max 1000 entries)
  private nodeCache: Map<string, Node> = new Map();
  private readonly maxCacheSize = 1000;

  // Prepared statements (lazily initialized)
  private stmts: {
    insertNode?: Database.Statement;
    updateNode?: Database.Statement;
    deleteNode?: Database.Statement;
    deleteNodesByFile?: Database.Statement;
    getNodeById?: Database.Statement;
    getNodesByFile?: Database.Statement;
    getNodesByKind?: Database.Statement;
    insertEdge?: Database.Statement;
    deleteEdgesByMetadataSource?: Database.Statement;
    deleteEdgesByMetadataSourceLike?: Database.Statement;
    upsertFile?: Database.Statement;
    deleteEdgesBySource?: Database.Statement;
    deleteEdgesByTarget?: Database.Statement;
    getEdgesBySource?: Database.Statement;
    getEdgesByTarget?: Database.Statement;
    insertFile?: Database.Statement;
    updateFile?: Database.Statement;
    deleteFile?: Database.Statement;
    getFileByPath?: Database.Statement;
    getAllFiles?: Database.Statement;
    insertUnresolved?: Database.Statement;
    deleteUnresolvedByNode?: Database.Statement;
    getUnresolvedByName?: Database.Statement;
    upsertProjectMetadata?: Database.Statement;
    getProjectMetadata?: Database.Statement;
  } = {};

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  /**
   * Insert a new node
   */
  insertNode(node: Node): void {
    if (!this.stmts.insertNode) {
      this.stmts.insertNode = this.db.prepare(`
        INSERT INTO nodes (
          id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column,
          docstring, signature, visibility,
          is_exported, is_async, is_static, is_abstract,
          decorators, type_parameters, updated_at
        ) VALUES (
          @id, @kind, @name, @qualifiedName, @filePath, @language,
          @startLine, @endLine, @startColumn, @endColumn,
          @docstring, @signature, @visibility,
          @isExported, @isAsync, @isStatic, @isAbstract,
          @decorators, @typeParameters, @updatedAt
        )
      `);
    }

    this.stmts.insertNode.run({
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName,
      filePath: node.filePath,
      language: node.language,
      startLine: node.startLine,
      endLine: node.endLine,
      startColumn: node.startColumn,
      endColumn: node.endColumn,
      docstring: node.docstring ?? null,
      signature: node.signature ?? null,
      visibility: node.visibility ?? null,
      isExported: node.isExported ? 1 : 0,
      isAsync: node.isAsync ? 1 : 0,
      isStatic: node.isStatic ? 1 : 0,
      isAbstract: node.isAbstract ? 1 : 0,
      decorators: node.decorators ? JSON.stringify(node.decorators) : null,
      typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
      updatedAt: node.updatedAt,
    });
  }

  /**
   * Insert multiple nodes in a transaction
   */
  insertNodes(nodes: Node[]): void {
    this.db.transaction(() => {
      for (const node of nodes) {
        this.insertNode(node);
      }
    })();
  }

  /**
   * Update an existing node
   */
  updateNode(node: Node): void {
    if (!this.stmts.updateNode) {
      this.stmts.updateNode = this.db.prepare(`
        UPDATE nodes SET
          kind = @kind,
          name = @name,
          qualified_name = @qualifiedName,
          file_path = @filePath,
          language = @language,
          start_line = @startLine,
          end_line = @endLine,
          start_column = @startColumn,
          end_column = @endColumn,
          docstring = @docstring,
          signature = @signature,
          visibility = @visibility,
          is_exported = @isExported,
          is_async = @isAsync,
          is_static = @isStatic,
          is_abstract = @isAbstract,
          decorators = @decorators,
          type_parameters = @typeParameters,
          updated_at = @updatedAt
        WHERE id = @id
      `);
    }

    // Invalidate cache before update
    this.nodeCache.delete(node.id);

    this.stmts.updateNode.run({
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName,
      filePath: node.filePath,
      language: node.language,
      startLine: node.startLine,
      endLine: node.endLine,
      startColumn: node.startColumn,
      endColumn: node.endColumn,
      docstring: node.docstring ?? null,
      signature: node.signature ?? null,
      visibility: node.visibility ?? null,
      isExported: node.isExported ? 1 : 0,
      isAsync: node.isAsync ? 1 : 0,
      isStatic: node.isStatic ? 1 : 0,
      isAbstract: node.isAbstract ? 1 : 0,
      decorators: node.decorators ? JSON.stringify(node.decorators) : null,
      typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
      updatedAt: node.updatedAt,
    });
  }

  /**
   * Delete a node by ID
   */
  deleteNode(id: string): void {
    if (!this.stmts.deleteNode) {
      this.stmts.deleteNode = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    }
    // Invalidate cache
    this.nodeCache.delete(id);
    this.stmts.deleteNode.run(id);
  }

  /**
   * Delete all nodes for a file
   */
  deleteNodesByFile(filePath: string): void {
    if (!this.stmts.deleteNodesByFile) {
      this.stmts.deleteNodesByFile = this.db.prepare('DELETE FROM nodes WHERE file_path = ?');
    }
    // Invalidate cache for nodes in this file
    for (const [id, node] of this.nodeCache) {
      if (node.filePath === filePath) {
        this.nodeCache.delete(id);
      }
    }
    this.stmts.deleteNodesByFile.run(filePath);
  }

  /**
   * Get a node by ID
   */
  getNodeById(id: string): Node | null {
    // Check cache first
    if (this.nodeCache.has(id)) {
      const cached = this.nodeCache.get(id)!;
      // Move to end to implement LRU (delete and re-add)
      this.nodeCache.delete(id);
      this.nodeCache.set(id, cached);
      return cached;
    }

    if (!this.stmts.getNodeById) {
      this.stmts.getNodeById = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    }
    const row = this.stmts.getNodeById.get(id) as NodeRow | undefined;
    if (!row) {
      return null;
    }

    const node = rowToNode(row);
    this.cacheNode(node);
    return node;
  }

  /**
   * Add a node to the cache, evicting oldest if needed
   */
  private cacheNode(node: Node): void {
    if (this.nodeCache.size >= this.maxCacheSize) {
      // Evict oldest (first) entry
      const firstKey = this.nodeCache.keys().next().value;
      if (firstKey) {
        this.nodeCache.delete(firstKey);
      }
    }
    this.nodeCache.set(node.id, node);
  }

  /**
   * Clear the node cache
   */
  clearCache(): void {
    this.nodeCache.clear();
  }

  /**
   * Get all nodes in a file
   */
  getNodesByFile(filePath: string): Node[] {
    if (!this.stmts.getNodesByFile) {
      this.stmts.getNodesByFile = this.db.prepare(
        'SELECT * FROM nodes WHERE file_path = ? ORDER BY start_line'
      );
    }
    const rows = this.stmts.getNodesByFile.all(filePath) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get all nodes of a specific kind
   */
  getNodesByKind(kind: NodeKind): Node[] {
    if (!this.stmts.getNodesByKind) {
      this.stmts.getNodesByKind = this.db.prepare('SELECT * FROM nodes WHERE kind = ?');
    }
    const rows = this.stmts.getNodesByKind.all(kind) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Search nodes by name using FTS with fallback to LIKE for better matching
   *
   * Search strategy:
   * 1. Try FTS5 prefix match (query*) for word-start matching
   * 2. If no results, try LIKE for substring matching (e.g., "signIn" finds "signInWithGoogle")
   * 3. Re-rank by lexical match quality and kind priority
   */
  searchNodes(query: string, options: SearchOptions = {}): SearchResult[] {
    const {
      kinds,
      languages,
      includePatterns,
      excludePatterns,
      limit = 100,
      offset = 0,
    } = options;
    const fileIntent = this.isFileIntentQuery(query);
    const includeFiles = this.shouldIncludeFileNodes(options, fileIntent);
    const excludeFiles = !includeFiles && !(kinds && kinds.includes('file'));

    // First try FTS5 with prefix matching
    let results = this.searchNodesFTS(
      query,
      { kinds, languages, limit, offset },
      excludeFiles,
      fileIntent,
      includePatterns,
      excludePatterns
    );

    // If no FTS results, try LIKE-based substring search
    if (results.length === 0 && query.length >= 2) {
      results = this.searchNodesLike(
        query,
        { kinds, languages, limit, offset },
        excludeFiles,
        fileIntent,
        includePatterns,
        excludePatterns
      );
    }

    return results;
  }

  /**
   * FTS5 search with prefix matching
   */
  private searchNodesFTS(
    query: string,
    options: SearchOptions,
    excludeFiles: boolean,
    fileIntent: boolean,
    includePatterns?: string[],
    excludePatterns?: string[]
  ): SearchResult[] {
    const { kinds, languages, limit = 100, offset = 0 } = options;

    const terms = this.extractSearchTerms(query);
    if (terms.length === 0) {
      return [];
    }

    // For natural-language queries, try stricter AND semantics first, then relax to OR.
    const strictQuery = this.buildFtsQuery(terms, terms.length > 1 ? 'AND' : 'OR');
    let results = this.runFtsQuery(
      strictQuery,
      query,
      kinds,
      languages,
      limit,
      offset,
      excludeFiles,
      fileIntent,
      includePatterns,
      excludePatterns
    );

    if (results.length === 0 && terms.length > 1) {
      const relaxedQuery = this.buildFtsQuery(terms, 'OR');
      if (relaxedQuery !== strictQuery) {
        results = this.runFtsQuery(
          relaxedQuery,
          query,
          kinds,
          languages,
          limit,
          offset,
          excludeFiles,
          fileIntent,
          includePatterns,
          excludePatterns
        );
      }
    }

    return results;
  }

  private runFtsQuery(
    ftsQuery: string,
    query: string,
    kinds: NodeKind[] | undefined,
    languages: Language[] | undefined,
    limit: number,
    offset: number,
    excludeFiles: boolean,
    fileIntent: boolean,
    includePatterns?: string[],
    excludePatterns?: string[]
  ): SearchResult[] {
    let sql = `
      SELECT nodes.*, bm25(nodes_fts) as score
      FROM nodes_fts
      JOIN nodes ON nodes_fts.id = nodes.id
      WHERE nodes_fts MATCH ?
    `;

    const params: (string | number)[] = [ftsQuery];

    if (kinds && kinds.length > 0) {
      sql += ` AND nodes.kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND nodes.language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    if (excludeFiles) {
      sql += " AND nodes.kind != 'file'";
    }

    const patternFilters = this.buildPathPatternFilterSql(
      'nodes.file_path',
      includePatterns,
      excludePatterns
    );
    sql += patternFilters.sql;
    params.push(...patternFilters.params);

    const candidateLimit = Math.max((limit + offset) * 5, 200);
    sql += ' ORDER BY score LIMIT ?';
    params.push(candidateLimit);

    try {
      const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
      const ranked = rows
        .map((row) => {
          const node = rowToNode(row);
          const lexical = this.computeLexicalScore(node, query);
          const kindScore = this.getKindPriorityScore(node.kind, fileIntent);
          const bm25Score = 1 / (1 + Math.abs(row.score));
          const combinedScore = lexical * 0.55 + kindScore * 0.25 + bm25Score * 0.2;
          return {
            node,
            lexical,
            kindScore,
            bm25Raw: row.score,
            score: combinedScore,
          };
        })
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (b.lexical !== a.lexical) return b.lexical - a.lexical;
          if (b.kindScore !== a.kindScore) return b.kindScore - a.kindScore;
          if (a.bm25Raw !== b.bm25Raw) return a.bm25Raw - b.bm25Raw;
          return a.node.name.length - b.node.name.length;
        });

      return ranked.slice(offset, offset + limit).map(({ node, score }) => ({ node, score }));
    } catch {
      // FTS query failed, return empty
      return [];
    }
  }

  /**
   * LIKE-based substring search for cases where FTS doesn't match
   * Useful for camelCase matching (e.g., "signIn" finds "signInWithGoogle")
   */
  private searchNodesLike(
    query: string,
    options: SearchOptions,
    excludeFiles: boolean,
    fileIntent: boolean,
    includePatterns?: string[],
    excludePatterns?: string[]
  ): SearchResult[] {
    const { kinds, languages, limit = 100, offset = 0 } = options;

    let sql = `
      SELECT nodes.*
      FROM nodes
      WHERE (
        name LIKE ? OR
        qualified_name LIKE ? OR
        name LIKE ?
      )
    `;

    // Pattern variants for better matching
    const exactMatch = query;
    const startsWith = `${query}%`;
    const contains = `%${query}%`;

    const params: (string | number)[] = [
      contains,       // WHERE: name contains
      contains,       // WHERE: qualified_name contains
      startsWith,     // WHERE: name starts with
    ];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    if (excludeFiles) {
      sql += " AND kind != 'file'";
    }

    const patternFilters = this.buildPathPatternFilterSql(
      'file_path',
      includePatterns,
      excludePatterns
    );
    sql += patternFilters.sql;
    params.push(...patternFilters.params);

    const candidateLimit = Math.max((limit + offset) * 5, 200);
    sql += ' LIMIT ?';
    params.push(candidateLimit);

    const rows = this.db.prepare(sql).all(...params) as NodeRow[];
    const ranked = rows
      .map((row) => {
        const node = rowToNode(row);
        const lexical = this.computeLexicalScore(node, exactMatch);
        const kindScore = this.getKindPriorityScore(node.kind, fileIntent);
        const score = lexical * 0.8 + kindScore * 0.2;
        return { node, lexical, kindScore, score };
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.lexical !== a.lexical) return b.lexical - a.lexical;
        if (b.kindScore !== a.kindScore) return b.kindScore - a.kindScore;
        return a.node.name.length - b.node.name.length;
      });

    return ranked.slice(offset, offset + limit).map(({ node, score }) => ({ node, score }));
  }

  private shouldIncludeFileNodes(options: SearchOptions, fileIntent: boolean): boolean {
    if (options.includeFiles === true) {
      return true;
    }
    if (options.includeFiles === false) {
      return false;
    }
    if (options.kinds && options.kinds.length > 0) {
      return options.kinds.includes('file');
    }
    return fileIntent;
  }

  private isFileIntentQuery(query: string): boolean {
    const trimmed = query.trim();
    if (!trimmed) return false;
    return /[\\/]/.test(trimmed) || /\.[a-z0-9]{1,8}$/i.test(trimmed);
  }

  private computeLexicalScore(node: Node, query: string): number {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return 0;

    const terms = this.extractSearchTerms(query).slice(0, 8);
    if (terms.length <= 1) {
      return this.computeTermMatchScore(node, terms[0] ?? normalizedQuery);
    }

    const termScores = terms.map((term) => this.computeTermMatchScore(node, term));
    const matchedScores = termScores.filter((score) => score > 0.2);
    if (matchedScores.length === 0) {
      return 0.2;
    }

    const avg = matchedScores.reduce((sum, score) => sum + score, 0) / matchedScores.length;
    const coverage = matchedScores.length / terms.length;
    return avg * 0.75 + coverage * 0.25;
  }

  private computeTermMatchScore(node: Node, term: string): number {
    const normalizedTerm = term.trim().toLowerCase();
    if (!normalizedTerm) return 0.2;

    const name = node.name.toLowerCase();
    const qualified = node.qualifiedName.toLowerCase();
    const filePath = node.filePath.toLowerCase();
    const fileName = filePath.split('/').pop() ?? '';
    const isFileNode = node.kind === 'file';

    if (name === normalizedTerm || qualified === normalizedTerm) {
      return 1.0;
    }
    if (isFileNode && fileName === normalizedTerm) {
      return 1.0;
    }
    if (name.startsWith(normalizedTerm) || fileName.startsWith(normalizedTerm)) {
      return 0.92;
    }
    if (name.includes(normalizedTerm) || fileName.includes(normalizedTerm)) {
      return 0.85;
    }
    if (filePath.includes(`/${normalizedTerm}/`) || filePath.includes(`/${normalizedTerm}.`)) {
      return 0.82;
    }
    if (qualified.includes(normalizedTerm) || filePath.includes(normalizedTerm)) {
      return 0.7;
    }

    return 0.2;
  }

  private extractSearchTerms(query: string): string[] {
    const stopWords = new Set([
      'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in',
      'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'this',
      'to', 'understand', 'with', 'during', 'show', 'me'
    ]);

    const cleaned = query
      .toLowerCase()
      .replace(/['"*()]/g, ' ')
      .replace(/[^a-z0-9_./\\-]+/g, ' ')
      .trim();

    if (!cleaned) return [];

    const terms = cleaned
      .split(/\s+/)
      .map((term) => term.replace(/^[./\\-]+|[./\\-]+$/g, ''))
      .filter((term) => term.length >= 2)
      .filter((term) => !stopWords.has(term));

    return Array.from(new Set(terms));
  }

  private buildFtsQuery(terms: string[], operator: 'AND' | 'OR'): string {
    return terms.map((term) => `"${term}"*`).join(` ${operator} `);
  }

  private getKindPriorityScore(kind: NodeKind, fileIntent: boolean): number {
    switch (kind) {
      case 'function':
        return 1.0;
      case 'method':
        return 0.98;
      case 'component':
        return 0.95;
      case 'class':
      case 'struct':
      case 'interface':
      case 'trait':
      case 'protocol':
        return 0.93;
      case 'route':
        return 0.9;
      case 'module':
      case 'namespace':
        return 0.85;
      case 'type_alias':
      case 'enum':
      case 'enum_member':
      case 'property':
      case 'field':
      case 'variable':
      case 'constant':
      case 'parameter':
      case 'import':
      case 'export':
        return 0.78;
      case 'file':
        return fileIntent ? 0.97 : 0.1;
      default:
        return 0.7;
    }
  }

  private buildPathPatternFilterSql(
    column: string,
    includePatterns?: string[],
    excludePatterns?: string[]
  ): { sql: string; params: string[] } {
    const sqlParts: string[] = [];
    const params: string[] = [];

    const includeLikes = (includePatterns ?? [])
      .map((pattern) => this.globToLike(pattern))
      .filter((pattern): pattern is string => pattern.length > 0);
    if (includeLikes.length > 0) {
      sqlParts.push(` AND (${includeLikes.map(() => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      params.push(...includeLikes);
    }

    const excludeLikes = (excludePatterns ?? [])
      .map((pattern) => this.globToLike(pattern))
      .filter((pattern): pattern is string => pattern.length > 0);
    if (excludeLikes.length > 0) {
      sqlParts.push(` AND (${excludeLikes.map(() => `${column} NOT LIKE ? ESCAPE '\\'`).join(' AND ')})`);
      params.push(...excludeLikes);
    }

    return { sql: sqlParts.join(''), params };
  }

  private globToLike(pattern: string): string {
    const trimmed = pattern.trim();
    if (!trimmed) return '';

    const escaped = trimmed
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');

    return escaped.replace(/\*/g, '%').replace(/\?/g, '_');
  }

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  /**
   * Insert a new edge
   */
  insertEdge(edge: Edge): void {
    if (!this.stmts.insertEdge) {
      this.stmts.insertEdge = this.db.prepare(`
        INSERT INTO edges (source, target, kind, metadata, line, col)
        VALUES (@source, @target, @kind, @metadata, @line, @col)
      `);
    }

    this.stmts.insertEdge.run({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
      line: edge.line ?? null,
      col: edge.column ?? null,
    });
  }

  /**
   * Insert multiple edges in a transaction
   */
  insertEdges(edges: Edge[]): void {
    this.db.transaction(() => {
      for (const edge of edges) {
        this.insertEdge(edge);
      }
    })();
  }

  /**
   * Delete edges where metadata.source matches the provided value.
   * Returns number of deleted rows.
   */
  deleteEdgesByMetadataSource(source: string): number {
    try {
      if (!this.stmts.deleteEdgesByMetadataSource) {
        this.stmts.deleteEdgesByMetadataSource = this.db.prepare(
          `DELETE FROM edges WHERE json_extract(metadata, '$.source') = ?`
        );
      }
      const result = this.stmts.deleteEdgesByMetadataSource.run(source);
      return Number(result.changes ?? 0);
    } catch {
      // Fallback for SQLite builds without JSON1 support.
      if (!this.stmts.deleteEdgesByMetadataSourceLike) {
        this.stmts.deleteEdgesByMetadataSourceLike = this.db.prepare(
          `DELETE FROM edges WHERE metadata LIKE ?`
        );
      }
      const result = this.stmts.deleteEdgesByMetadataSourceLike.run(`%"source":"${source}"%`);
      return Number(result.changes ?? 0);
    }
  }

  /**
   * Delete all edges from a source node
   */
  deleteEdgesBySource(sourceId: string): void {
    if (!this.stmts.deleteEdgesBySource) {
      this.stmts.deleteEdgesBySource = this.db.prepare('DELETE FROM edges WHERE source = ?');
    }
    this.stmts.deleteEdgesBySource.run(sourceId);
  }

  /**
   * Delete edges from a source node of a specific kind
   */
  deleteEdgesBySourceAndKind(sourceId: string, kind: string): void {
    // Use ad-hoc prepared statement since kind varies
    this.db.prepare('DELETE FROM edges WHERE source = ? AND kind = ?').run(sourceId, kind);
  }

  /**
   * Get outgoing edges from a node
   */
  getOutgoingEdges(sourceId: string, kinds?: EdgeKind[]): Edge[] {
    if (kinds && kinds.length > 0) {
      const sql = `SELECT * FROM edges WHERE source = ? AND kind IN (${kinds.map(() => '?').join(',')})`;
      const rows = this.db.prepare(sql).all(sourceId, ...kinds) as EdgeRow[];
      return rows.map(rowToEdge);
    }

    if (!this.stmts.getEdgesBySource) {
      this.stmts.getEdgesBySource = this.db.prepare('SELECT * FROM edges WHERE source = ?');
    }
    const rows = this.stmts.getEdgesBySource.all(sourceId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * Get incoming edges to a node
   */
  getIncomingEdges(targetId: string, kinds?: EdgeKind[]): Edge[] {
    if (kinds && kinds.length > 0) {
      const sql = `SELECT * FROM edges WHERE target = ? AND kind IN (${kinds.map(() => '?').join(',')})`;
      const rows = this.db.prepare(sql).all(targetId, ...kinds) as EdgeRow[];
      return rows.map(rowToEdge);
    }

    if (!this.stmts.getEdgesByTarget) {
      this.stmts.getEdgesByTarget = this.db.prepare('SELECT * FROM edges WHERE target = ?');
    }
    const rows = this.stmts.getEdgesByTarget.all(targetId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Insert or update a file record
   */
  upsertFile(file: FileRecord): void {
    if (!this.stmts.upsertFile) {
      this.stmts.upsertFile = this.db.prepare(`
        INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
        VALUES (@path, @contentHash, @language, @size, @modifiedAt, @indexedAt, @nodeCount, @errors)
        ON CONFLICT(path) DO UPDATE SET
          content_hash = @contentHash,
          language = @language,
          size = @size,
          modified_at = @modifiedAt,
          indexed_at = @indexedAt,
          node_count = @nodeCount,
          errors = @errors
      `);
    }

    this.stmts.upsertFile.run({
      path: file.path,
      contentHash: file.contentHash,
      language: file.language,
      size: file.size,
      modifiedAt: file.modifiedAt,
      indexedAt: file.indexedAt,
      nodeCount: file.nodeCount,
      errors: file.errors ? JSON.stringify(file.errors) : null,
    });
  }

  /**
   * Delete a file record and its nodes
   */
  deleteFile(filePath: string): void {
    this.db.transaction(() => {
      this.deleteNodesByFile(filePath);
      if (!this.stmts.deleteFile) {
        this.stmts.deleteFile = this.db.prepare('DELETE FROM files WHERE path = ?');
      }
      this.stmts.deleteFile.run(filePath);
    })();
  }

  /**
   * Get a file record by path
   */
  getFileByPath(filePath: string): FileRecord | null {
    if (!this.stmts.getFileByPath) {
      this.stmts.getFileByPath = this.db.prepare('SELECT * FROM files WHERE path = ?');
    }
    const row = this.stmts.getFileByPath.get(filePath) as FileRow | undefined;
    return row ? rowToFileRecord(row) : null;
  }

  /**
   * Get all tracked files
   */
  getAllFiles(): FileRecord[] {
    if (!this.stmts.getAllFiles) {
      this.stmts.getAllFiles = this.db.prepare('SELECT * FROM files ORDER BY path');
    }
    const rows = this.stmts.getAllFiles.all() as FileRow[];
    return rows.map(rowToFileRecord);
  }

  /**
   * Get all nodes (for cache warming)
   */
  getAllNodes(): Node[] {
    const rows = this.db.prepare('SELECT * FROM nodes').all() as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get files that need re-indexing (hash changed)
   */
  getStaleFiles(currentHashes: Map<string, string>): FileRecord[] {
    const files = this.getAllFiles();
    return files.filter((f) => {
      const currentHash = currentHashes.get(f.path);
      return currentHash && currentHash !== f.contentHash;
    });
  }

  // ===========================================================================
  // Unresolved References
  // ===========================================================================

  /**
   * Insert an unresolved reference
   */
  insertUnresolvedRef(ref: UnresolvedReference): void {
    if (!this.stmts.insertUnresolved) {
      this.stmts.insertUnresolved = this.db.prepare(`
        INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates)
        VALUES (@fromNodeId, @referenceName, @referenceKind, @line, @col, @candidates)
      `);
    }

    this.stmts.insertUnresolved.run({
      fromNodeId: ref.fromNodeId,
      referenceName: ref.referenceName,
      referenceKind: ref.referenceKind,
      line: ref.line,
      col: ref.column,
      candidates: ref.candidates ? JSON.stringify(ref.candidates) : null,
    });
  }

  /**
   * Insert multiple unresolved references in a single transaction (optimized)
   */
  insertUnresolvedRefsBatch(refs: UnresolvedReference[]): void {
    if (refs.length === 0) return;

    if (!this.stmts.insertUnresolved) {
      this.stmts.insertUnresolved = this.db.prepare(`
        INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language, candidates)
        VALUES (@fromNodeId, @referenceName, @referenceKind, @line, @col, @filePath, @language, @candidates)
      `);
    }

    const insertMany = this.db.transaction((refs: UnresolvedReference[]) => {
      for (const ref of refs) {
        this.stmts.insertUnresolved!.run({
          fromNodeId: ref.fromNodeId,
          referenceName: ref.referenceName,
          referenceKind: ref.referenceKind,
          line: ref.line,
          col: ref.column,
          filePath: ref.filePath,
          language: ref.language,
          candidates: ref.candidates ? JSON.stringify(ref.candidates) : null,
        });
      }
    });

    insertMany(refs);
  }

  /**
   * Delete unresolved references from a node
   */
  deleteUnresolvedByNode(nodeId: string): void {
    if (!this.stmts.deleteUnresolvedByNode) {
      this.stmts.deleteUnresolvedByNode = this.db.prepare(
        'DELETE FROM unresolved_refs WHERE from_node_id = ?'
      );
    }
    this.stmts.deleteUnresolvedByNode.run(nodeId);
  }

  /**
   * Get unresolved references by name (for resolution)
   */
  getUnresolvedByName(name: string): UnresolvedReference[] {
    if (!this.stmts.getUnresolvedByName) {
      this.stmts.getUnresolvedByName = this.db.prepare(
        'SELECT * FROM unresolved_refs WHERE reference_name = ?'
      );
    }
    const rows = this.stmts.getUnresolvedByName.all(name) as UnresolvedRefRow[];
    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      filePath: row.file_path,
      language: row.language as Language,
      candidates: row.candidates ? JSON.parse(row.candidates) : undefined,
    }));
  }

  /**
   * Get all unresolved references
   */
  getUnresolvedReferences(): UnresolvedReference[] {
    const rows = this.db.prepare('SELECT * FROM unresolved_refs').all() as UnresolvedRefRow[];
    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      filePath: row.file_path,
      language: row.language as Language,
      candidates: row.candidates ? JSON.parse(row.candidates) : undefined,
    }));
  }

  /**
   * Delete all unresolved references (after resolution)
   */
  clearUnresolvedReferences(): void {
    this.db.exec('DELETE FROM unresolved_refs');
  }

  /**
   * Set a project metadata key/value pair.
   */
  setProjectMetadata(key: string, value: string): void {
    if (!this.stmts.upsertProjectMetadata) {
      this.stmts.upsertProjectMetadata = this.db.prepare(`
        INSERT INTO project_metadata (key, value, updated_at)
        VALUES (@key, @value, @updatedAt)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `);
    }
    this.stmts.upsertProjectMetadata.run({
      key,
      value,
      updatedAt: Date.now(),
    });
  }

  /**
   * Set a project metadata key/value pair only if the key doesn't exist yet.
   */
  setProjectMetadataIfMissing(key: string, value: string): void {
    this.db
      .prepare(`
        INSERT OR IGNORE INTO project_metadata (key, value, updated_at)
        VALUES (?, ?, ?)
      `)
      .run(key, value, Date.now());
  }

  /**
   * Get a project metadata value by key.
   */
  getProjectMetadata(key: string): string | undefined {
    if (!this.stmts.getProjectMetadata) {
      this.stmts.getProjectMetadata = this.db.prepare(`
        SELECT key, value, updated_at
        FROM project_metadata
        WHERE key = ?
      `);
    }
    const row = this.stmts.getProjectMetadata.get(key) as ProjectMetadataRow | undefined;
    return row?.value;
  }

  /**
   * Delete resolved references by their IDs
   */
  deleteResolvedReferences(fromNodeIds: string[]): void {
    if (fromNodeIds.length === 0) return;
    const placeholders = fromNodeIds.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM unresolved_refs WHERE from_node_id IN (${placeholders})`).run(...fromNodeIds);
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Get graph statistics
   */
  getStats(): GraphStats {
    const nodeCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM nodes').get() as { count: number }
    ).count;

    const edgeCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM edges').get() as { count: number }
    ).count;

    const fileCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM files').get() as { count: number }
    ).count;

    const nodesByKind = {} as Record<NodeKind, number>;
    const nodeKindRows = this.db
      .prepare('SELECT kind, COUNT(*) as count FROM nodes GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    for (const row of nodeKindRows) {
      nodesByKind[row.kind as NodeKind] = row.count;
    }

    const edgesByKind = {} as Record<EdgeKind, number>;
    const edgeKindRows = this.db
      .prepare('SELECT kind, COUNT(*) as count FROM edges GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    for (const row of edgeKindRows) {
      edgesByKind[row.kind as EdgeKind] = row.count;
    }

    const filesByLanguage = {} as Record<Language, number>;
    const languageRows = this.db
      .prepare('SELECT language, COUNT(*) as count FROM files GROUP BY language')
      .all() as Array<{ language: string; count: number }>;
    for (const row of languageRows) {
      filesByLanguage[row.language as Language] = row.count;
    }

    const firstIndexedByVersion = this.getProjectMetadata('first_indexed_by_version');
    const firstIndexedAtRaw = this.getProjectMetadata('first_indexed_at');
    const lastSyncedByVersion = this.getProjectMetadata('last_synced_by_version');
    const lastSyncedAtRaw = this.getProjectMetadata('last_synced_at');
    const scipLastImportedAtRaw = this.getProjectMetadata('scip_last_imported_at');
    const scipLastImportedPath = this.getProjectMetadata('scip_last_imported_path');
    const scipLastImportedEdgesRaw = this.getProjectMetadata('scip_last_imported_edges');
    const scipLastImportedFingerprint = this.getProjectMetadata('scip_last_imported_fingerprint');
    const scipLastDocumentsRaw = this.getProjectMetadata('scip_last_documents');
    const scipLastOccurrencesRaw = this.getProjectMetadata('scip_last_occurrences');
    const scipLastGeneratedAtRaw = this.getProjectMetadata('scip_last_generated_at');
    const scipLastGeneratedBy = this.getProjectMetadata('scip_last_generated_by');
    const scipLastGenerateError = this.getProjectMetadata('scip_last_generate_error');

    return {
      nodeCount,
      edgeCount,
      fileCount,
      nodesByKind,
      edgesByKind,
      filesByLanguage,
      dbSizeBytes: 0, // Set by caller using DatabaseConnection.getSize()
      lastUpdated: Date.now(),
      indexProvenance: {
        firstIndexedByVersion: firstIndexedByVersion || undefined,
        firstIndexedAt: firstIndexedAtRaw ? Number(firstIndexedAtRaw) : undefined,
        lastSyncedByVersion: lastSyncedByVersion || undefined,
        lastSyncedAt: lastSyncedAtRaw ? Number(lastSyncedAtRaw) : undefined,
      },
      scipProvenance: {
        lastImportedAt: scipLastImportedAtRaw ? Number(scipLastImportedAtRaw) : undefined,
        lastImportedPath: scipLastImportedPath || undefined,
        lastImportedEdges: scipLastImportedEdgesRaw ? Number(scipLastImportedEdgesRaw) : undefined,
        lastImportedFingerprint: scipLastImportedFingerprint || undefined,
        lastDocuments: scipLastDocumentsRaw ? Number(scipLastDocumentsRaw) : undefined,
        lastOccurrences: scipLastOccurrencesRaw ? Number(scipLastOccurrencesRaw) : undefined,
        lastGeneratedAt: scipLastGeneratedAtRaw ? Number(scipLastGeneratedAtRaw) : undefined,
        lastGeneratedBy: scipLastGeneratedBy || undefined,
        lastGenerateError: scipLastGenerateError || undefined,
      },
    };
  }

  /**
   * Clear all data from the database
   */
  clear(): void {
    this.nodeCache.clear();
    this.db.transaction(() => {
      this.db.exec('DELETE FROM unresolved_refs');
      this.db.exec('DELETE FROM vectors');
      this.db.exec('DELETE FROM edges');
      this.db.exec('DELETE FROM nodes');
      this.db.exec('DELETE FROM files');
      this.db.exec('DELETE FROM project_metadata');
    })();
  }
}
