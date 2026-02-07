/**
 * CodeGraph
 *
 * A local-first code intelligence system that builds a semantic
 * knowledge graph from any codebase.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
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
  ScipImportProgress,
  ScipImportResult,
} from './types';
import { DatabaseConnection, getDatabasePath } from './db';
import { QueryBuilder } from './db/queries';
import { loadConfig, saveConfig, createDefaultConfig } from './config';
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
  ResolvedRef,
  UnresolvedRef,
} from './resolution';
import { GraphTraverser, GraphQueryManager } from './graph';
import { VectorManager, createVectorManager, EmbeddingProgress } from './vectors';
import { ContextBuilder, createContextBuilder } from './context';
import { GitHooksManager, createGitHooksManager, HookInstallResult, HookRemoveResult } from './sync';
import { Mutex } from './utils';
import { ScipImporter, ScipResolvedReference, getScipFileFingerprint } from './scip';
import { buildVersion } from './version';

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
export { ScipImportResult } from './types';
export { ScipImporter } from './scip';
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
export { Mutex, processInBatches, debounce, throttle, MemoryMonitor } from './utils';
export { MCPServer } from './mcp';

/**
 * Build runtime version string.
 *
 * Priority:
 * 1. CODEGRAPH_BUILD_VERSION (full override)
 * 2. package.json version + optional CODEGRAPH_VERSION_SUFFIX
 * 3. package.json version + git metadata (+g<sha>[.dirty[.<utc timestamp>]]) when available
 */
