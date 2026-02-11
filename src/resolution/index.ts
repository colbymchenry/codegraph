/**
 * Reference Resolution Orchestrator
 *
 * Coordinates all reference resolution strategies.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Node, UnresolvedReference, Edge } from '../types';
import { QueryBuilder } from '../db/queries';
import { captureException } from '../sentry';
import {
  UnresolvedRef,
  ResolvedRef,
  ResolutionResult,
  ResolutionContext,
  FrameworkResolver,
  ImportMapping,
} from './types';
import { matchReference } from './name-matcher';
import { resolveViaImport, extractImportMappings } from './import-resolver';
import { detectFrameworks } from './frameworks';
import { logDebug, logWarn } from '../errors';
import { isPathWithinRoot } from '../utils';

// Re-export types
export * from './types';

// Module-level Sets for O(1) built-in lookups (instead of arrays with .includes())
const jsBuiltIns = new Set([
  'console', 'window', 'document', 'global', 'process',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean',
  'Date', 'Math', 'JSON', 'RegExp', 'Error', 'Map', 'Set',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'fetch', 'require', 'module', 'exports', '__dirname', '__filename',
]);

const reactHooks = new Set([
  'useState', 'useEffect', 'useContext', 'useReducer', 'useCallback',
  'useMemo', 'useRef', 'useLayoutEffect', 'useImperativeHandle', 'useDebugValue',
]);

const pythonBuiltIns = new Set([
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
  'open', 'input', 'type', 'isinstance', 'hasattr', 'getattr', 'setattr',
  'super', 'self', 'cls', 'None', 'True', 'False',
]);

/**
 * Reference Resolver
 *
 * Orchestrates reference resolution using multiple strategies.
 */
export class ReferenceResolver {
  private projectRoot: string;
  private queries: QueryBuilder;
  private context: ResolutionContext;
  private frameworks: FrameworkResolver[] = [];
  private nodeCache: Map<string, Node[]> = new Map();
  private fileCache: Map<string, string | null> = new Map();
  private nameCache: Map<string, Node[]> = new Map();
  private qualifiedNameCache: Map<string, Node[]> = new Map();
  private nodeByIdCache: Map<string, Node> = new Map();
  private kindCache: Map<string, Node[]> = new Map();
  private lowerNameCache: Map<string, Node[]> = new Map();
  private importMappingCache: Map<string, ImportMapping[]> = new Map();
  private knownFiles: Set<string> | null = null;
  private cachesWarmed = false;

  constructor(projectRoot: string, queries: QueryBuilder) {
    this.projectRoot = projectRoot;
    this.queries = queries;
    this.context = this.createContext();
  }

  /**
   * Initialize the resolver (detect frameworks, etc.)
   */
  initialize(): void {
    this.frameworks = detectFrameworks(this.context);
    this.clearCaches();
  }

  /**
   * Pre-load all nodes into memory maps for fast lookup during resolution.
   * This eliminates repeated SQLite queries and provides the core speedup.
   */
  warmCaches(): void {
    if (this.cachesWarmed) return;

    const allNodes = this.queries.getAllNodes();
    for (const node of allNodes) {
      // Index by name
      const byName = this.nameCache.get(node.name);
      if (byName) {
        byName.push(node);
      } else {
        this.nameCache.set(node.name, [node]);
      }

      // Index by qualified name
      const byQName = this.qualifiedNameCache.get(node.qualifiedName);
      if (byQName) {
        byQName.push(node);
      } else {
        this.qualifiedNameCache.set(node.qualifiedName, [node]);
      }

      // Index by ID
      this.nodeByIdCache.set(node.id, node);

      // Index by kind
      const byKind = this.kindCache.get(node.kind);
      if (byKind) {
        byKind.push(node);
      } else {
        this.kindCache.set(node.kind, [node]);
      }

      // Index by lowercase name (for fuzzy matching)
      const lowerName = node.name.toLowerCase();
      const byLower = this.lowerNameCache.get(lowerName);
      if (byLower) {
        byLower.push(node);
      } else {
        this.lowerNameCache.set(lowerName, [node]);
      }
    }

    // Pre-build known files set from index
    this.knownFiles = new Set(this.queries.getAllFiles().map((f) => f.path));

    this.cachesWarmed = true;
  }

  /**
   * Clear internal caches
   */
  clearCaches(): void {
    this.nodeCache.clear();
    this.fileCache.clear();
    this.nameCache.clear();
    this.qualifiedNameCache.clear();
    this.nodeByIdCache.clear();
    this.kindCache.clear();
    this.lowerNameCache.clear();
    this.importMappingCache.clear();
    this.knownFiles = null;
    this.cachesWarmed = false;
  }

