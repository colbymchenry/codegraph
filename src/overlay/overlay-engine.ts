/**
 * Overlay Query Engine
 *
 * Merges query results from a remote base graph and a local overlay
 * database, providing a seamless unified view of the code knowledge
 * graph to downstream consumers (GraphTraverser, ContextBuilder, MCP).
 *
 * Merge semantics:
 *   - Nodes in overlay files → always served from the overlay DB
 *   - Nodes in deleted files → hidden (not returned)
 *   - All other nodes → served from the base DB
 *   - Edges whose source is in an overlay file → served from overlay DB
 *   - Edges whose source is in a deleted file → hidden
 *   - All other edges → served from base DB
 *   - Search results → merged from both DBs, overlay wins on conflict
 *
 * The engine extends QueryBuilder so it can be passed to any component
 * that expects one (GraphTraverser, GraphQueryManager, ContextBuilder,
 * ReferenceResolver). Write operations go to the overlay DB only;
 * the base DB is treated as read-only.
 */

import { SqliteDatabase } from '../db/sqlite-adapter';
import { QueryBuilder } from '../db/queries';
import {
  Node,
  Edge,
  EdgeKind,
  NodeKind,
  FileRecord,
  GraphStats,
  Language,
  SearchOptions,
  SearchResult,
} from '../types';

/**
 * Query engine that overlays local branch changes on top of a remote
 * base graph, presenting a unified view to all consumers.
 *
 * Extends QueryBuilder so it is a drop-in replacement wherever a
 * QueryBuilder is expected. The overlay (local) database is the
 * "primary" store (writes go here); the base database supplements
 * read queries for files not present in the overlay.
 */
export class OverlayQueryEngine extends QueryBuilder {
  private baseQueries: QueryBuilder;
  private overlayFilePaths: Set<string>;
  private deletedFilePaths: Set<string>;

