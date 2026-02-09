/**
 * CodeGraph
 *
 * A local-first code intelligence system that builds a semantic
 * knowledge graph from any codebase.
 */

import * as path from 'path';
import {
  CodeGraphConfig,
  Node,
  Edge,
  FileRecord,
  ExtractionResult,
  Subgraph,
  TraversalOptions,
  SearchOptions,
  SearchResult,
  Context,
  GraphStats,
  TaskInput,
  TaskContext,
  BuildContextOptions,
  FindRelevantContextOptions,
} from './types';
import { DatabaseConnection, getDatabasePath } from './db';
import { QueryBuilder } from './db/queries';
import { loadConfig, saveConfig, createDefaultConfig, validateConfig } from './config';
import {
  isInitialized,
  createDirectory,
  removeDirectory,
  validateDirectory,
} from './directory';
import {
  ExtractionOrchestrator,
  IndexProgress,
  IndexResult,
  SyncResult,
  extractFromSource,
} from './extraction';
import {
  ReferenceResolver,
  createResolver,
  ResolutionResult,
} from './resolution';
import { GraphTraverser, GraphQueryManager } from './graph';
import { VectorManager, createVectorManager, EmbeddingProgress } from './vectors';
import { ContextBuilder, createContextBuilder } from './context';
import { GitHooksManager, createGitHooksManager, HookInstallResult, HookRemoveResult } from './sync';
import { Mutex, FileLock } from './utils';

// Re-export types for consumers
export * from './types';
export { getDatabasePath } from './db';
export { getConfigPath } from './config';
export { getCodeGraphDir, isInitialized } from './directory';
export { IndexProgress, IndexResult, SyncResult } from './extraction';
export { detectLanguage, isLanguageSupported, getSupportedLanguages } from './extraction';
export { ResolutionResult } from './resolution';
export { EmbeddingProgress } from './vectors';
export { HookInstallResult, HookRemoveResult } from './sync';
export {
  CodeGraphError,
  FileError,
  ParseError,
  DatabaseError,
  SearchError,
  VectorError,
  ConfigError,
  Logger,
  setLogger,
  getLogger,
  silentLogger,
  defaultLogger,
} from './errors';
export { Mutex, FileLock, processInBatches, debounce, throttle, MemoryMonitor } from './utils';
export { MCPServer } from './mcp';

/**
 * Options for initializing a new CodeGraph project
 */
export interface InitOptions {
  /** Custom configuration overrides */
  config?: Partial<CodeGraphConfig>;

  /** Whether to run initial indexing after init */
  index?: boolean;

  /** Progress callback for indexing */
  onProgress?: (progress: IndexProgress) => void;
}

/**
 * Options for opening an existing CodeGraph project
 */
export interface OpenOptions {
  /** Whether to run sync if files have changed */
  sync?: boolean;

  /** Whether to run in read-only mode */
  readOnly?: boolean;
}

/**
 * Options for indexing
 */
export interface IndexOptions {
  /** Progress callback */
  onProgress?: (progress: IndexProgress) => void;

  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Main CodeGraph class
 *
 * Provides the primary interface for interacting with the code knowledge graph.
 */
export class CodeGraph {
  private db: DatabaseConnection;
  private queries: QueryBuilder;
  private config: CodeGraphConfig;
  private projectRoot: string;
  private orchestrator: ExtractionOrchestrator;
  private resolver: ReferenceResolver;
  private graphManager: GraphQueryManager;
  private traverser: GraphTraverser;
  private vectorManager: VectorManager | null = null;
  private contextBuilder: ContextBuilder;
  private gitHooksManager: GitHooksManager;

  // Mutex for preventing concurrent indexing within this process
  private indexMutex = new Mutex();
  // File lock for preventing concurrent writes across processes
  private fileLock: FileLock;

