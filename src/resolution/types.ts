/**
 * Reference Resolution Types
 *
 * Types for the reference resolution system.
 */

import { EdgeKind, Language, Node, ReferenceKind } from '../types';

/**
 * An unresolved reference from extraction
 */
export interface UnresolvedRef {
  /** ID of the source node containing the reference */
  fromNodeId: string;
  /** The name being referenced */
  referenceName: string;
  /** Type of reference */
  referenceKind: ReferenceKind;
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
  /** `unresolved_refs.id` when loaded from the database — post-pass cleanup
   * targets exactly this row instead of every same-key sibling (#1269). */
  rowId?: number;
  /** The tail a ref that failed to resolve is parked under, when it is not
   * the one its name gives (see `importBindingTail`). */
  nameTail?: string;
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
  resolvedBy: 'exact-match' | 'import' | 'qualified-name' | 'framework' | 'fuzzy' | 'instance-method' | 'file-path' | 'function-ref';
  /**
   * Edge kind the edge should carry when it is NOT the ref's own kind — a
   * framework that turns a `calls` ref into a `navigates` edge, for example.
   * The original kind is still recorded on the edge as `metadata.refKind`, so
   * re-resolution after a target is removed reconstructs the ref faithfully.
   */
  edgeKind?: EdgeKind;
  /** Provenance for a resolved semantic edge inferred from a known combinator. */
  provenance?: import('../types').Edge['provenance'];
  /** Extra metadata the strategy wants persisted on the edge (`href`, …). */
  metadata?: Record<string, unknown>;
  /**
   * The OTHER targets, when one reference names several.
   *
   * A navigation whose destination is a conditional reaches every arm —
   * `!isAdmin ? keyword ? '/search/…' : '/page/…' : '/admin/…'` is one call
   * and three screens — and drawing only the first would hide two places the
   * code goes. `createEdges` fans these out into an edge apiece, sharing this
   * resolution's kind and confidence; each carries its own metadata.
   *
   * The reference itself still resolves ONCE, so the resolution pipeline's
   * bookkeeping — cleanup by row id, counts, re-resolution — is unchanged.
   */
  alsoTargets?: { targetNodeId: string; metadata?: Record<string, unknown> }[];
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
  /** Whether any node in the file is exported (`getNodesInFile(f).some(n => n.isExported)`), as one indexed probe. */
  fileHasExportedNode?(filePath: string): boolean;
  /** `getNodesInFile(f).filter(n => n.isExported)`, without decoding the rest of the file. */
  getExportedNodesInFile?(filePath: string): Node[];
  /** `getNodesInFile(f).filter(n => n.name === name)`, without decoding the rest of the file. */
  getNodesInFileNamed?(filePath: string, name: string): Node[];
  /** Get all nodes by name */
  getNodesByName(name: string): Node[];
  /** Get all nodes by qualified name */
  getNodesByQualifiedName(qualifiedName: string): Node[];
  /** Get all nodes of a kind */
  getNodesByKind(kind: Node['kind']): Node[];
  /**
   * Stream nodes of a kind one at a time instead of materializing (and, unlike
   * `getNodesByKind`, without populating the resolver's per-kind array cache).
   * For unbounded kinds (`function`, `method`, `struct`) on a symbol-dense
   * project the full array is gigabytes — the dynamic-edge synthesizers must
   * use this so their memory stays O(1) in node count (#610, #1212). Optional
   * so minimal test contexts compile; callers fall back to getNodesByKind.
   */
  iterateNodesByKind?(kind: Node['kind']): IterableIterator<Node>;
  /** Check if a file exists */
  fileExists(filePath: string): boolean;
  /** Read file content */
  readFile(filePath: string): string | null;
  /** `readFile(filePath)?.includes(needle) ?? false` for an ASCII `needle`, without decoding a file that lacks it. */
  fileContains?(filePath: string, needle: string): boolean;
  /**
   * `readFile(filePath)` split into lines, LRU-cached per file. Receiver-type
   * inference scans source lines for EVERY `receiver.method()` ref; splitting
   * the whole file per ref made that O(refs-in-file × file-size) — ~20% of
   * total index CPU on a Java-heavy repo and a driver of the #1122 watchdog
   * kill on large ones. Optional so external/test contexts compile without it;
   * callers fall back to splitting `readFile` themselves.
   */
  getFileLines?(filePath: string): string[] | null;
  /**
   * The method-definition nodes matching `typeName::methodName` in the language family —
   * exactly `resolveMethodOnType`'s kind/language/qualifiedName-suffix filter,
   * LRU-cached per (language, type, method). The uncached path re-fetches every
   * node sharing the METHOD name (unbounded — tens of thousands on a collision-
   * heavy Java repo) and re-scans it per ref, the dominant term in the #1122
   * watchdog kill. Cached entries hold only the small filtered result; per-ref
   * disambiguation (import FQN, call-site file) stays in the caller so a cached
   * entry is valid from any call site. Optional for external/test contexts.
   */
  getMethodMatches?(typeName: string, methodName: string, language: Language): Node[];
  /** Get project root */
  getProjectRoot(): string;
  /** Get all files */
  getAllFiles(): string[];
  /** Get nodes by lowercase name (O(1) lookup for fuzzy matching) */
  getNodesByLowerName(lowerName: string): Node[];
  /**
   * Direct supertypes of the type named `typeName` (same language): the classes
   * it extends and the interfaces / protocols / traits it implements/conforms to,
   * by simple name. Backed by the resolved `implements`/`extends` edges, so it is
   * EMPTY during the first resolution pass (edges aren't built yet) and populated
   * afterward — the conformance pass uses it to resolve a chained method defined
   * on a supertype the receiver type conforms to (e.g. a protocol-extension
   * method). Optional so external/test contexts compile without it.
   */
  getSupertypes?(typeName: string, language: Language): string[];
  /**
   * Look up a node by its id. Lets matchers derive the FROM-symbol's
   * enclosing-class scope (Swift implicit-self method scoping, `this.X`
   * member resolution). Optional so external/test contexts compile
   * without it.
   */
  getNodeById?(id: string): Node | null;
  /** Get cached import mappings for a file */
  getImportMappings(filePath: string, language: Language): ImportMapping[];
  /** Import lookup supplied by the coordinator, keeping name matching from
   * importing the import resolver (which itself uses name-matching helpers).
   * Minimal contexts without import resolution may omit this capability. */
  resolveImport?(ref: UnresolvedRef): ResolvedRef | null;
  /**
   * Whether an import specifier, written in `fromFile`, names a module outside
   * the repository: a package that is not a relative path, a tsconfig alias, a
   * workspace member or the repository's own package name, and that resolves
   * to no project file. Supplied by the coordinator, like `resolveImport`.
   */
  isOutOfRepoImport?(source: string, fromFile: string, language: Language): boolean;
  /**
   * Project import-path aliases (tsconfig/jsconfig `paths`). Returns
   * `null` when the project doesn't define any. Cached per resolver
   * instance — safe to call from any resolver code path. Optional so
   * existing test fixtures and external context implementations
   * compile without modification; production resolver implements it.
   */
  getProjectAliases?(): import('./path-aliases').AliasMap | null;
  /**
   * The aliases of the tsconfig / jsconfig nearest `fromFile` below the
   * project root that declares `paths` — a monorepo app's own `@/*` — or null.
   */
  getNearestAliases?(fromFile: string): import('./path-aliases').AliasMap | null;
  /**
   * The project-relative directory (`/`-separated, `.` for the root) of
   * the Go package an import path names, when it is a package of one of the
   * project's own modules — the `go.mod` at the root or any `go.mod` above
   * an indexed `.go` file (#2322) — else `null` (the standard library,
   * third-party modules, a project with no `go.mod`). `fromFile`, the
   * importing file, breaks a tie between two modules declaring one path.
   * Used by the Go branch of resolution to tell in-project cross-package
   * imports from outside ones, and to find the package's files.
   */
  getGoPackageDir?(importPath: string, fromFile?: string): string | null;
  /**
   * Monorepo workspace member packages, keyed by declared package name.
   * Returns `null` for single-package repos (no `workspaces` field).
   * Lets the resolver treat `@scope/ui/sub` as a local import into the
   * member's directory instead of an external npm package (#629).
   */
  getWorkspacePackages?(): import('./workspace-packages').WorkspacePackages | null;
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
  /**
   * C/C++ include search directories (relative to project root),
   * extracted from compile_commands.json or discovered by heuristic.
   * Used by resolveCppIncludePath to search -I directories when
   * relative resolution fails. Optional so existing callers compile.
   */
  getCppIncludeDirs?(): string[];
  /**
   * The import node of every C / C++ `#include`, narrowed to the path it
   * spells and where it is written: what ./cpp-includers builds the include
   * graph from. Optional so minimal contexts compile; it falls back to
   * reading the import nodes themselves.
   */
  getCppIncludeNodes?(): Array<Pick<Node, 'id' | 'name' | 'filePath' | 'language' | 'startLine' | 'startColumn'>>;
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
 * Nodes a framework can name only from several files at once, with the
 * references that bind each — and how to recognise the ones an earlier run
 * produced, so a run can remove those it no longer wants.
 */
export interface CrossFileNodes extends FrameworkExtractionResult {
  /** The kind every one of these nodes has. */
  kind: Node['kind'];
  /** True for a node this pass produces, and for no node extraction does. */
  owns(node: Node): boolean;
}

/**
 * The navigation calls a router binds to its routes — `navigate('/login')`,
 * `router.push('/x')` — described so a sync can find the ones a changed route
 * may answer (see `FrameworkResolver.navigation`).
 */
export interface NavigationCalls {
  /**
   * The name tails of the calls `claimsReference` accepts as navigation —
   * `push` for `history.push` — which find them through the failed-tail
   * index; `claimsReference` then decides on the whole name.
   */
  tails: readonly string[];
  /**
   * The files whose navigation calls can name `route`: the path prefixes of
   * the apps whose table it is in (`''` for every file), or null when it is
   * not one of this router's routes.
   */
  scope(route: Node, context: ResolutionContext): readonly string[] | null;
}

/**
 * Framework-specific resolver
 */
export interface FrameworkResolver {
  /** Framework name */
  name: string;
  /**
   * Languages this framework applies to: `extract()` runs only on files in
   * them, and `resolve()` sees only references written in them (unless
   * `resolveLanguages` says otherwise). If omitted, applies to all languages.
   */
  languages?: Language[];
  /**
   * The languages whose references `resolve()` sees, when they are not
   * `languages`. For a resolver that reads references in languages it
   * extracts nothing from: SvelteKit's `$lib/…` imports and Svelte 5 runes
   * are written in `.ts` / `.js` modules too, but only a `.svelte` file holds
   * a route. Widening `languages` instead would run `extract()` on those
   * files.
   */
  resolveLanguages?: readonly Language[];
  /**
   * Packages an app declares when it is built on this framework. When set,
   * `extract()` runs only on files of an app whose package.json — the file's
   * own or an enclosing one — declares one of them: in a monorepo with an Expo
   * app beside a Next.js app, Expo Router must not read the Next app's
   * `app/layout.tsx` as a `/layout` screen. When no manifest in the project
   * declares any, detection found the framework by other evidence and the
   * extractor runs on every file, as before.
   */
  appDependencies?: readonly string[];
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
   * Asked only about references written in the languages `resolve()` sees.
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
  /**
   * Cross-file finalization pass, called once after all per-file extraction
   * completes (and again on every incremental sync). Used by frameworks where
   * a symbol's final representation depends on a sibling file the per-file
   * `extract()` never saw — e.g. NestJS's `RouterModule.register([...])`
   * sets route prefixes for controllers declared elsewhere.
   *
   * Implementations return route/etc. nodes with mutated fields (typically
   * `name`); the orchestrator persists each via `updateNode`. The node `id`
   * MUST be preserved so existing edges (route → handler, etc.) stay intact;
   * `qualifiedName` SHOULD be preserved so the pass stays idempotent — a
   * second run can recover the original in-file form from `qualifiedName`.
   */
  postExtract?(context: ResolutionContext): Node[];
  /**
   * Nodes no single file's `extract()` can decide on — a React Router route
   * table written in one file is a table of routes only because another
   * file hands it to the router. Called after `postExtract` on every index
   * and every sync, it returns the COMPLETE set the framework wants now. The
   * orchestrator inserts the new ones (their references pending, for the
   * resolution that follows), removes the ones an earlier run inserted that
   * are no longer wanted, renames the ones whose name changed, and leaves
   * the rest alone, so an unchanged node keeps its edges. A node lives in the
   * file it is written in, so re-extracting that file drops it until the
   * next run puts it back.
   */
  crossFileNodes?(context: ResolutionContext): CrossFileNodes;
  /**
   * Set by a router whose `resolve()` binds a navigation call to one of its
   * route nodes. A call whose route did not exist yet was parked as failed, or
   * bound to whatever answered it then (a catch-all, a parameter route), and
   * the retry that matches a failed ref's name tail against the names a sync
   * adds (#1240) never finds it: its name is the router's method, never the
   * route's path. So a sync that adds, removes or renames a route puts the
   * calls this describes back for its resolution sweep.
   */
  navigation?: NavigationCalls;
}

/**
 * Import mapping from a file
 */
export interface HaskellParentChildRestriction {
  parent: string;
  child: string;
  /** The grouped child contributes only in the type namespace (`C(type F)`). */
  haskellTypeOnly?: true;
  /** The grouped child contributes only in the value namespace (`T(pattern P)`). */
  haskellValueOnly?: true;
}

export interface ImportMapping {
  /** Local name used in the file */
  localName: string;
  /** Original exported name (may differ due to aliasing) */
  exportedName: string;
  /** Source module/path */
  source: string;
  /** Haskell PackageImports package qualifier (`import "pkg" Module`). */
  packageQualifier?: string;
  /** Haskell type-namespace import item; it contributes no value binding. */
  haskellTypeOnly?: true;
  /** Haskell `pattern`-qualified import item; it contributes no type binding. */
  haskellValueOnly?: true;
  /**
   * Names in an aggregate Haskell import restriction that were introduced
   * exclusively in the type namespace.
   */
  haskellTypeOnlyNames?: string[];
  /** Names in an aggregate Haskell restriction limited to the value namespace. */
  haskellValueOnlyNames?: string[];
  /** Whether it's a default import */
  isDefault: boolean;
  /** Whether it's a namespace import (import * as X) */
  isNamespace: boolean;
  /** Haskell: the binding is available only through its qualifier. */
  isQualifiedOnly?: boolean;
  /**
   * Optional parent export for languages with grouped exports, such as
   * Haskell's `Type(Constructor)` and `Type(..)` import items.
   */
  parentExport?: string;
  /** Namespace/wildcard allow-list of directly named exports. */
  includedNames?: string[];
  /** Namespace/wildcard allow-list of all children owned by these exports. */
  includedParentExports?: string[];
  /** Haskell: specifically allowed children keyed by their owning type/class. */
  includedParentChildren?: HaskellParentChildRestriction[];
  /** Namespace/wildcard deny-list of directly named exports. */
  excludedNames?: string[];
  /** Namespace/wildcard deny-list of all children owned by these exports. */
  excludedParentExports?: string[];
  /** Haskell: specifically hidden children keyed by their owning type/class. */
  excludedParentChildren?: HaskellParentChildRestriction[];
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
      /** Haskell PackageImports package qualifier on the upstream import. */
      packageQualifier?: string;
      /** Haskell type-namespace re-export; it contributes no value binding. */
      haskellTypeOnly?: true;
      /** Haskell `pattern`-qualified re-export; it contributes no type binding. */
      haskellValueOnly?: true;
      /** Haskell grouped export owner (`T(C)`) when the child is ambiguous. */
      parentExport?: string;
    }
  | {
      kind: 'wildcard';
      /** Module specifier of the upstream module. */
      source: string;
      /** Haskell PackageImports package qualifier on the upstream import. */
      packageQualifier?: string;
      /** Haskell allow/deny names that apply only in the type namespace. */
      haskellTypeOnlyNames?: string[];
      /** Haskell allow/deny names that apply only in the value namespace. */
      haskellValueOnlyNames?: string[];
      /** Optional Haskell re-export allow/deny lists inherited from its import. */
      includedNames?: string[];
      includedParentExports?: string[];
      includedParentChildren?: HaskellParentChildRestriction[];
      /**
       * Haskell-only compact form for identity named re-exports. A named
       * export introduces the value independently of any downstream grouped
       * import (`T(value)`), whereas an ordinary wildcard propagates that
       * parent restriction. The walker uses this marker to preserve the
       * named-route semantics after grouping many names by source.
       */
      haskellClearParent?: true;
      /**
       * Haskell-only compact form for several otherwise-identical
       * parent-scoped wildcard routes. The combined allow predicate carries
       * the union, so the walker can inspect the upstream module once instead
       * of recursively repeating the same lookup for every parent.
       */
      haskellCollapsedParents?: true;
      excludedNames?: string[];
      excludedParentExports?: string[];
      excludedParentChildren?: HaskellParentChildRestriction[];
    }
  | {
      /** `export * as ns from './other'`: only `ns` is exported, the module's members through it. */
      kind: 'namespace';
      exportedName: string;
      source: string;
    };

/**
 * Node kinds an `extends`/`implements` edge may legally TARGET — the things a
 * type can actually inherit from or conform to.
 *
 * Kept deliberately wide: `type_alias` because TS `class X implements
 * SomeAliasedObjectType` is valid, `component` because a framework component
 * node stands in for a class, and `module`/`namespace` because whole
 * languages inherit from one — Ruby `include Trackable` targets a `module`,
 * Erlang `-behaviour(gen_server)` targets the behaviour module, which Erlang
 * extraction indexes as a `namespace` (the conformance pass in
 * `resolution/index.ts` makes the same `module` allowance).
 *
 * Everything omitted (`enum_member`, `method`, `field`, `property`,
 * `variable`, `constant`, `function`, `parameter`, `import`, `export`,
 * `file`, `route`) can never be a supertype in any supported language, so an
 * inheritance edge pointing at one is false data.
 *
 * Why this is needed: the name-matcher scores node kind as a BONUS,
 * never a filter, and awards no bonus at all for inheritance refs — so a
 * same-named non-type outranked (or, as the sole candidate, was adopted
 * outright as) the real supertype. Rust `use std::error::Error;` + `impl Error
 * for MapperError {}` bound to the local `MapperError::Error` VARIANT. The
 * supertype is out-of-repo and simply unresolvable; a failed ref is correct.
 */
export const SUPERTYPE_TARGET_KINDS = new Set<Node['kind']>([
  'class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'union',
  'type_alias', 'component', 'module', 'namespace',
]);

/** Scala singleton objects are values, unlike inheritable Ruby modules. */
export function isSupertypeTarget(node: Node): boolean {
  return SUPERTYPE_TARGET_KINDS.has(node.kind) &&
    !(node.language === 'scala' && node.kind === 'module');
}

/** True for the reference kinds that assert an inheritance/conformance relation. */
export function isInheritanceRef(ref: UnresolvedRef): boolean {
  return ref.referenceKind === 'extends' || ref.referenceKind === 'implements';
}

/**
 * Node kinds an `imports` edge may never TARGET: members that only exist
 * INSIDE a type. No language lets you import a class's property, an
 * interface's method or an enum's variant — you import the type that
 * contains it. The name-matcher has no kind filter, so a bare
 * `import path from 'node:path'` (unresolvable, since the module is external)
 * name-matched an interface property called `path` in an unrelated file.
 */
const NON_IMPORTABLE_KINDS = new Set<Node['kind']>([
  'property', 'field', 'method', 'enum_member', 'parameter',
]);

/** Can an `imports` reference legally resolve to this node kind? */
export function isImportableKind(kind: Node['kind']): boolean {
  return !NON_IMPORTABLE_KINDS.has(kind);
}

/**
 * The signature extraction gives a C/C++ `constant` minted from a
 * function-like `preproc_function_def` (`#define NAME(args) …`, #1838). A
 * macro is a value: it is never a `calls` target, and its presence in a
 * translation unit is what makes `NAME(x)` a macro expansion rather than a
 * call.
 */
export const CPP_DEFINE_SIGNATURE = /^\s*#\s*define\b/;