  /**
   * @param overlayDb       - SQLite database for the local overlay (feature branch changes)
   * @param baseQueries     - QueryBuilder backed by the remote base graph (read-only)
   * @param overlayFiles    - Set of file paths that were re-indexed locally (added/modified)
   * @param deletedFiles    - Set of file paths deleted on the feature branch
   */
  constructor(
    overlayDb: SqliteDatabase,
    baseQueries: QueryBuilder,
    overlayFiles: Set<string>,
    deletedFiles?: Set<string>
  ) {
    super(overlayDb);
    this.baseQueries = baseQueries;
    this.overlayFilePaths = overlayFiles;
    this.deletedFilePaths = deletedFiles ?? new Set();
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /** The set of file paths whose data comes from the local overlay DB. */
  getOverlayFilePaths(): Set<string> {
    return this.overlayFilePaths;
  }

  /** The set of file paths deleted on the feature branch (masked from base). */
  getDeletedFilePaths(): Set<string> {
    return this.deletedFilePaths;
  }

  /** The base (remote) QueryBuilder for direct access when needed. */
  getBaseQueries(): QueryBuilder {
    return this.baseQueries;
  }

  // ---------------------------------------------------------------------------
  // Node read overrides
  // ---------------------------------------------------------------------------

  /**
   * Get a node by ID, checking overlay first then base.
   *
   * If the node's file is in the overlay set, only the overlay version
   * is returned (the base version is stale). If the file was deleted,
   * null is returned even if the base DB has it.
   */
  override getNodeById(id: string): Node | null {
    // Overlay DB is authoritative for overlay files
    const overlayNode = super.getNodeById(id);
    if (overlayNode) return overlayNode;

    // Fall back to base DB, but skip overlay/deleted files
    const baseNode = this.baseQueries.getNodeById(id);
    if (baseNode && this.isBaseFileVisible(baseNode.filePath)) {
      return baseNode;
    }

    return null;
  }

  /**
   * Get all nodes in a file, routed by file ownership.
   *
   * Files in the overlay set are served entirely from the overlay DB.
   * Deleted files return empty. All others come from the base DB.
   */
  override getNodesByFile(filePath: string): Node[] {
    if (this.deletedFilePaths.has(filePath)) return [];
    if (this.overlayFilePaths.has(filePath)) return super.getNodesByFile(filePath);
    return this.baseQueries.getNodesByFile(filePath);
  }

  /**
   * Get all nodes of a specific kind, merged from both databases.
   * Overlay files replace their base counterparts; deleted files are excluded.
   */
  override getNodesByKind(kind: NodeKind): Node[] {
    const overlayNodes = super.getNodesByKind(kind);
    const baseNodes = this.baseQueries.getNodesByKind(kind);
    return this.mergeNodes(overlayNodes, baseNodes);
  }

  /**
   * Get all nodes across both databases.
   */
  override getAllNodes(): Node[] {
    const overlayNodes = super.getAllNodes();
    const baseNodes = this.baseQueries.getAllNodes();
    return this.mergeNodes(overlayNodes, baseNodes);
  }

  /**
   * Get nodes by exact name, merged from both databases.
   */
  override getNodesByName(name: string): Node[] {
    const overlayNodes = super.getNodesByName(name);
    const baseNodes = this.baseQueries.getNodesByName(name);
    return this.mergeNodes(overlayNodes, baseNodes);
  }

  /**
   * Get nodes by exact qualified name, merged from both databases.
   */
  override getNodesByQualifiedNameExact(qualifiedName: string): Node[] {
    const overlayNodes = super.getNodesByQualifiedNameExact(qualifiedName);
    const baseNodes = this.baseQueries.getNodesByQualifiedNameExact(qualifiedName);
    return this.mergeNodes(overlayNodes, baseNodes);
  }

  /**
   * Get nodes by lowercase name, merged from both databases.
   */
  override getNodesByLowerName(lowerName: string): Node[] {
    const overlayNodes = super.getNodesByLowerName(lowerName);
    const baseNodes = this.baseQueries.getNodesByLowerName(lowerName);
    return this.mergeNodes(overlayNodes, baseNodes);
  }

  // ---------------------------------------------------------------------------
  // Search overrides
  // ---------------------------------------------------------------------------

  /**
   * Search nodes across both databases, merging and deduplicating results.
   *
   * Runs the full search pipeline (FTS5 + LIKE + fuzzy) on each database
   * independently, then merges. Overlay results take priority for nodes
   * whose files are in the overlay set.
   */
  override searchNodes(query: string, options?: SearchOptions): SearchResult[] {
    const overlayResults = super.searchNodes(query, options);
    const baseResults = this.baseQueries.searchNodes(query, options);

    return this.mergeSearchResults(overlayResults, baseResults);
  }

  /**
   * Find nodes by exact name across both databases.
   */
  override findNodesByExactName(
    names: string[],
    options?: SearchOptions
  ): SearchResult[] {
    const overlayResults = super.findNodesByExactName(names, options);
    const baseResults = this.baseQueries.findNodesByExactName(names, options);
    return this.mergeSearchResults(overlayResults, baseResults);
  }

  /**
   * Find nodes whose name contains a substring, merged from both databases.
   */
  override findNodesByNameSubstring(
    substring: string,
    options?: SearchOptions & { excludePrefix?: boolean }
  ): SearchResult[] {
    const overlayResults = super.findNodesByNameSubstring(substring, options);
    const baseResults = this.baseQueries.findNodesByNameSubstring(substring, options);
    return this.mergeSearchResults(overlayResults, baseResults);
  }

  // ---------------------------------------------------------------------------
  // Edge read overrides
  // ---------------------------------------------------------------------------

  /**
   * Get outgoing edges from a node.
   *
   * If the source node is in an overlay file, edges come from the
   * overlay DB (the file was re-indexed, so these are authoritative).
   * Otherwise edges come from the base DB.
   */
  override getOutgoingEdges(sourceId: string, kinds?: EdgeKind[], provenance?: string): Edge[] {
    if (this.isNodeInOverlayDb(sourceId)) {
      return super.getOutgoingEdges(sourceId, kinds, provenance);
    }
    // Check if the node is in a base file (not overlay/deleted)
    const baseNode = this.baseQueries.getNodeById(sourceId);
    if (baseNode && this.isBaseFileVisible(baseNode.filePath)) {
      return this.baseQueries.getOutgoingEdges(sourceId, kinds);
    }
    return [];
  }

  /**
   * Get incoming edges to a node, merged from both databases.
   *
   * Incoming edges can originate from either DB:
   *   - Base DB: edges from unchanged files pointing to this node
   *   - Overlay DB: edges from changed files pointing to this node
   *
   * Base edges whose source is in an overlay or deleted file are
   * filtered out (they are stale — the overlay DB has the fresh version).
   */
  override getIncomingEdges(targetId: string, kinds?: EdgeKind[]): Edge[] {
    const overlayEdges = super.getIncomingEdges(targetId, kinds);
    const baseEdges = this.baseQueries.getIncomingEdges(targetId, kinds);

    // Filter base edges: remove those from overlay/deleted files
    const filteredBase = baseEdges.filter(
      (e) => !this.isSourceInOverlayOrDeletedFile(e.source)
    );

    return this.deduplicateEdges(overlayEdges, filteredBase);
  }

  /**
   * Find edges between a set of nodes, merged from both databases.
   */
  override findEdgesBetweenNodes(nodeIds: string[], kinds?: EdgeKind[]): Edge[] {
    const overlayEdges = super.findEdgesBetweenNodes(nodeIds, kinds);
    const baseEdges = this.baseQueries.findEdgesBetweenNodes(nodeIds, kinds);

    const filteredBase = baseEdges.filter(
      (e) => !this.isSourceInOverlayOrDeletedFile(e.source)
    );

    return this.deduplicateEdges(overlayEdges, filteredBase);
  }

  // ---------------------------------------------------------------------------
  // File read overrides
  // ---------------------------------------------------------------------------

  /**
   * Get a file record by path, routed by ownership.
   */
  override getFileByPath(filePath: string): FileRecord | null {
    if (this.deletedFilePaths.has(filePath)) return null;
    if (this.overlayFilePaths.has(filePath)) return super.getFileByPath(filePath);
    return this.baseQueries.getFileByPath(filePath);
  }

  /**
   * Get all tracked files, merged from both databases.
   * Overlay files replace base counterparts; deleted files are excluded.
   */
  override getAllFiles(): FileRecord[] {
    const overlayFiles = super.getAllFiles();
    const baseFiles = this.baseQueries.getAllFiles();

    const result = new Map<string, FileRecord>();

    // Base files first (lower priority)
    for (const file of baseFiles) {
      if (this.isBaseFileVisible(file.path)) {
        result.set(file.path, file);
      }
    }

    // Overlay files replace base counterparts
    for (const file of overlayFiles) {
      result.set(file.path, file);
    }

    return Array.from(result.values());
  }

  /**
   * Get all tracked file paths, merged from both databases.
   */
  override getAllFilePaths(): string[] {
    const overlayPaths = new Set(super.getAllFilePaths());
    const basePaths = this.baseQueries.getAllFilePaths();

    for (const p of basePaths) {
      if (this.isBaseFileVisible(p)) {
        overlayPaths.add(p);
      }
    }

    return Array.from(overlayPaths).sort();
  }

  /**
   * Get all distinct node names, merged from both databases.
   */
  override getAllNodeNames(): string[] {
    const overlayNames = new Set(super.getAllNodeNames());
    const baseNames = this.baseQueries.getAllNodeNames();

    for (const name of baseNames) {
      overlayNames.add(name);
    }

    return Array.from(overlayNames);
  }

  // ---------------------------------------------------------------------------
  // Statistics override
  // ---------------------------------------------------------------------------

  /**
   * Get merged graph statistics from both databases.
   *
   * File/node/edge counts are computed by combining base counts
   * (excluding overlay & deleted files) with overlay counts.
   */
  override getStats(): GraphStats {
    const baseStats = this.baseQueries.getStats();
    const overlayStats = super.getStats();

    // Approximate merged counts: overlay replaces base for overlay files.
    // For a precise count we'd need to query per-file node counts in the
    // base, which is expensive. The approximation is close enough for
    // informational display (codegraph status, MCP status tool).
    const maskedFileCount = this.overlayFilePaths.size + this.deletedFilePaths.size;
    const adjustedBaseFileCount = Math.max(0, baseStats.fileCount - maskedFileCount);

    const mergedNodesByKind = { ...baseStats.nodesByKind };
    for (const [kind, count] of Object.entries(overlayStats.nodesByKind)) {
      mergedNodesByKind[kind as NodeKind] =
        (mergedNodesByKind[kind as NodeKind] ?? 0) + count;
    }

    const mergedEdgesByKind = { ...baseStats.edgesByKind };
    for (const [kind, count] of Object.entries(overlayStats.edgesByKind)) {
      mergedEdgesByKind[kind as EdgeKind] =
        (mergedEdgesByKind[kind as EdgeKind] ?? 0) + count;
    }

    const mergedFilesByLang = { ...baseStats.filesByLanguage };
    for (const [lang, count] of Object.entries(overlayStats.filesByLanguage)) {
      mergedFilesByLang[lang as Language] =
        (mergedFilesByLang[lang as Language] ?? 0) + count;
    }

    return {
      nodeCount: baseStats.nodeCount + overlayStats.nodeCount,
      edgeCount: baseStats.edgeCount + overlayStats.edgeCount,
      fileCount: adjustedBaseFileCount + overlayStats.fileCount,
      nodesByKind: mergedNodesByKind,
      edgesByKind: mergedEdgesByKind,
      filesByLanguage: mergedFilesByLang,
      dbSizeBytes: baseStats.dbSizeBytes + overlayStats.dbSizeBytes,
      lastUpdated: Math.max(baseStats.lastUpdated, overlayStats.lastUpdated),
    };
  }

  // ---------------------------------------------------------------------------
  // Cache override
  // ---------------------------------------------------------------------------

  /**
   * Clear node caches in both the overlay and base QueryBuilders.
   */
  override clearCache(): void {
    super.clearCache();
    this.baseQueries.clearCache();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Check whether a base-DB file is visible (not masked by overlay or deletion).
   *
   * @param filePath - Relative file path
   * @returns true if the file should be served from the base DB
   */
  private isBaseFileVisible(filePath: string): boolean {
    return (
      !this.overlayFilePaths.has(filePath) &&
      !this.deletedFilePaths.has(filePath)
    );
  }

  /**
   * Check whether a node exists in the overlay DB (i.e., its file is
   * an overlay file and the node was re-indexed).
   */
  private isNodeInOverlayDb(nodeId: string): boolean {
    const node = super.getNodeById(nodeId);
    return node !== null;
  }

  /**
   * Check whether the source of an edge is in an overlay or deleted file.
   *
   * Used to filter stale base-DB edges. If the source node's file was
   * re-indexed or deleted, the base-DB edge is outdated.
   */
  private isSourceInOverlayOrDeletedFile(sourceNodeId: string): boolean {
    // Check overlay DB first (cheap, cached)
    const overlayNode = super.getNodeById(sourceNodeId);
    if (overlayNode && this.overlayFilePaths.has(overlayNode.filePath)) {
      return true;
    }

    // Check base DB for deleted-file nodes
    const baseNode = this.baseQueries.getNodeById(sourceNodeId);
    if (baseNode) {
      return (
        this.overlayFilePaths.has(baseNode.filePath) ||
        this.deletedFilePaths.has(baseNode.filePath)
      );
    }

    return false;
  }

  /**
   * Merge node arrays from overlay and base, with overlay taking
   * priority for files in the overlay set. Deleted-file nodes are excluded.
   */
  private mergeNodes(overlayNodes: Node[], baseNodes: Node[]): Node[] {
    const result = new Map<string, Node>();

    // Base nodes first (lower priority)
    for (const node of baseNodes) {
      if (this.isBaseFileVisible(node.filePath)) {
        result.set(node.id, node);
      }
    }

    // Overlay nodes overwrite base for same ID
    for (const node of overlayNodes) {
      result.set(node.id, node);
    }

    return Array.from(result.values());
  }

  /**
   * Merge search results from overlay and base.
   *
   * - Overlay results always win for nodes in overlay files
   * - Base results for overlay/deleted files are excluded
   * - Duplicates (same node ID) keep the higher score
   * - Final list is sorted by score descending
   */
  private mergeSearchResults(
    overlayResults: SearchResult[],
    baseResults: SearchResult[]
  ): SearchResult[] {
    const resultMap = new Map<string, SearchResult>();

    // Overlay results first (higher priority)
    for (const r of overlayResults) {
      resultMap.set(r.node.id, r);
    }

    // Base results: skip overlay/deleted file nodes, keep higher score on dup
    for (const r of baseResults) {
      if (!this.isBaseFileVisible(r.node.filePath)) continue;

      const existing = resultMap.get(r.node.id);
      if (existing) {
        if (r.score > existing.score) {
          existing.score = r.score;
        }
      } else {
        resultMap.set(r.node.id, r);
      }
    }

    // Sort by score descending
    return Array.from(resultMap.values()).sort((a, b) => b.score - a.score);
  }

  /**
   * Deduplicate edges from overlay and base.
   *
   * Overlay edges take priority. Deduplication key is
   * `source|target|kind`.
   */
  private deduplicateEdges(overlayEdges: Edge[], baseEdges: Edge[]): Edge[] {
    const seen = new Set<string>();
    const result: Edge[] = [];

    // Overlay edges first (higher priority)
    for (const edge of overlayEdges) {
      const key = `${edge.source}|${edge.target}|${edge.kind}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(edge);
      }
    }

    // Base edges (skip duplicates)
    for (const edge of baseEdges) {
      const key = `${edge.source}|${edge.target}|${edge.kind}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(edge);
      }
    }

    return result;
  }
}