  private constructor(
    db: DatabaseConnection,
    queries: QueryBuilder,
    config: CodeGraphConfig,
    projectRoot: string
  ) {
    this.db = db;
    this.queries = queries;
    this.config = config;
    this.projectRoot = projectRoot;
    this.orchestrator = new ExtractionOrchestrator(projectRoot, config, queries);
    this.resolver = createResolver(projectRoot, queries);
    this.graphManager = new GraphQueryManager(queries);
    this.traverser = new GraphTraverser(queries);
    // Vector manager is created lazily when embeddings are enabled
    if (config.enableEmbeddings) {
      this.vectorManager = createVectorManager(db.getDb(), queries, {
        embedder: {
          cacheDir: path.join(projectRoot, '.codegraph', 'models'),
        },
      });
    }
    // Context builder (uses vector manager if available)
    this.contextBuilder = createContextBuilder(
      projectRoot,
      queries,
      this.traverser,
      this.vectorManager
    );
    // Git hooks manager
    this.gitHooksManager = createGitHooksManager(projectRoot);
    // Cross-process file lock
    this.fileLock = new FileLock(
      path.join(projectRoot, '.codegraph', 'codegraph.lock')
    );
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  /**
   * Initialize a new CodeGraph project
   *
   * Creates the .codegraph directory, database, and configuration.
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Initialization options
   * @returns A new CodeGraph instance
   */
  static async init(projectRoot: string, options: InitOptions = {}): Promise<CodeGraph> {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Create and save configuration
    const config = createDefaultConfig(resolvedRoot);
    if (options.config) {
      Object.assign(config, options.config);
    }
    if (!validateConfig(config)) {
      throw new Error('Invalid configuration after merge');
    }
    saveConfig(resolvedRoot, config);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new CodeGraph(db, queries, config, resolvedRoot);

    // Run initial indexing if requested
    if (options.index) {
      await instance.indexAll({ onProgress: options.onProgress });
    }

    return instance;
  }

  /**
   * Initialize synchronously (without indexing)
   */
  static initSync(projectRoot: string, options: Omit<InitOptions, 'index' | 'onProgress'> = {}): CodeGraph {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Create and save configuration
    const config = createDefaultConfig(resolvedRoot);
    if (options.config) {
      Object.assign(config, options.config);
    }
    if (!validateConfig(config)) {
      throw new Error('Invalid configuration after merge');
    }
    saveConfig(resolvedRoot, config);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    return new CodeGraph(db, queries, config, resolvedRoot);
  }

  /**
   * Open an existing CodeGraph project
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Open options
   * @returns A CodeGraph instance
   */
  static async open(projectRoot: string, options: OpenOptions = {}): Promise<CodeGraph> {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if initialized
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid CodeGraph directory: ${validation.errors.join(', ')}`);
    }

    // Load configuration
    const config = loadConfig(resolvedRoot);

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new CodeGraph(db, queries, config, resolvedRoot);

    // Sync if requested
    if (options.sync) {
      await instance.sync();
    }

    return instance;
  }

  /**
   * Open synchronously (without sync)
   */
  static openSync(projectRoot: string): CodeGraph {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if initialized
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid CodeGraph directory: ${validation.errors.join(', ')}`);
    }

    // Load configuration
    const config = loadConfig(resolvedRoot);

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());