function getRuntimeVersion(): string {
  const packagePath = path.join(__dirname, '..', 'package.json');
  let baseVersion = 'unknown';
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8')) as { version?: string };
    if (pkg.version) {
      baseVersion = pkg.version;
    }
  } catch {
    // keep unknown fallback
  }
  return buildVersion(baseVersion, path.dirname(packagePath));
}

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

  /** Whether to use SCIP import when a configured SCIP index is available */
  useScip?: boolean;

  /** Optional one-off command to generate SCIP data before import */
  scipGenerateCommand?: string;
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

  // Mutex for preventing concurrent indexing operations
  private indexMutex = new Mutex();

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
  }

  /**
   * Runtime version used for index provenance metadata.
   */
  private static readonly RUNTIME_VERSION = getRuntimeVersion();

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
    this.vectorManager?.dispose();
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
    Object.assign(this.config, updates);
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
    return this.indexMutex.withLock(async () => {
      const result = await this.orchestrator.indexAll(options.onProgress, options.signal);
      const preparedScipPath = result.success ? this.prepareScipIndexPath(options) : null;

      // Resolve references to create call/import/extends edges
      if (result.success && result.filesIndexed > 0) {
        const resolutionStart = Date.now();
        
        // Wrap the progress callback to convert from (current, total) to IndexProgress format
        const resolutionProgress = (current: number, total: number) => {
          options.onProgress?.({
            phase: 'resolving',
            current,
            total,
          });
        };
        await this.resolveReferences(
          Math.max(1, os.cpus().length - 1),
          resolutionProgress,
          preparedScipPath ?? undefined
        );
        
        // Add resolution timing to result
        const resolutionTime = Date.now() - resolutionStart;
        if (result.timing) {
          result.timing.resolvingMs = resolutionTime;
        } else {
          result.timing = {
            scanningMs: 0,
            parsingMs: 0,
            storingMs: 0,
            resolvingMs: resolutionTime,
          };
        }
      }

      if (result.success) {
        this.queries.setProjectMetadataIfMissing('first_indexed_by_version', CodeGraph.RUNTIME_VERSION);
        this.queries.setProjectMetadataIfMissing('first_indexed_at', String(Date.now()));

        await this.runScipPipeline(options, preparedScipPath);
      }

      return result;
    });
  }

  /**
   * Index specific files
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    return this.indexMutex.withLock(async () => {
      return this.orchestrator.indexFiles(filePaths);
    });
  }

  /**
   * Sync with current file state (incremental update)
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async sync(options: IndexOptions = {}): Promise<SyncResult> {
    return this.indexMutex.withLock(async () => {
      const result = await this.orchestrator.sync(options.onProgress);
      const preparedScipPath = this.prepareScipIndexPath(options);

      // Resolve references if files were updated
      // Cache optimization makes full resolution fast even with 20K+ refs
      if (result.filesAdded > 0 || result.filesModified > 0) {
        await this.resolveReferences(
          Math.max(1, os.cpus().length - 1),
          undefined,
          preparedScipPath ?? undefined
        );
        this.queries.setProjectMetadataIfMissing('first_indexed_by_version', CodeGraph.RUNTIME_VERSION);
        this.queries.setProjectMetadataIfMissing('first_indexed_at', String(Date.now()));
      }

      this.queries.setProjectMetadata('last_synced_by_version', CodeGraph.RUNTIME_VERSION);
      this.queries.setProjectMetadata('last_synced_at', String(Date.now()));

      await this.runScipPipeline(options, preparedScipPath);

      return result;
    });
  }

  /**
   * Import semantic relationships from a SCIP JSON index.
   *
   * This augments existing tree-sitter extraction with high-confidence
   * cross-symbol reference data.
   */
  async importScip(
    indexPath: string,
    onProgress?: (progress: ScipImportProgress) => void
  ): Promise<ScipImportResult> {
    return this.indexMutex.withLock(async () => {
      return this.importScipUnsafe(indexPath, onProgress);
    });
  }

  private shouldUseScip(options: IndexOptions): boolean {
    return options.useScip ?? this.config.enableScip;
  }

  private prepareScipIndexPath(options: IndexOptions): string | null {
    if (!this.shouldUseScip(options)) {
      return null;
    }

    return this.resolveOrGenerateScipIndexPath(options);
  }

  private async runScipPipeline(options: IndexOptions, preparedScipPath?: string | null): Promise<void> {
    if (!this.shouldUseScip(options)) {
      return;
    }

    const report = (current: number, total: number, currentFile: string) => {
      options.onProgress?.({
        phase: 'scip',
        current,
        total,
        currentFile,
      });
    };

    let scipPath = preparedScipPath ?? null;
    if (!scipPath) {
      report(1, 4, 'Locating/generating SCIP index');
      scipPath = this.resolveOrGenerateScipIndexPath(options, (stage) => {
        report(2, 4, stage);
      });
    } else {
      report(1, 4, `Using ${path.basename(scipPath)}`);
      report(2, 4, 'SCIP index ready');
    }

    if (!scipPath) {
      report(4, 4, 'No SCIP index available');
      return;
    }

    report(3, 4, `Importing ${path.basename(scipPath)}`);
    await this.importScipUnsafe(scipPath, (progress) => {
      const percent = this.scipImportPercent(progress);
      const detail = progress.detail?.trim() || progress.phase;
      report(Math.max(3, Math.min(4, 3 + percent)), 4, detail);
    });
    report(4, 4, 'SCIP import complete');
  }

  private scipImportPercent(progress: ScipImportProgress): number {
    const safeTotal = Math.max(progress.total, 1);
    const stageProgress = Math.max(0, Math.min(1, progress.current / safeTotal));

    // Weighted to keep visible movement across all SCIP phases.
    const stageWeights: Record<ScipImportProgress['phase'], { start: number; span: number }> = {
      loading: { start: 0, span: 0.1 },
      'mapping-definitions': { start: 0.1, span: 0.35 },
      'mapping-references': { start: 0.45, span: 0.4 },
      'writing-edges': { start: 0.85, span: 0.14 },
      done: { start: 0.99, span: 0.01 },
    };

    const stage = stageWeights[progress.phase];
    return stage.start + (stage.span * stageProgress);
  }

  private resolveOrGenerateScipIndexPath(
    options: IndexOptions,
    onStage?: (stage: string) => void
  ): string | null {
    const configuredCommand = options.scipGenerateCommand?.trim() || this.config.scipGenerateCommand?.trim();
    const existingBeforeGenerate = this.resolveConfiguredScipIndexPath();

    // If user configured a command, run it on each index/sync so SCIP stays fresh.
    if (configuredCommand) {
      this.runScipGenerateCommand(configuredCommand, onStage);
      this.convertScipBinaryToJsonIfPossible(onStage);
      const afterGenerate = this.resolveConfiguredScipIndexPath();
      if (afterGenerate) return afterGenerate;
      return existingBeforeGenerate;
    }

    // No custom command: use existing SCIP if present.
    if (existingBeforeGenerate) return existingBeforeGenerate;

    // Best-effort default generation for TypeScript repos when tools are installed.
    if (this.config.enableScipGeneration) {
      this.runDefaultScipGeneration(onStage);
      this.convertScipBinaryToJsonIfPossible(onStage);
      return this.resolveConfiguredScipIndexPath();
    }

    return null;
  }

  private resolveConfiguredScipIndexPath(): string | null {
    for (const candidate of this.config.scipIndexPaths) {
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      const fullPath = path.isAbsolute(trimmed)
        ? trimmed
        : path.resolve(this.projectRoot, trimmed);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
    return null;
  }

  private runDefaultScipGeneration(onStage?: (stage: string) => void): void {
    const hasTypeScriptSignals =
      fs.existsSync(path.join(this.projectRoot, 'tsconfig.json')) ||
      fs.existsSync(path.join(this.projectRoot, 'package.json'));
    if (!hasTypeScriptSignals) return;
    if (!this.isCommandAvailable('scip-typescript')) return;
    onStage?.('Running scip-typescript index');

    const run = spawnSync('scip-typescript', ['index'], {
      cwd: this.projectRoot,
      stdio: 'ignore',
      encoding: 'utf8',
    });

    if (run.status !== 0 && !run.error) {
      this.queries.setProjectMetadata('scip_last_generate_error', 'scip-typescript exited with non-zero status');
      return;
    }
    if (run.error) {
      this.queries.setProjectMetadata(
        'scip_last_generate_error',
        run.error.message || String(run.error)
      );
      return;
    }

    this.queries.setProjectMetadata('scip_last_generate_error', '');
    this.queries.setProjectMetadata('scip_last_generated_at', String(Date.now()));
    this.queries.setProjectMetadata('scip_last_generated_by', 'default:scip-typescript');
  }

  private runScipGenerateCommand(command: string, onStage?: (stage: string) => void): void {
    onStage?.(`Running custom SCIP generator: ${command}`);
    const run = spawnSync(command, {
      cwd: this.projectRoot,
      stdio: 'ignore',
      shell: true,
      encoding: 'utf8',
    });

    if (run.status !== 0 && !run.error) {
      this.queries.setProjectMetadata('scip_last_generate_error', `generate command exited non-zero: ${command}`);
      return;
    }
    if (run.error) {
      this.queries.setProjectMetadata(
        'scip_last_generate_error',
        run.error.message || String(run.error)
      );
      return;
    }

    this.queries.setProjectMetadata('scip_last_generate_error', '');
    this.queries.setProjectMetadata('scip_last_generated_at', String(Date.now()));
    this.queries.setProjectMetadata('scip_last_generated_by', `command:${command}`);
  }

  private convertScipBinaryToJsonIfPossible(onStage?: (stage: string) => void): void {
    if (this.resolveConfiguredScipIndexPath()) return;
    if (!this.isCommandAvailable('scip')) return;

    const binaryCandidates = [
      path.join(this.projectRoot, '.codegraph', 'index.scip'),
      path.join(this.projectRoot, 'index.scip'),
      path.join(this.projectRoot, '.scip', 'index.scip'),
      path.join(this.projectRoot, 'scip', 'index.scip'),
    ];
    const binaryPath = binaryCandidates.find((candidate) => fs.existsSync(candidate));
    if (!binaryPath) return;
    onStage?.(`Converting ${path.basename(binaryPath)} to JSON`);

    const print = spawnSync('scip', ['print', '--json', binaryPath], {
      cwd: this.projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    });

    if (print.error || print.status !== 0 || !print.stdout) {
      const errorMessage = print.error?.message || 'scip print failed';
      this.queries.setProjectMetadata('scip_last_generate_error', errorMessage);
      return;
    }

    const jsonPath = path.join(this.projectRoot, '.codegraph', 'index.scip.json');
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, print.stdout, 'utf-8');
  }

  private isCommandAvailable(command: string): boolean {
    const probe = spawnSync(command, ['--help'], {
      cwd: this.projectRoot,
      stdio: 'ignore',
      encoding: 'utf8',
    });
    return !probe.error;
  }

  private async importScipUnsafe(
    indexPath: string,
    onProgress?: (progress: ScipImportProgress) => void
  ): Promise<ScipImportResult> {
    const resolvedPath = path.isAbsolute(indexPath)
      ? indexPath
      : path.resolve(this.projectRoot, indexPath);

    const previousImportedPath = this.queries.getProjectMetadata('scip_last_imported_path');
    const previousFingerprint = this.queries.getProjectMetadata('scip_last_imported_fingerprint');
    const currentFingerprint = getScipFileFingerprint(resolvedPath);
    if (previousImportedPath === resolvedPath && previousFingerprint === currentFingerprint) {
      onProgress?.({
        phase: 'done',
        current: 1,
        total: 1,
        detail: 'SCIP unchanged, skipped import',
      });

      return {
        indexPath: resolvedPath,
        documentsParsed: Number(this.queries.getProjectMetadata('scip_last_documents') || '0'),
        occurrencesScanned: Number(this.queries.getProjectMetadata('scip_last_occurrences') || '0'),
        definitionsMapped: 0,
        referencesMapped: 0,
        importedEdges: 0,
        skipped: true,
      };
    }

    const importer = new ScipImporter(this.projectRoot, this.queries);
    const result = importer.importFromFile(resolvedPath, onProgress);

    const importedAt = Date.now();
    this.queries.setProjectMetadata('scip_last_imported_at', String(importedAt));
    this.queries.setProjectMetadata('scip_last_imported_path', result.indexPath);
    this.queries.setProjectMetadata('scip_last_imported_fingerprint', currentFingerprint);
    this.queries.setProjectMetadata('scip_last_imported_edges', String(result.importedEdges));
    this.queries.setProjectMetadata('scip_last_documents', String(result.documentsParsed));
    this.queries.setProjectMetadata('scip_last_occurrences', String(result.occurrencesScanned));

    return result;
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
  async resolveReferences(
    numWorkers: number = Math.max(1, os.cpus().length - 1),
    onProgress?: (current: number, total: number) => void,
    scipIndexPath?: string
  ): Promise<ResolutionResult> {
    // Get all unresolved references from the database
    const unresolvedRefs = this.queries.getUnresolvedReferences();

    if (unresolvedRefs.length === 0) {
      return {
        resolved: [],
        unresolved: [],
        stats: {
          total: 0,
          resolved: 0,
          unresolved: 0,
          byMethod: {},
        },
      };
    }

    let refsForHeuristic = unresolvedRefs;
    let scipResolvedRefs: ResolvedRef[] = [];

    // SCIP-first pass: resolve what we can with high-confidence semantic data,
    // then send only the remainder through heuristic resolvers.
    const scipProgressBudget = onProgress && scipIndexPath ? Math.max(1, Math.floor(unresolvedRefs.length * 0.2)) : 0;

    if (scipIndexPath) {
      try {
        const importer = new ScipImporter(this.projectRoot, this.queries);
        const scipResult = importer.resolveUnresolvedReferences(
          scipIndexPath,
          unresolvedRefs,
          onProgress
            ? (progress) => {
                if (scipProgressBudget <= 0) return;
                const safeTotal = Math.max(progress.total, 1);
                const stageProgress = Math.max(0, Math.min(1, progress.current / safeTotal));
                const phaseWeight = progress.phase === 'mapping-definitions'
                  ? { start: 0, span: 0.45 }
                  : progress.phase === 'mapping-references'
                    ? { start: 0.45, span: 0.5 }
                    : { start: 0.95, span: 0.05 };
                const normalized = phaseWeight.start + (phaseWeight.span * stageProgress);
                const mapped = Math.max(
                  0,
                  Math.min(scipProgressBudget, Math.floor(normalized * scipProgressBudget))
                );
                onProgress(mapped, unresolvedRefs.length);
              }
            : undefined
        );
        scipResolvedRefs = scipResult.resolved.map((r) => this.toResolvedRef(r));
        refsForHeuristic = scipResult.unresolved;
      } catch {
        // Best-effort path: if SCIP parsing/matching fails, continue with heuristics.
        scipResolvedRefs = [];
        refsForHeuristic = unresolvedRefs;
      }
    }

    // Resolve remaining refs with existing strategies.
    const heuristicResult = refsForHeuristic.length > 0
      ? await this.resolver.resolveAllParallel(
          refsForHeuristic,
          Math.max(1, Math.floor(numWorkers)),
          onProgress
            ? (current, total) => {
                const safeTotal = Math.max(total, 1);
                const fraction = Math.max(0, Math.min(1, current / safeTotal));
                const mapped = scipProgressBudget + Math.floor(
                  fraction * (unresolvedRefs.length - scipProgressBudget)
                );
                onProgress(mapped, unresolvedRefs.length);
              }
            : undefined
        )
      : {
          resolved: [],
          unresolved: [],
          stats: {
            total: 0,
            resolved: 0,
            unresolved: 0,
            byMethod: {} as Record<string, number>,
          },
        };
    if (refsForHeuristic.length === 0 && onProgress) {
      onProgress(unresolvedRefs.length, unresolvedRefs.length);
    }

    const combinedByMethod: Record<string, number> = { ...heuristicResult.stats.byMethod };
    if (scipResolvedRefs.length > 0) {
      combinedByMethod.scip = (combinedByMethod.scip || 0) + scipResolvedRefs.length;
    }

    const combinedResult: ResolutionResult = {
      resolved: [...scipResolvedRefs, ...heuristicResult.resolved],
      unresolved: heuristicResult.unresolved,
      stats: {
        total: unresolvedRefs.length,
        resolved: scipResolvedRefs.length + heuristicResult.stats.resolved,
        unresolved: heuristicResult.stats.unresolved,
        byMethod: combinedByMethod,
      },
    };

    const edges = this.resolver.createEdges(combinedResult.resolved);

    // Deduplicate edges before insertion
    // Key: source|target|kind|line|col|metadata
    const seen = new Set<string>();
    const dedupedEdges = edges.filter((edge) => {
      const metadata = edge.metadata ? JSON.stringify(edge.metadata) : '';
      const key = `${edge.source}|${edge.target}|${edge.kind}|${edge.line}|${edge.column}|${metadata}`;
      if (seen.has(key)) {
        return false; // Skip duplicate
      }
      seen.add(key);
      return true;
    });

    // Delete old resolved edges for each source+kind before inserting new ones.
    const sourceKinds = new Map<string, Set<string>>();
    for (const edge of dedupedEdges) {
      let kinds = sourceKinds.get(edge.source);
      if (!kinds) {
        kinds = new Set<string>();
        sourceKinds.set(edge.source, kinds);
      }
      kinds.add(edge.kind);
    }

    for (const [sourceId, kinds] of sourceKinds) {
      for (const kind of kinds) {
        this.queries.deleteEdgesBySourceAndKind(sourceId, kind);
      }
    }

    // Insert new edges
    if (dedupedEdges.length > 0) {
      this.queries.insertEdges(dedupedEdges);
    }
    
    return combinedResult;
  }

  private toResolvedRef(match: ScipResolvedReference): ResolvedRef {
    const original: UnresolvedRef = {
      fromNodeId: match.reference.fromNodeId,
      referenceName: match.reference.referenceName,
      referenceKind: match.reference.referenceKind,
      line: match.reference.line,
      column: match.reference.column,
      filePath: match.reference.filePath,
      language: match.reference.language,
      candidates: match.reference.candidates,
    };

    return {
      original,
      targetNodeId: match.targetNodeId,
      confidence: match.confidence,
      resolvedBy: 'scip',
    };
  }

  /**
   * Get framework resolvers detected for this project.
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
