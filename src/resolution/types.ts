/**
 * Reference Resolution Types
 *
 * Types for the reference resolution system.
 */

import { EdgeKind, Language, Node } from '../types';

/**
 * An unresolved reference from extraction
 */
export interface UnresolvedRef {
  /** ID of the source node containing the reference */
  fromNodeId: string;
  /** The name being referenced */
  referenceName: string;
  /** Type of reference */
  referenceKind: EdgeKind;
  /** Line where reference occurs */
  line: number;
  /** Column where reference occurs */
  column: number;
  /** File path where reference occurs */
  filePath: string;
  /** Language of the source file */
  language: Language;
  /** Possible qualified names it might resolve to */
  candidates?: string[];
}

/**
 * A resolved reference
 */
export interface ResolvedRef {
  /** Original unresolved reference */
  original: UnresolvedRef;
  /** ID of the target node */
  targetNodeId: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** How it was resolved */
  resolvedBy: 'exact-match' | 'import' | 'qualified-name' | 'framework' | 'fuzzy' | 'instance-method' | 'file-path';
}

/**
 * Result of resolution attempt
 */
export interface ResolutionResult {
  /** Successfully resolved references */
  resolved: ResolvedRef[];
  /** References that couldn't be resolved */
  unresolved: UnresolvedRef[];
  /** Statistics */
  stats: {
    total: number;
    resolved: number;
    unresolved: number;
    byMethod: Record<string, number>;
  };
}

/**
 * Context for resolution - provides access to the graph
 */
export interface ResolutionContext {
  /** Get all nodes in a file */
  getNodesInFile(filePath: string): Node[];
  /** Get all nodes by name */
  getNodesByName(name: string): Node[];
  /** Get all nodes by qualified name */
  getNodesByQualifiedName(qualifiedName: string): Node[];
  /** Get all nodes of a kind */
  getNodesByKind(kind: Node['kind']): Node[];
  /** Check if a file exists */
  fileExists(filePath: string): boolean;
  /** Read file content */
  readFile(filePath: string): string | null;
  /** Get project root */
  getProjectRoot(): string;
  /** Get all files */
  getAllFiles(): string[];
  /** Get nodes by lowercase name (O(1) lookup for fuzzy matching) */
  getNodesByLowerName(lowerName: string): Node[];
  /** Get cached import mappings for a file */
  getImportMappings(filePath: string, language: Language): ImportMapping[];
  /**
   * Project import-path aliases (tsconfig/jsconfig `paths`). Returns
   * `null` when the project doesn't define any. Cached per resolver
   * instance — safe to call from any resolver code path. Optional so
   * existing test fixtures and external context implementations
   * compile without modification; production resolver implements it.
   */
  getProjectAliases?(): import('./path-aliases').AliasMap | null;
  /**
   * Re-exports declared by a file (`export { x } from './other'`,
   * `export * from './other'`). Empty array when the file has none.
   * Optional so older callers compile; the import resolver follows
   * re-export chains when this is provided.
   */
  getReExports?(filePath: string, language: Language): ReExport[];
  /**
   * List immediate subdirectories of `relativePath` (relative to the
   * project root). Returns an empty array when the path doesn't exist
   * or isn't a directory. Used by framework resolvers that need to
   * walk build-system metadata (e.g. Cargo workspace globs). Optional
   * so external context implementations and test fixtures compile
   * without modification.
   */
  listDirectories?(relativePath: string): string[];
}

/**
 * Result of framework-specific file extraction.
 */
export interface FrameworkExtractionResult {
  /** Framework-specific nodes (e.g. routes) */
  nodes: Node[];
  /** Framework-specific unresolved references (e.g. route -> handler) */
  references: UnresolvedRef[];
}

/**
 * Framework-specific resolver
 */
export interface FrameworkResolver {
  /** Framework name */
  name: string;
  /** Languages this framework applies to. If omitted, applies to all languages. */
  languages?: Language[];
  /** Detect if project uses this framework (project-level, called once at startup) */
  detect(context: ResolutionContext): boolean;
  /** Resolve a reference using framework-specific patterns */
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null;
  /**
   * Opt a reference NAME through the resolver's name-exists pre-filter, even when
   * no node is named that. Needed for dynamic dispatch where the call target is
   * an attribute/descriptor, not a declared symbol (e.g. Django's
   * `self._iterable_class(...)`, React effect callbacks). Returning true lets the
   * ref reach `resolve()` instead of being dropped for having no name match.
   */
  claimsReference?(name: string): boolean;
  /**
   * Extract framework-specific nodes and references from a file.
   *
   * Returns route nodes, middleware nodes, etc., plus unresolved references
   * that link those nodes to handlers (view classes, controller methods,
   * included modules). Unresolved references flow into the normal resolution
   * pipeline; the framework's own `resolve()` is one of the strategies tried.
   */
  extract?(filePath: string, content: string): FrameworkExtractionResult;
}

/**
 * Import mapping from a file
 */
export interface ImportMapping {
  /** Local name used in the file */
  localName: string;
  /** Original exported name (may differ due to aliasing) */
  exportedName: string;
  /** Source module/path */
  source: string;
  /** Whether it's a default import */
  isDefault: boolean;
  /** Whether it's a namespace import (import * as X) */
  isNamespace: boolean;
  /** Resolved file path (if local) */
  resolvedPath?: string;
}

/**
 * Re-export from a file: `export { x } from './other'` or
 * `export * from './other'`. Used by the resolver to chase
 * symbols through barrel files.
 */
export type ReExport =
  | {
      kind: 'named';
      /** Name as exported by THIS file. */
      exportedName: string;
      /** Name in the upstream module (differs when renamed: `as`). */
      originalName: string;
      /** Module specifier of the upstream module. */
      source: string;
    }
  | {
      kind: 'wildcard';
      /** Module specifier of the upstream module. */
      source: string;
    };