    return new CodeGraph(db, queries, config, resolvedRoot);
  }

  /**
   * Check if a directory has been initialized as a CodeGraph project
   */
  static isInitialized(projectRoot: string): boolean {
    return isInitialized(path.resolve(projectRoot));
  }

  /**
   * Close the CodeGraph instance and release resources
   */
  close(): void {
    this.fileLock.release();
    this.db.close();
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * Get the current configuration
   */
  getConfig(): CodeGraphConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<CodeGraphConfig>): void {
    const merged = { ...this.config, ...updates };
    if (!validateConfig(merged)) {
      throw new Error('Invalid configuration after merge');
    }
    this.config = merged;
    saveConfig(this.projectRoot, this.config);
    // Recreate orchestrator and resolver with new config
    this.orchestrator = new ExtractionOrchestrator(
      this.projectRoot,
      this.config,
      this.queries
    );
    this.resolver = createResolver(this.projectRoot, this.queries);
  }

  /**
   * Get the project root directory
   */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  // ===========================================================================
  // Indexing
  // ===========================================================================

  /**
   * Index all files in the project
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexAll(options: IndexOptions = {}): Promise<IndexResult> {
    return this.fileLock.withLockAsync(() =>
      this.indexMutex.withLock(async () => {
        const result = await this.orchestrator.indexAll(options.onProgress, options.signal);

        // Resolve references to create call/import/extends edges
        if (result.success && result.filesIndexed > 0) {
          options.onProgress?.({
            phase: 'resolving',
            current: 0,
            total: 1,
          });
          this.resolveReferences();
        }

        return result;
      })
    );
  }

  /**
   * Index specific files
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    return this.fileLock.withLockAsync(() =>
      this.indexMutex.withLock(async () => {
        return this.orchestrator.indexFiles(filePaths);
      })
    );
  }

  /**
   * Sync with current file state (incremental update)
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async sync(options: IndexOptions = {}): Promise<SyncResult> {
    return this.fileLock.withLockAsync(() =>
      this.indexMutex.withLock(async () => {
        const result = await this.orchestrator.sync(options.onProgress);

        // Resolve references if files were updated
        if (result.filesAdded > 0 || result.filesModified > 0) {
          this.resolveReferences();
        }

        return result;
      })
    );
  }

  /**
   * Check if an indexing operation is currently in progress
   */
  isIndexing(): boolean {
    return this.indexMutex.isLocked();
  }

  /**
   * Get files that have changed since last index
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    return this.orchestrator.getChangedFiles();
  }

  /**
   * Extract nodes and edges from source code (without storing)
   */
  extractFromSource(filePath: string, source: string): ExtractionResult {
    return extractFromSource(filePath, source);
  }

  // ===========================================================================
  // Reference Resolution
  // ===========================================================================

  /**
   * Resolve unresolved references and create edges
   *
   * This method takes unresolved references from extraction and attempts
   * to resolve them using multiple strategies:
   * - Framework-specific patterns (React, Express, Laravel)
   * - Import-based resolution
   * - Name-based symbol matching
   */
  resolveReferences(): ResolutionResult {
    // Get all unresolved references from the database
    const unresolvedRefs = this.queries.getUnresolvedReferences();
    return this.resolver.resolveAndPersist(unresolvedRefs);
  }

  /**
   * Get detected frameworks in the project
   */
  getDetectedFrameworks(): string[] {
    return this.resolver.getDetectedFrameworks();
  }

  /**
   * Re-initialize the resolver (useful after adding new files)
   */
  reinitializeResolver(): void {
    this.resolver.initialize();
  }

  // ===========================================================================
  // Graph Statistics
  // ===========================================================================

  /**
   * Get statistics about the knowledge graph
   */
  getStats(): GraphStats {
    const stats = this.queries.getStats();
    stats.dbSizeBytes = this.db.getSize();
    return stats;
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  /**
   * Get a node by ID
   */
  getNode(id: string): Node | null {
    return this.queries.getNodeById(id);
  }

  /**
   * Get all nodes in a file
   */
  getNodesInFile(filePath: string): Node[] {
    return this.queries.getNodesByFile(filePath);
  }

  /**
   * Get all nodes of a specific kind
   */
  getNodesByKind(kind: Node['kind']): Node[] {
    return this.queries.getNodesByKind(kind);
  }

  /**
   * Search nodes by text
   */
  searchNodes(query: string, options?: SearchOptions): SearchResult[] {
    return this.queries.searchNodes(query, options);
  }

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  /**
   * Get outgoing edges from a node
   */
  getOutgoingEdges(nodeId: string): Edge[] {
    return this.queries.getOutgoingEdges(nodeId);
  }

  /**
   * Get incoming edges to a node
   */
  getIncomingEdges(nodeId: string): Edge[] {
    return this.queries.getIncomingEdges(nodeId);
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Get a file record by path
   */
  getFile(filePath: string): FileRecord | null {
    return this.queries.getFileByPath(filePath);
  }

  /**
   * Get all tracked files
   */
  getFiles(): FileRecord[] {
    return this.queries.getAllFiles();
  }

  // ===========================================================================
  // Graph Query Methods
  // ===========================================================================

  /**
   * Get the context for a node (ancestors, children, references)
   *
   * Returns comprehensive context about a node including its containment
   * hierarchy, children, incoming/outgoing references, type information,
   * and relevant imports.
   *
   * @param nodeId - ID of the focal node
   * @returns Context object with all related information
   */
  getContext(nodeId: string): Context {
    return this.graphManager.getContext(nodeId);
  }

  /**
   * Traverse the graph from a starting node
   *
   * Uses breadth-first search by default. Supports filtering by edge types,
   * node types, and traversal direction.
   *
   * @param startId - Starting node ID
   * @param options - Traversal options
   * @returns Subgraph containing traversed nodes and edges
   */
  traverse(startId: string, options?: TraversalOptions): Subgraph {
    return this.traverser.traverseBFS(startId, options);
  }

  /**
   * Get the call graph for a function
   *
   * Returns both callers (functions that call this function) and
   * callees (functions called by this function) up to the specified depth.
   *
   * @param nodeId - ID of the function/method node
   * @param depth - Maximum depth in each direction (default: 2)
   * @returns Subgraph containing the call graph
   */
  getCallGraph(nodeId: string, depth: number = 2): Subgraph {
    return this.traverser.getCallGraph(nodeId, depth);
  }

  /**
   * Get the type hierarchy for a class/interface
   *
   * Returns both ancestors (types this extends/implements) and
   * descendants (types that extend/implement this).
   *
   * @param nodeId - ID of the class/interface node
   * @returns Subgraph containing the type hierarchy
   */
  getTypeHierarchy(nodeId: string): Subgraph {
    return this.traverser.getTypeHierarchy(nodeId);
  }

  /**
   * Find all usages of a symbol
   *
   * Returns all nodes that reference the specified symbol through
   * any edge type (calls, references, type_of, etc.).
   *
   * @param nodeId - ID of the symbol node
   * @returns Array of nodes and edges that reference this symbol
   */
  findUsages(nodeId: string): Array<{ node: Node; edge: Edge }> {
    return this.traverser.findUsages(nodeId);
  }

  /**
   * Get callers of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes that call this function
   */
  getCallers(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallers(nodeId, maxDepth);
  }

  /**
   * Get callees of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes called by this function
   */
  getCallees(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallees(nodeId, maxDepth);
  }

  /**
   * Calculate the impact radius of a node
   *
   * Returns all nodes that could be affected by changes to this node.
   *
   * @param nodeId - ID of the node
   * @param maxDepth - Maximum depth to traverse (default: 3)
   * @returns Subgraph containing potentially impacted nodes
   */
  getImpactRadius(nodeId: string, maxDepth: number = 3): Subgraph {
    return this.traverser.getImpactRadius(nodeId, maxDepth);
  }

  /**
   * Find the shortest path between two nodes
   *
   * @param fromId - Starting node ID
   * @param toId - Target node ID
   * @param edgeKinds - Edge types to consider (all if empty)
   * @returns Array of nodes and edges forming the path, or null if no path exists
   */
  findPath(
    fromId: string,
    toId: string,
    edgeKinds?: Edge['kind'][]
  ): Array<{ node: Node; edge: Edge | null }> | null {
    return this.traverser.findPath(fromId, toId, edgeKinds);
  }

  /**
   * Get ancestors of a node in the containment hierarchy
   *
   * @param nodeId - ID of the node
   * @returns Array of ancestor nodes from immediate parent to root
   */
  getAncestors(nodeId: string): Node[] {
    return this.traverser.getAncestors(nodeId);
  }

  /**
   * Get immediate children of a node
   *
   * @param nodeId - ID of the node
   * @returns Array of child nodes
   */
  getChildren(nodeId: string): Node[] {
    return this.traverser.getChildren(nodeId);
  }

  /**
   * Get dependencies of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths this file depends on
   */
  getFileDependencies(filePath: string): string[] {
    return this.graphManager.getFileDependencies(filePath);
  }

  /**
   * Get dependents of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths that depend on this file
   */
  getFileDependents(filePath: string): string[] {
    return this.graphManager.getFileDependents(filePath);
  }

  /**
   * Find circular dependencies in the codebase
   *
   * @returns Array of cycles, each cycle is an array of file paths
   */
  findCircularDependencies(): string[][] {
    return this.graphManager.findCircularDependencies();
  }

  /**
   * Find dead code (unreferenced symbols)
   *
   * @param kinds - Node kinds to check (default: functions, methods, classes)
   * @returns Array of unreferenced nodes
   */
  findDeadCode(kinds?: Node['kind'][]): Node[] {
    return this.graphManager.findDeadCode(kinds);
  }

  /**
   * Get complexity metrics for a node
   *
   * @param nodeId - ID of the node
   * @returns Object containing various complexity metrics
   */
  getNodeMetrics(nodeId: string): {
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
  } {
    return this.graphManager.getNodeMetrics(nodeId);
  }

  // ===========================================================================
  // Semantic Search (Vector Embeddings)
  // ===========================================================================

  /**
   * Initialize the embedding system
   *
   * This downloads the embedding model on first use and initializes
   * the vector search system. Must be called before using semantic search.
   */
  async initializeEmbeddings(): Promise<void> {
    if (!this.vectorManager) {
      this.vectorManager = createVectorManager(this.db.getDb(), this.queries, {
        embedder: {
          showProgress: true,
        },
      });
    }
    await this.vectorManager.initialize();
  }

  /**
   * Check if embeddings are initialized
   */
  isEmbeddingsInitialized(): boolean {
    return this.vectorManager?.isInitialized() ?? false;
  }

  /**
   * Generate embeddings for all eligible nodes
   *
   * @param onProgress - Optional progress callback
   * @returns Number of nodes embedded
   */
  async generateEmbeddings(
    onProgress?: (progress: EmbeddingProgress) => void
  ): Promise<number> {
    if (!this.vectorManager) {
      await this.initializeEmbeddings();
    }
    return this.vectorManager!.embedAllNodes(onProgress);
  }

  /**
   * Semantic search using embeddings
   *
   * Searches for code nodes semantically similar to the query.
   * Requires embeddings to be initialized first.
   *
   * @param query - Natural language search query
   * @param limit - Maximum number of results (default: 10)
   * @returns Array of search results with similarity scores
   */
  async semanticSearch(query: string, limit: number = 10): Promise<SearchResult[]> {
    if (!this.vectorManager || !this.vectorManager.isInitialized()) {
      throw new Error(
        'Embeddings not initialized. Call initializeEmbeddings() first.'
      );
    }
    return this.vectorManager.search(query, { limit });
  }

  /**
   * Find similar code blocks
   *
   * Finds nodes semantically similar to a given node.
   * Requires embeddings to be initialized first.
   *
   * @param nodeId - ID of the node to find similar nodes for
   * @param limit - Maximum number of results (default: 10)
   * @returns Array of similar nodes with similarity scores
   */
  async findSimilar(nodeId: string, limit: number = 10): Promise<SearchResult[]> {
    if (!this.vectorManager || !this.vectorManager.isInitialized()) {
      throw new Error(
        'Embeddings not initialized. Call initializeEmbeddings() first.'
      );
    }
    return this.vectorManager.findSimilar(nodeId, { limit });
  }

  /**
   * Get vector embedding statistics
   */
  getEmbeddingStats(): {
    totalVectors: number;
    vssEnabled: boolean;
    modelId: string;
    dimension: number;
  } | null {
    if (!this.vectorManager) {
      return null;
    }
    return this.vectorManager.getStats();
  }

  // ===========================================================================
  // Context Building
  // ===========================================================================

  /**
   * Get the source code for a node
   *
   * Reads the file and extracts the code between startLine and endLine.
   *
   * @param nodeId - ID of the node
   * @returns Code string or null if not found
   */
  async getCode(nodeId: string): Promise<string | null> {
    return this.contextBuilder.getCode(nodeId);
  }

  /**
   * Find relevant subgraph for a query
   *
   * Combines semantic search with graph traversal to find the most
   * relevant nodes and their relationships for a given query.
   *
   * @param query - Natural language query describing the task
   * @param options - Search and traversal options
   * @returns Subgraph of relevant nodes and edges
   */
  async findRelevantContext(
    query: string,
    options?: FindRelevantContextOptions
  ): Promise<Subgraph> {
    // Update context builder with current vector manager
    this.contextBuilder = createContextBuilder(
      this.projectRoot,
      this.queries,
      this.traverser,
      this.vectorManager
    );
    return this.contextBuilder.findRelevantContext(query, options);
  }

  /**
   * Build context for a task
   *
   * Creates comprehensive context by:
   * 1. Running semantic search to find entry points
   * 2. Expanding the graph around entry points
   * 3. Extracting code blocks for key nodes
   * 4. Formatting output for Claude
   *
   * @param input - Task description (string or {title, description})
   * @param options - Build options (maxNodes, includeCode, format, etc.)
   * @returns TaskContext object or formatted string (markdown/JSON)
   */
  async buildContext(
    input: TaskInput,
    options?: BuildContextOptions
  ): Promise<TaskContext | string> {
    // Update context builder with current vector manager
    this.contextBuilder = createContextBuilder(
      this.projectRoot,
      this.queries,
      this.traverser,
      this.vectorManager
    );
    return this.contextBuilder.buildContext(input, options);
  }

  // ===========================================================================
  // Git Integration
  // ===========================================================================

  /**
   * Check if the project is a git repository
   */
  isGitRepository(): boolean {
    return this.gitHooksManager.isGitRepository();
  }

  /**
   * Check if the CodeGraph git hook is installed
   */
  isGitHookInstalled(): boolean {
    return this.gitHooksManager.isHookInstalled();
  }

  /**
   * Install git hooks for automatic incremental indexing
   *
   * Installs a post-commit hook that automatically runs `codegraph sync`
   * after each commit to keep the graph up-to-date.
   *
   * If a post-commit hook already exists:
   * - If it's a CodeGraph hook, it will be updated
   * - If it's a user hook, it will be backed up before installing
   *
   * @returns Result indicating success/failure and any messages
   */
  installGitHooks(): HookInstallResult {
    return this.gitHooksManager.installHook();
  }

  /**
   * Remove CodeGraph git hooks
   *
   * Removes the CodeGraph post-commit hook. If a backup of a previous
   * user hook exists, it will be restored.
   *
   * @returns Result indicating success/failure and any messages
   */
  removeGitHooks(): HookRemoveResult {
    return this.gitHooksManager.removeHook();
  }

  // ===========================================================================
  // Database Management
  // ===========================================================================

  /**
   * Optimize the database (vacuum and analyze)
   */
  optimize(): void {
    this.db.optimize();
  }

  /**
   * Clear all data from the graph
   */
  clear(): void {
    this.queries.clear();
  }

  /**
   * Alias for close() for backwards compatibility.
   * @deprecated Use close() instead
   */
  destroy(): void {
    this.close();
  }

  /**
   * Completely remove CodeGraph from the project.
   * This closes the database and deletes the .codegraph directory.
   *
   * WARNING: This permanently deletes all CodeGraph data for the project.
   */
  uninitialize(): void {
    this.db.close();
    removeDirectory(this.projectRoot);
  }
}

// Default export
export default CodeGraph;