  /**
   * Create the resolution context
   */
  private createContext(): ResolutionContext {
    return {
      getNodesInFile: (filePath: string) => {
        if (!this.nodeCache.has(filePath)) {
          this.nodeCache.set(filePath, this.queries.getNodesByFile(filePath));
        }
        return this.nodeCache.get(filePath)!;
      },

      getNodesByName: (name: string) => {
        // Use warm cache if available, otherwise fall back to search
        if (this.cachesWarmed) {
          return this.nameCache.get(name) ?? [];
        }
        return this.queries.searchNodes(name, { limit: 100 }).map((r) => r.node);
      },

      getNodesByQualifiedName: (qualifiedName: string) => {
        // Use warm cache if available, otherwise fall back to search + filter
        if (this.cachesWarmed) {
          return this.qualifiedNameCache.get(qualifiedName) ?? [];
        }
        return this.queries
          .searchNodes(qualifiedName, { limit: 50 })
          .filter((r) => r.node.qualifiedName === qualifiedName)
          .map((r) => r.node);
      },

      getNodesByKind: (kind: Node['kind']) => {
        if (this.cachesWarmed) {
          return this.kindCache.get(kind) ?? [];
        }
        return this.queries.getNodesByKind(kind);
      },

      fileExists: (filePath: string) => {
        // Prevent path traversal
        if (!isPathWithinRoot(filePath, this.projectRoot)) {
          logWarn('Path traversal blocked in fileExists', { filePath });
          return false;
        }
        // Check pre-built known files set first (O(1))
        if (this.knownFiles) {
          const normalized = filePath.replace(/\\/g, '/');
          if (this.knownFiles.has(filePath) || this.knownFiles.has(normalized)) {
            return true;
          }
        }
        // Fall back to filesystem for files not yet indexed
        const fullPath = path.join(this.projectRoot, filePath);
        try {
          return fs.existsSync(fullPath);
        } catch (error) {
          captureException(error, { operation: 'resolution-file-exists', filePath });
          logDebug('Error checking file existence', { filePath, error: String(error) });
          return false;
        }
      },

      readFile: (filePath: string) => {
        if (this.fileCache.has(filePath)) {
          return this.fileCache.get(filePath)!;
        }

        // Prevent path traversal
        if (!isPathWithinRoot(filePath, this.projectRoot)) {
          logWarn('Path traversal blocked in readFile', { filePath });
          this.fileCache.set(filePath, null);
          return null;
        }

        const fullPath = path.join(this.projectRoot, filePath);
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          this.fileCache.set(filePath, content);
          return content;
        } catch (error) {
          captureException(error, { operation: 'resolution-read-file', filePath });
          logDebug('Failed to read file for resolution', { filePath, error: String(error) });
          this.fileCache.set(filePath, null);
          return null;
        }
      },

      getProjectRoot: () => this.projectRoot,

      getAllFiles: () => {
        return this.queries.getAllFiles().map((f) => f.path);
      },

      getNodesByLowerName: (lowerName: string) => {
        if (this.cachesWarmed) {
          return this.lowerNameCache.get(lowerName) ?? [];
        }
        // Fallback: scan all nodes (expensive, but only used if cache not warm)
        return this.queries.getAllNodes().filter(
          (n) => n.name.toLowerCase() === lowerName
        );
      },

      getImportMappings: (filePath: string, language) => {
        const cacheKey = filePath;
        const cached = this.importMappingCache.get(cacheKey);
        if (cached) return cached;

        const content = this.context.readFile(filePath);
        if (!content) {
          this.importMappingCache.set(cacheKey, []);
          return [];
        }

        const mappings = extractImportMappings(filePath, content, language);
        this.importMappingCache.set(cacheKey, mappings);
        return mappings;
      },
    };
  }

  /**
   * Resolve all unresolved references
   */
  resolveAll(
    unresolvedRefs: UnresolvedReference[],
    onProgress?: (current: number, total: number) => void
  ): ResolutionResult {
    // Pre-load all nodes into memory for fast lookups
    this.warmCaches();

    const resolved: ResolvedRef[] = [];
    const unresolved: UnresolvedRef[] = [];
    const byMethod: Record<string, number> = {};

    // Convert to our internal format, using denormalized fields when available
    const refs: UnresolvedRef[] = unresolvedRefs.map((ref) => ({
      fromNodeId: ref.fromNodeId,
      referenceName: ref.referenceName,
      referenceKind: ref.referenceKind,
      line: ref.line,
      column: ref.column,
      filePath: ref.filePath || this.getFilePathFromNodeId(ref.fromNodeId),
      language: ref.language || this.getLanguageFromNodeId(ref.fromNodeId),
    }));

    const total = refs.length;
    let lastReportedPercent = -1;

    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]!; // Array index is guaranteed to be in bounds
      const result = this.resolveOne(ref);

      if (result) {
        resolved.push(result);
        byMethod[result.resolvedBy] = (byMethod[result.resolvedBy] || 0) + 1;
      } else {
        unresolved.push(ref);
      }

      // Report progress every 1% to avoid too many updates
      if (onProgress) {
        const currentPercent = Math.floor((i / total) * 100);
        if (currentPercent > lastReportedPercent) {
          lastReportedPercent = currentPercent;
          onProgress(i + 1, total);
        }
      }
    }

    // Final progress report
    if (onProgress && total > 0) {
      onProgress(total, total);
    }

    return {
      resolved,
      unresolved,
      stats: {
        total: refs.length,
        resolved: resolved.length,
        unresolved: unresolved.length,
        byMethod,
      },
    };
  }

  /**
   * Resolve a single reference
   */
  resolveOne(ref: UnresolvedRef): ResolvedRef | null {
    // Skip built-in/external references
    if (this.isBuiltInOrExternal(ref)) {
      return null;
    }

    const candidates: ResolvedRef[] = [];

    // Strategy 1: Try framework-specific resolution
    for (const framework of this.frameworks) {
      const result = framework.resolve(ref, this.context);
      if (result) {
        if (result.confidence >= 0.9) return result; // High confidence, return immediately
        candidates.push(result);
      }
    }

    // Strategy 2: Try import-based resolution
    const importResult = resolveViaImport(ref, this.context);
    if (importResult) {
      if (importResult.confidence >= 0.9) return importResult;
      candidates.push(importResult);
    }

    // Strategy 3: Try name matching
    const nameResult = matchReference(ref, this.context);
    if (nameResult) {
      candidates.push(nameResult);
    }

    if (candidates.length === 0) return null;

    // Return highest confidence candidate
    return candidates.reduce((best, curr) =>
      curr.confidence > best.confidence ? curr : best
    );
  }

  /**
   * Create edges from resolved references
   */
  createEdges(resolved: ResolvedRef[]): Edge[] {
    return resolved.map((ref) => ({
      source: ref.original.fromNodeId,
      target: ref.targetNodeId,
      kind: ref.original.referenceKind,
      line: ref.original.line,
      column: ref.original.column,
      metadata: {
        confidence: ref.confidence,
        resolvedBy: ref.resolvedBy,
      },
    }));
  }

  /**
   * Resolve and persist edges to database
   */
  resolveAndPersist(
    unresolvedRefs: UnresolvedReference[],
    onProgress?: (current: number, total: number) => void
  ): ResolutionResult {
    const result = this.resolveAll(unresolvedRefs, onProgress);

    // Create edges from resolved references
    const edges = this.createEdges(result.resolved);

    // Insert edges into database
    if (edges.length > 0) {
      this.queries.insertEdges(edges);
    }

    return result;
  }

  /**
   * Get detected frameworks
   */
  getDetectedFrameworks(): string[] {
    return this.frameworks.map((f) => f.name);
  }

  /**
   * Check if reference is to a built-in or external symbol
   */
  private isBuiltInOrExternal(ref: UnresolvedRef): boolean {
    const name = ref.referenceName;

    // JavaScript/TypeScript built-ins (O(1) Set lookup)
    if (jsBuiltIns.has(name)) {
      return true;
    }

    // Common library calls
    if (name.startsWith('console.') || name.startsWith('Math.') || name.startsWith('JSON.')) {
      return true;
    }

    // React hooks from React itself (O(1) Set lookup)
    if (reactHooks.has(name)) {
      return true;
    }

    // Python built-ins (O(1) Set lookup)
    if (ref.language === 'python' && pythonBuiltIns.has(name)) {
      return true;
    }

    return false;
  }

  /**
   * Get file path from node ID
   */
  private getFilePathFromNodeId(nodeId: string): string {
    // Check warm cache first
    const cached = this.nodeByIdCache.get(nodeId);
    if (cached) return cached.filePath;
    const node = this.queries.getNodeById(nodeId);
    return node?.filePath || '';
  }

  /**
   * Get language from node ID
   */
  private getLanguageFromNodeId(nodeId: string): UnresolvedRef['language'] {
    // Check warm cache first
    const cached = this.nodeByIdCache.get(nodeId);
    if (cached) return cached.language;
    const node = this.queries.getNodeById(nodeId);
    return node?.language || 'unknown';
  }
}

/**
 * Create a reference resolver instance
 */
export function createResolver(projectRoot: string, queries: QueryBuilder): ReferenceResolver {
  const resolver = new ReferenceResolver(projectRoot, queries);
  resolver.initialize();
  return resolver;
}
