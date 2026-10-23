/**
 * Reference Resolution Orchestrator
 *
 * Coordinates all reference resolution strategies.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Language, Node, UnresolvedReference, Edge } from '../types';
import { QueryBuilder } from '../db/queries';
import { SynthesisStage } from '../db/synthesis-stage';
import {
  UnresolvedRef,
  ResolvedRef,
  ResolutionResult,
  ResolutionContext,
  FrameworkResolver,
  ImportMapping,
  isSupertypeTarget,
  isInheritanceRef,
  isImportableKind,
  CPP_DEFINE_SIGNATURE,
} from './types';
import { isPythonSelfCall, matchJsStoreBindingCall, isUnresolvedJsMemberCall, matchObjectPathCall, thisScopeCaller, isVisibleAcrossFiles, matchReference, matchByFilePath, matchFunctionRef, matchDottedCallChain, matchScopedCallChain, matchMethodCall, sameLanguageFamily, crossesCodeBoundary, gateLanguageMatch, dumpNameMatcherProfile, clearNameMatcherMemos, isRustNameInScope, isRustForeignImplCallable, isRustPathCallReachable, rustChainedCallByName, CASE_INSENSITIVE_LANGUAGES, isDartMemberRead, matchDartMemberRead, isDartChainLink, matchDartChainLink, isDartAnnotation, matchDartAnnotation, isStdMethodName, isGoUnknownQualified, isGoProjectLocalCall, GO_STDLIB_PACKAGES, isGoBareName, goTypePositionTarget, goDotImportedSupertype, GO_TYPE_KINDS, matchGoAssertedCall, matchGoIndexedCall, matchGoChainedCall, preferGoBuildTwin, isGoAssertedLocal, isGoLocallyBound, isPythonFromImportModule, pythonAttrRefResolves, matchPythonTypedLocalCall, isImportShadowedByJsBinding, isManualMockPath, isTestSuitePath, matchNewReceiverCall, newReceiverClass, NEW_RECEIVER_SHAPE, isGuessedRecordAccessor } from './name-matcher';
import { isVisibleCppMacro, clearCppMacroVisibility } from './cpp-macro-visibility';
import { isCppConstructorRef, matchCppConstructor } from './cpp-constructor';
import { isCppSupertypeRef, matchCppSupertype, clearCppSupertypeMemos } from './cpp-supertypes';
import { gateSwiftTypeTarget, clearSwiftTypeVisibility, swiftExtendedConformances } from './swift-type-visibility';
import { clearDartLibraryMemos } from './dart-libraries';
import { clearVbnetReceiverMemos, isVbMemberRead, isVbPathCall, matchVbMemberRead, matchVbPathCall } from './vbnet-receivers';
import {
  clearPascalScopeMemos, gatePascalCall, isPascalParenlessRef, isPascalSystemCall, matchPascalNestedCall,
  matchPascalParenlessRef, matchPascalSystemCall,
} from './pascal-scope';
import { gateTypeParameter, clearTypeParameterMemos } from './type-parameters';
import { gateDartLocal, clearDartLocalScopeMemos } from './dart-local-scope';
import { clearCppTypeAliasMemos } from './cpp-type-aliases';
import { clearCppIncluderMemos } from './cpp-includers';
import { clearCFeatureVariantMemos } from './c-feature-variants';
import { clearAmbientModuleMemos, ambientModuleDeclarations } from './ambient-modules';
import { matchShopifyThemeFile } from './shopify-themes';
import { isJsSuperCallLanguage, isJsSuperCallSite, matchJsSuperCall } from './js-super-calls';
import { CLASS_EXPRESSION_REF_LANGUAGES, isCommonJsExportedClass, isJsClassExpression, writtenIn, type ClassExpressionIndex } from './js-class-expressions';
import { matchRubyConstantPathRef } from './ruby-constant-paths';
import { resolveViaImport, resolvePhpImportedStaticCall, resolvePhpQualifiedClassRef, resolveTsQualifiedTypeRef, resolveJvmImport, extractImportMappings, extractReExports, loadCppIncludeDirs, isPhpIncludePathRef, isCobolCopybookRef, isNixPathImportRef, isDartImportRef, isLuaRequireRef, isJsPathImportRef, isBoundToOutOfRepoImport, reachesAmbientModule, importBindingTail, clearImportResolverMemos, resolveImportPath, isExternalImport, ESM_IMPORT_LANGUAGES, jsModuleFile, pythonRootFingerprint, pythonReopenScope, pythonPackageImporters, moduleDefaultExport, isJsFamilyFile, isModuleBindingName } from './import-resolver';
import { ResolverPool, minRefsForPool, shouldEngageAdaptively } from './resolver-pool';
import { resolveAliasBinding } from './alias-binding';
import { detectFrameworks, getResolvingFrameworks } from './frameworks';
import { synthesizeCallbackEdges } from './callback-synthesizer';
import { createYielder, type MaybeYield } from './cooperative-yield';
import { MAX_SOURCE_FILE_SIZE_BYTES } from '../file-limits';
import { loadProjectAliases, type AliasMap } from './path-aliases';
import { findGoModuleForImport, goModulePackageDir, loadGoModule, type GoModule } from './go-module';
import { loadWorkspacePackages, workspaceFingerprint, workspacePackageDirOf, type WorkspacePackages } from './workspace-packages';
import { logDebug } from '../errors';
import { stripCommentsForRegex } from './strip-comments';
import { lexicalPathWithinRoot } from '../utils';
import type { CrossFileNodes, ReExport } from './types';
import { resurrectRefFromDroppedEdge } from './resurrect-ref';
import { LRUCache } from './lru-cache';
import { isTestPath } from '../search/query-utils';
import { JS_BUILT_INS } from './js-builtins';
import { builtinModules } from 'module';
import { parse as parseJsonc } from 'jsonc-parser';

const NODE_BUILTINS = new Set(builtinModules);

/** Node kinds that can declare supertypes (extends/implements). */
const SUPERTYPE_BEARING_KINDS = new Set<Node['kind']>([
  'class', 'struct', 'interface', 'trait', 'protocol', 'enum',
]);

/**
 * The only edges resolving a reference reads (getSupertypes' walk). The batch
 * loop commits a batch that made any of these before the next batch fans out;
 * its other edges land while that batch resolves. A resolution strategy that
 * reads another edge kind must be added here.
 */
const RESOLUTION_READ_EDGE_KINDS: Edge['kind'][] = ['implements', 'extends'];

// SUPERTYPE_TARGET_KINDS (the kinds an extends/implements edge may TARGET)
// lives in ./types — the name-matcher needs the same set to restrict its
// candidate pool before ranking. It is deliberately wider than
// SUPERTYPE_BEARING_KINDS above, which is about the DECLARING side.

/**
 * Languages whose chained static-factory/fluent calls defer to the conformance
 * second pass. Dotted-receiver languages resolve via matchDottedCallChain; the
 * `::`-receiver ones (Rust) via matchScopedCallChain.
 */
const CHAIN_LANGUAGES = new Set(['java', 'kotlin', 'csharp', 'swift', 'rust', 'go', 'scala', 'dart', 'objc', 'pascal']);
const SCOPED_CHAIN_LANGUAGES = new Set(['rust']);

/** The extractor's chained-receiver encoding: `<inner>().<method>`. */
const CHAIN_SHAPE = /^(.+)\(\)\.(\w+)$/;

/** PHP `$this->prop->method()` encoded as `this->prop.method` — no `()`, so CHAIN_SHAPE misses it. */
const PHP_PROP_SHAPE = /^this->\w+\.\w+$/;

/** A CFML call on a construction, `a.b.Batch().init` (#2652); CFML names may hold `$` (`$init`). */
const CFML_CONSTRUCTED_CALL = /^([A-Za-z_$][\w$.-]*)\(\)\.([A-Za-z_$][\w$]*)$/;

/**
 * How many files that import a changed module by default a sync reads the
 * edges of, when the module forwards its default from another file, to see
 * whether they still land on it (changedDefaultExports).
 */
const DEFAULT_READER_SAMPLE_FILES = 8;

/**
 * Cache size limits. Each per-resolver cache is bounded so memory
 * stays flat on large codebases (20k+ files). Sizes were chosen to
 * cover the working set for typical resolution batches without
 * exceeding a few hundred MB worst-case. Override via the env var
 * `CODEGRAPH_RESOLVER_CACHE_SIZE` (single integer applied to all
 * caches) when tuning for very large or very small projects.
 */
const DEFAULT_CACHE_LIMIT = 5_000;
function resolveCacheLimit(): number {
  const raw = process.env.CODEGRAPH_RESOLVER_CACHE_SIZE;
  if (!raw) return DEFAULT_CACHE_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_CACHE_LIMIT;
}

// Re-export types
export * from './types';

// Pre-built Sets for O(1) built-in lookups (allocated once, shared across all instances)
const REACT_HOOKS = new Set([
  'useState', 'useEffect', 'useContext', 'useReducer', 'useCallback',
  'useMemo', 'useRef', 'useLayoutEffect', 'useImperativeHandle', 'useDebugValue',
]);

const PYTHON_BUILT_INS = new Set([
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
  'open', 'input', 'type', 'isinstance', 'hasattr', 'getattr', 'setattr',
  'super', 'self', 'cls', 'None', 'True', 'False',
]);

const PYTHON_BUILT_IN_TYPES = new Set([
  'list', 'dict', 'set', 'tuple', 'str', 'int', 'float', 'bool',
  'bytes', 'bytearray', 'frozenset', 'object', 'super',
]);

const PYTHON_BUILT_IN_METHODS = new Set([
  'append', 'extend', 'insert', 'remove', 'pop', 'clear', 'sort', 'reverse', 'copy',
  'update', 'keys', 'values', 'items', 'get',
  'add', 'discard', 'union', 'intersection', 'difference',
  'split', 'join', 'strip', 'lstrip', 'rstrip', 'replace', 'lower', 'upper',
  'startswith', 'endswith', 'find', 'index', 'count', 'encode', 'decode',
  'format', 'isdigit', 'isalpha', 'isalnum',
  'read', 'write', 'readline', 'readlines', 'close', 'flush', 'seek',
]);

const GO_BUILT_INS = new Set([
  'make', 'new', 'len', 'cap', 'append', 'copy', 'delete', 'close',
  'panic', 'recover', 'print', 'println', 'complex', 'real', 'imag',
  'error', 'nil', 'true', 'false', 'iota',
  'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'float32', 'float64', 'complex64', 'complex128',
  'string', 'bool', 'byte', 'rune', 'any',
]);

/** What a Pascal typecast's name resolves to: `TFoo(x)` casts, it doesn't call (see createEdges). */
const PASCAL_CAST_TARGET_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'interface', 'enum', 'type_alias']);

/** The values a TypeScript type may share its name with in its file, which a call or `new` of the name means. */
const TYPE_COMPANION_VALUE_KINDS: ReadonlySet<string> = new Set(['function', 'class', 'component', 'constant', 'variable']);

/**
 * The RTL's unit namespaces, as it spells them. Spelled otherwise, a
 * receiver is most likely a variable that hides one (`data.GetObjectFrom`,
 * `rest.EngineAdd`); only `system.` is the System unit's in any case.
 */
const PASCAL_UNIT_PREFIXES = [
  'System.', 'Winapi.', 'Vcl.', 'Fmx.', 'Data.', 'Datasnap.',
  'Soap.', 'Xml.', 'Web.', 'REST.', 'FireDAC.', 'IBX.',
  'IdHTTP', 'IdTCP', 'IdSSL',
];

/** Lowercased: Pascal names ignore case. */
const PASCAL_BUILT_INS = new Set([
  'System', 'SysUtils', 'Classes', 'Types', 'Variants', 'StrUtils',
  'Math', 'DateUtils', 'IOUtils', 'Generics.Collections', 'Generics.Defaults',
  'Rtti', 'TypInfo', 'SyncObjs', 'RegularExpressions',
  'SysInit', 'Windows', 'Messages', 'Graphics', 'Controls', 'Forms',
  'Dialogs', 'StdCtrls', 'ExtCtrls', 'ComCtrls', 'Menus', 'ActnList',
  'WriteLn', 'Write', 'ReadLn', 'Read', 'Inc', 'Dec', 'Ord', 'Chr',
  'Length', 'SetLength', 'High', 'Low', 'Assigned', 'FreeAndNil',
  'Format', 'IntToStr', 'StrToInt', 'FloatToStr', 'StrToFloat',
  'Trim', 'UpperCase', 'LowerCase', 'Pos', 'Copy', 'Delete', 'Insert',
  'Now', 'Date', 'Time', 'DateToStr', 'StrToDate',
  'Raise', 'Exit', 'Break', 'Continue', 'Abort',
  'True', 'False', 'nil', 'Self', 'Result',
  'Create', 'Destroy', 'Free',
  'TObject', 'TComponent', 'TPersistent', 'TInterfacedObject',
  'TList', 'TStringList', 'TStrings', 'TStream', 'TMemoryStream', 'TFileStream',
  'Exception', 'EAbort', 'EConvertError', 'EAccessViolation',
  'IInterface', 'IUnknown',
].map((name) => name.toLowerCase()));

const C_BUILT_INS = new Set([
  // Standard C library functions
  'printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'fscanf', 'sscanf',
  'malloc', 'calloc', 'realloc', 'free',
  'memcpy', 'memmove', 'memset', 'memcmp', 'memchr',
  'strlen', 'strcpy', 'strncpy', 'strcat', 'strncat', 'strcmp', 'strncmp',
  'strstr', 'strchr', 'strrchr', 'strtok', 'strdup',
  'fopen', 'fclose', 'fread', 'fwrite', 'fgets', 'fputs', 'fputc', 'fgetc',
  'feof', 'ferror', 'fflush', 'fseek', 'ftell', 'rewind',
  'exit', 'abort', 'atexit', 'atoi', 'atol', 'atof', 'strtol', 'strtoul', 'strtod',
  'qsort', 'bsearch',
  'abs', 'labs', 'rand', 'srand',
  'sin', 'cos', 'tan', 'sqrt', 'pow', 'log', 'log10', 'exp', 'ceil', 'floor', 'fabs',
  'time', 'clock', 'difftime', 'mktime', 'localtime', 'gmtime', 'strftime', 'asctime',
  'assert', 'errno',
  'perror', 'remove', 'rename', 'tmpfile', 'tmpnam',
  'getenv', 'system',
  'signal', 'raise',
  'setjmp', 'longjmp',
  'va_start', 'va_end', 'va_arg', 'va_copy',
  'NULL', 'EOF', 'BUFSIZ', 'FILENAME_MAX', 'RAND_MAX', 'EXIT_SUCCESS', 'EXIT_FAILURE',
  'size_t', 'ptrdiff_t', 'wchar_t', 'intptr_t', 'uintptr_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'FILE',
  // POSIX additions commonly seen
  'stat', 'lstat', 'fstat', 'open', 'close', 'read', 'write', 'pipe',
  'fork', 'exec', 'waitpid', 'getpid', 'getppid', 'kill', 'sleep', 'usleep',
  'pthread_create', 'pthread_join', 'pthread_mutex_lock', 'pthread_mutex_unlock',
  'dlopen', 'dlsym', 'dlclose',
]);

const CPP_BUILT_INS = new Set([
  // iostream objects (often used without std:: prefix via using)
  'cout', 'cin', 'cerr', 'clog', 'endl', 'flush', 'ws',
  'std', // the namespace itself when used as std::something
  // Common C++ keywords that leak as references
  'nullptr', 'true', 'false', 'this', 'sizeof', 'alignof', 'typeid',
  'static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast',
  'make_unique', 'make_shared', 'make_pair',
  'move', 'forward', 'swap',
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
  /** `frameworks` narrowed to those that resolve each reference language (see getResolvingFrameworks). */
  private frameworksByLanguage = new Map<Language, FrameworkResolver[]>();
  // Chained static-factory/fluent call refs the first pass couldn't resolve,
  // collected in-memory and left pending in the DB until the post-pass
  // finishes, so a restart can recover the queue (#1577). Drained by
  // resolveChainedCallsViaConformance
  // once implements/extends edges exist, to resolve methods on a supertype the
  // receiver conforms to (#750).
  private deferredChainRefs: UnresolvedRef[] = [];
  // `this.<member>` function-as-value refs whose member is NOT on the
  // enclosing class itself — possibly inherited. Collected in-memory for the
  // same reason as deferredChainRefs and drained by
  // resolveDeferredThisMemberRefs once implements/extends edges exist (#808).
  private deferredThisMemberRefs: UnresolvedRef[] = [];
  private deferredRowIds = new Set<number>();
  // Per-`.razor`/`.cshtml`-file `@using` namespace set (own directives + folder
  // `_Imports.razor`, cascading to the project root). Used to disambiguate a
  // markup type ref to the right C# namespace.
  private razorUsingsCache = new Map<string, string[]>();
  // All per-resolver caches are LRU-bounded. Previously these were
  // unbounded Maps that grew with every distinct lookup and OOM'd on
  // codebases with 20k+ files (see issue: unbounded cache growth).
  private nodeCache: LRUCache<string, Node[]>; // per-file node cache
  private fileCache: LRUCache<string, string | null>; // per-file content cache
  private importMappingCache: LRUCache<string, ImportMapping[]>;
  private reExportCache: LRUCache<string, ReExport[]>;
  private nameCache: LRUCache<string, Node[]>; // name → nodes cache
  private lowerNameCache: LRUCache<string, Node[]>; // lower(name) → nodes cache
  private qualifiedNameCache: LRUCache<string, Node[]>; // qualified_name → nodes cache
  private fileLinesCache: LRUCache<string, string[] | null>; // file → split lines cache
  // id → node for the resolver's own point reads. Every resolved reference
  // re-reads its target a few times (kind gate, language gate, alias
  // following, edge creation) and targets recur ~5× on large repos; the query
  // layer's cache is too small for that working set. Same stable window as the
  // name caches above; absent ids are not cached.
  private nodeByIdCache: LRUCache<string, Node>;
  private methodMatchCache: LRUCache<string, Node[]>; // lang\0Type::method → matching method nodes
  // Per-(language, methodName) owner index for getMethodMatches: buckets a
  // method name's candidates by their qualifiedName's last two segments so a
  // (type, method) query is a lookup instead of an O(candidates) filter per
  // methodMatchCache miss. Derived purely from node rows (stable through the
  // resolution loop, same window nameCache relies on); dropped in clearCaches.
  private methodOwnerIndexCache = new Map<string, Map<string, Node[]>>();
  // Generation-tagged memo for getSupertypes. Supertype edges GROW during the
  // resolution loop (batch k persists its implements/extends edges BEFORE
  // batch k+1 fans out — the #1320 ordering), so a plain cache would freeze an
  // early batch's emptier answer and change later batches' outcomes. Within
  // one batch the edge state is fixed by that same ordering, so entries are
  // tagged with a generation that advances at every batch entry point
  // (resolveBatchYielding / resolveListForAdmission) — a stale-gen entry is
  // recomputed, making the memo behavior-identical to no memo at every point
  // in time. On the Swift compiler the unmemoized walk ran 971k times for
  // 565s of combined worker time (~581µs each, recursion-multiplied).
  private supertypeGen = 0;
  private supertypeMemo = new Map<string, { gen: number; supers: string[] }>();
  // getSupertypeNodes' memo, by node id, under the same generation tag.
  private supertypeNodeMemo = new Map<string, { gen: number; nodes: Node[] }>();
  // getSuperclassNodes' memo (`extends` edges alone), the same way.
  private superclassNodeMemo = new Map<string, { gen: number; nodes: Node[] }>();

  /** Invalidate the getSupertypes memo — call when resolved edges may have advanced. */
  private advanceSupertypeGeneration(): void {
    this.supertypeGen++;
    // Lazy invalidation via the gen tag; bound the map so a long run over many
    // batches doesn't accrete dead entries.
    if (this.supertypeMemo.size > 50_000) this.supertypeMemo.clear();
    if (this.supertypeNodeMemo.size > 50_000) this.supertypeNodeMemo.clear();
    if (this.superclassNodeMemo.size > 50_000) this.superclassNodeMemo.clear();
  }
  // Node kinds are a small fixed set (~24), so this is a plain Map, not an LRU.
  // getNodesByKind returns the FULL node list for a kind; it was previously
  // uncached — a per-ref `SELECT * FROM nodes WHERE kind=?` + row-mapping. Called
  // for every dotted call ref by the Spring resolver (constants) and every
  // `hook_` ref by the Drupal resolver (functions), that scan dominated
  // resolution on large repos (#1180). The node set is stable within a
  // resolution pass (same lifetime assumption as nameCache); clearCaches() resets
  // it between passes. Callers must treat the returned array as read-only.
  private nodesByKindCache = new Map<Node['kind'], Node[]>();
  // Filesystem existence probes behind context.fileExists (paths not in knownFiles).
  private fileExistsMemo = new Map<string, boolean>();
  private knownNames: Set<string> | null = null; // all known symbol names for fast pre-filtering
  private knownFiles: Set<string> | null = null;
  private cachesWarmed = false;
  // tsconfig/jsconfig path-alias map. `undefined` = not yet computed,
  // `null` = computed and absent. Treated as immutable for the
  // resolver's lifetime; callers re-create the resolver if config changes.
  private projectAliases: AliasMap | null | undefined = undefined;
  // Per directory: the aliases of the nearest non-root tsconfig declaring `paths` or `baseUrl`.
  private dirAliases = new Map<string, AliasMap | null>();
  // Per project-relative directory ('' = the root): the module of the nearest
  // go.mod at or above it, up to the project root. Same lazy/immutable
  // convention as dirAliases.
  private goModuleByDir = new Map<string, GoModule | null>();
  // The project's Go modules: the root one plus every module that owns an
  // indexed .go file. Depends on the file set, like knownFiles, so
  // clearCaches drops it.
  private goModules: GoModule[] | null = null;
  // getGoPackageDir answers, keyed by import path and the importing file's
  // module. Derived from goModules, so dropped with it.
  private goPackageDirs = new Map<string, string | null>();
  // Monorepo workspace member packages. Same lazy/immutable convention.
  private workspacePackages: WorkspacePackages | null | undefined = undefined;

  constructor(projectRoot: string, queries: QueryBuilder) {
    this.projectRoot = projectRoot;
    this.queries = queries;

    const limit = resolveCacheLimit();
    // The content cache is heavier (full file text), so we give it a
    // smaller budget than the metadata caches.
    const contentLimit = Math.max(64, Math.floor(limit / 5));
    this.nodeCache = new LRUCache(limit);
    this.fileCache = new LRUCache(contentLimit);
    this.importMappingCache = new LRUCache(limit);
    this.reExportCache = new LRUCache(limit);
    this.nameCache = new LRUCache(limit);
    this.lowerNameCache = new LRUCache(limit);
    this.qualifiedNameCache = new LRUCache(limit);
    // Split-lines arrays are heavier than content strings; refs arrive
    // file-ordered, so a small cache still hits nearly always.
    this.fileLinesCache = new LRUCache(contentLimit);
    this.nodeByIdCache = new LRUCache(Math.max(limit * 4, 20_000));
    this.methodMatchCache = new LRUCache(limit);

    this.context = this.createContext();
  }

  /**
   * Initialize the resolver (detect frameworks, etc.)
   */
  initialize(): void {
    // A full index resolves by the package.json files on disk now, as the
    // fingerprint it stamps says, even in a process that read them earlier.
    this.workspacePackages = undefined;
    this.frameworks = detectFrameworks(this.context);
    this.frameworksByLanguage.clear();
    this.clearCaches();
  }

  /** The detected frameworks whose `resolve()` reads a reference written in `language`. */
  private frameworksFor(language: Language): FrameworkResolver[] {
    let frameworks = this.frameworksByLanguage.get(language);
    if (!frameworks) {
      frameworks = getResolvingFrameworks(this.frameworks, language);
      this.frameworksByLanguage.set(language, frameworks);
    }
    return frameworks;
  }

  /**
   * Run each framework resolver's cross-file finalization pass and persist
   * the returned node updates. Idempotent — safe to call after every indexAll
   * and every incremental sync. Returns the number of nodes updated.
   *
   * Caches are cleared before/after so the post-extract pass sees fresh DB
   * state and downstream queries see the updated names.
   */
  runPostExtract(): number {
    let updated = 0;
    this.clearCaches();
    for (const fw of this.frameworks) {
      if (!fw.postExtract) continue;
      try {
        const nodes = fw.postExtract(this.context);
        for (const node of nodes) {
          this.queries.updateNode(node);
          updated++;
        }
      } catch (err) {
        logDebug(`Framework '${fw.name}' postExtract failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const fw of this.frameworks) {
      if (!fw.crossFileNodes) continue;
      try {
        updated += this.reconcileCrossFileNodes(fw.crossFileNodes(this.context));
      } catch (err) {
        logDebug(`Framework '${fw.name}' crossFileNodes failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (updated > 0) this.clearCaches();
    return updated;
  }

  /**
   * Bring a framework's cross-file nodes in line with what it wants now:
   * insert the new ones with their references (pending, for the resolution
   * that follows), rename the ones whose name changed, and remove the ones it
   * no longer wants. A removed node's incoming resolution edges go back to
   * being the references that made them, exactly as when a file is deleted,
   * so they rebind elsewhere or park as failed. Unchanged nodes are not
   * touched, so their edges survive. Returns the number of nodes changed.
   */
  private reconcileCrossFileNodes(result: CrossFileNodes): number {
    const wanted = new Map<string, Node>();
    for (const node of result.nodes) if (result.owns(node)) wanted.set(node.id, node);
    const existing = new Map<string, Node>();
    for (const node of this.queries.getNodesByKind(result.kind)) if (result.owns(node)) existing.set(node.id, node);
    let changed = 0;
    for (const [id, old] of existing) {
      if (wanted.has(id)) continue;
      const refs = this.queries.getCrossFileIncomingEdgesWithTarget(old.filePath)
        .filter((e) => e.target === id)
        .map((e) => resurrectRefFromDroppedEdge(e))
        .filter((r): r is UnresolvedReference => r !== null);
      if (refs.length > 0) this.queries.insertUnresolvedRefsBatch(refs);
      this.queries.deleteNode(id);
      changed++;
    }
    const added: Node[] = [];
    for (const [id, node] of wanted) {
      const old = existing.get(id);
      if (!old) added.push(node);
      else if (old.name !== node.name || old.qualifiedName !== node.qualifiedName) {
        this.queries.updateNode(node);
        changed++;
      }
    }
    if (added.length > 0) {
      this.queries.insertNodes(added);
      const ids = new Set(added.map((n) => n.id));
      this.queries.insertUnresolvedRefsBatch(result.references.filter((r) => ids.has(r.fromNodeId)));
      changed += added.length;
    }
    return changed;
  }

  /**
   * Put back in the pending set the route references whose answer reads a
   * module in `changedFilePaths` (`FrameworkResolver.lazyModules`), for a
   * sync's resolution sweep. Returns the number put back.
   *
   * A route that renders a same-file `const Docs = lazy(() =>
   * import('./pages/Docs'))` binds to the declaration while the module is
   * missing, and nothing revisited it once the module was added: the
   * reference had resolved, so it was never parked for the failed-ref retry,
   * and the rebind of the names a sync defines (CG-33) reaches it only when
   * the module's component is named like the declaration. An edit that gives
   * the module its default export, or moves it to another component, changes
   * the answer the same way: a route's edge follows its old target through
   * the module's re-index. So does a page behind a barrel the module
   * forwards. References written in a changed file were resolved against the
   * new files already.
   */
  reopenRouteModuleReaders(changedFilePaths: readonly string[]): number {
    const readers = this.frameworks.filter((f) => f.lazyModules);
    if (readers.length === 0 || changedFilePaths.length === 0) return 0;
    const changed = new Set(changedFilePaths);
    const edgeIds: number[] = [];
    const refs: UnresolvedReference[] = [];
    for (const edge of this.queries.getRouteEdgesMovedBy(changedFilePaths)) {
      const ref = resurrectRefFromDroppedEdge(edge);
      if (!ref) continue;
      const asked: UnresolvedRef = { ...ref, filePath: edge.sourceFilePath, language: edge.sourceLanguage };
      const reads = readers.some((f) => f.lazyModules!(asked, this.context).some((file) => changed.has(file)));
      if (!reads) continue;
      edgeIds.push(edge.edgeId);
      refs.push(ref);
    }
    if (refs.length > 0) this.queries.replaceResolutionEdgesWithUnresolvedRefs(edgeIds, refs);
    return refs.length;
  }

  /**
   * Pre-build lightweight caches for resolution.
   * Node lookups are now handled by indexed SQLite queries instead of
   * loading all nodes into memory (which caused OOM on large codebases).
   * We cache the set of known symbol names for fast pre-filtering.
   */
  warmCaches(): void {
    if (this.cachesWarmed) return;

    // Only cache the set of known file paths (lightweight string set)
    this.knownFiles = new Set(this.queries.getAllFilePaths());

    // Cache all distinct symbol names for fast pre-filtering (just strings, not full nodes)
    this.knownNames = new Set(this.queries.getAllNodeNames());

    this.cachesWarmed = true;
  }

  /**
   * warmCaches for the async resolution entry points: streams the distinct
   * name set with periodic yields instead of one synchronous `.all()`. On a
   * multi-million-node index the DISTINCT scan is a solid multi-second block
   * (measured up to 28s inside `codegraph sync` on the Linux kernel index),
   * long enough to matter to the #850 watchdog on slower hardware. Same
   * result, same memory — only the event loop keeps turning.
   */
  async warmCachesYielding(onYield: MaybeYield): Promise<void> {
    if (this.cachesWarmed) return;

    this.knownFiles = new Set(this.queries.getAllFilePaths());

    const names = new Set<string>();
    let scanned = 0;
    for (const name of this.queries.iterateNodeNames()) {
      names.add(name);
      if ((++scanned & 8191) === 0) await onYield();
    }
    this.knownNames = names;

    this.cachesWarmed = true;
  }

  /** `queries.getNodeById` through the resolver's own id → node cache. */
  private nodeById(id: string): Node | null {
    const cached = this.nodeByIdCache.get(id);
    if (cached !== undefined) return cached;
    const node = this.queries.getNodeById(id);
    if (node) this.nodeByIdCache.set(id, node);
    return node;
  }

  /**
   * Clear internal caches
   */
  clearCaches(): void {
    this.mocklessContext = null;
    this.mocklessBase = null;
    this.manualMocks = undefined;
    this.classExpressionFreeViews = new WeakMap();
    this.classExpressionFreeBases = new WeakMap();
    this.classExpressionIndex = undefined;
    this.classExpressionOnlyNameSet = null;
    this.nodeCache.clear();
    this.fileCache.clear();
    this.importMappingCache.clear();
    this.reExportCache.clear();
    this.nameCache.clear();
    this.lowerNameCache.clear();
    this.qualifiedNameCache.clear();
    this.fileLinesCache.clear();
    this.nodeByIdCache.clear();
    this.methodMatchCache.clear();
    this.methodOwnerIndexCache.clear();
    this.supertypeMemo.clear();
    this.supertypeNodeMemo.clear();
    this.superclassNodeMemo.clear();
    this.supertypeGen++;
    this.nodesByKindCache.clear();
    this.fileExistsMemo.clear();
    this.manifestScopes.clear();
    this.knownNames = null;
    this.knownLowerNames = null;
    this.knownFiles = null;
    this.goModules = null;
    this.goPackageDirs.clear();
    this.cachesWarmed = false;
    // The import-resolver's and name-matcher's per-context memos assume the
    // same stable window as the caches above — drop them together.
    if (this.context) {
      clearImportResolverMemos(this.context);
      clearNameMatcherMemos(this.context);
      clearCppMacroVisibility(this.context);
      clearSwiftTypeVisibility(this.context);
      clearDartLibraryMemos(this.context);
      clearVbnetReceiverMemos(this.context);
      clearPascalScopeMemos(this.context);
      clearTypeParameterMemos(this.context);
      clearDartLocalScopeMemos(this.context);
      clearCppTypeAliasMemos(this.context);
      clearCppSupertypeMemos(this.context);
      clearCppIncluderMemos(this.context);
      clearCFeatureVariantMemos(this.context);
      clearAmbientModuleMemos(this.context);
    }
  }

  /**
   * The module of the nearest `go.mod` at or above project-relative `dir`
   * ('' = the root), never above the project root (#2322). Each directory
   * is read at most once: every directory the walk passes is memoized.
   */
  private nearestGoModule(dir: string): GoModule | null {
    const walked: string[] = [];
    let found: GoModule | null | undefined;
    for (;;) {
      found = this.goModuleByDir.get(dir);
      if (found !== undefined) break;
      walked.push(dir);
      found = loadGoModule(path.join(this.projectRoot, dir));
      if (found || dir === '') break;
      dir = goDirOf(dir);
    }
    for (const d of walked) this.goModuleByDir.set(d, found);
    return found;
  }

  /**
   * The project's Go modules: the root `go.mod`'s, and the nearest `go.mod`
   * of every directory holding an indexed `.go` file — so an ignored or
   * vendored tree, which holds no indexed file, adds none, and nothing walks
   * the disk. The go tool ignores `testdata/` and `_`/`.`-prefixed
   * directories, so a module there serves only its own files (#2322).
   */
  private getGoModules(): GoModule[] {
    if (this.goModules) return this.goModules;
    const dirs = new Set<string>(['']);
    for (const file of this.knownFiles ?? this.queries.getAllFilePaths()) {
      if (file.endsWith('.go')) dirs.add(goDirOf(file));
    }
    const modules = new Set<GoModule>();
    for (const dir of dirs) {
      const mod = this.nearestGoModule(dir);
      const modDir = mod ? path.relative(this.projectRoot, mod.rootDir).split(path.sep).join('/') : '';
      if (mod && !/(?:^|\/)(?:testdata|[_.][^/]*)(?:\/|$)/.test(modDir)) modules.add(mod);
    }
    this.goModules = [...modules];
    return this.goModules;
  }

  /** `readFile` through the LRU content cache (null = read failed, also cached). */
  private readFileCached(filePath: string): string | null {
    if (this.fileCache.has(filePath)) {
      return this.fileCache.get(filePath)!;
    }
    const fullPath = path.join(this.projectRoot, filePath);
    try {
      // Import resolvers may follow package metadata to an archive (`file:*.har`,
      // for example). Reject anything extraction would not accept before UTF-8
      // decoding can multiply a large binary blob into gigabytes of V8 heap.
      const stats = fs.statSync(fullPath);
      if (!stats.isFile() || stats.size > MAX_SOURCE_FILE_SIZE_BYTES) {
        this.fileCache.set(filePath, null);
        return null;
      }
      const content = fs.readFileSync(fullPath, 'utf-8');
      this.fileCache.set(filePath, content);
      return content;
    } catch (error) {
      logDebug('Failed to read file for resolution', { filePath, error: String(error) });
      this.fileCache.set(filePath, null);
      return null;
    }
  }

  /**
   * `readFileCached(filePath)?.includes(needle)` for an ASCII needle, searched
   * in the raw bytes: an ASCII byte sequence survives UTF-8 decoding
   * unchanged, and decoding is most of reading a file nobody keeps.
   */
  private fileContains(filePath: string, needle: string): boolean {
    if (this.fileCache.has(filePath)) return this.fileCache.get(filePath)?.includes(needle) ?? false;
    const fullPath = path.join(this.projectRoot, filePath);
    try {
      const stats = fs.statSync(fullPath);
      if (!stats.isFile() || stats.size > MAX_SOURCE_FILE_SIZE_BYTES) return false;
      return fs.readFileSync(fullPath).includes(needle);
    } catch {
      return false;
    }
  }

  /**
   * Create the resolution context
   */
  private createContext(): ResolutionContext {
    return {
      // A C or C++ `#include` the import resolver can't place is linked by the
      // end of its path, as resolveOneInner's name matching does: protobuf's
      // `google/protobuf/descriptor.upb.h`, which two generated copies end in.
      // cppIncluders reads includes through this, so it sees the include edges
      // a reader sees. A standard header is never the project's: `<math.h>`
      // is not jemalloc's test/math.h, which only its includers may see.
      resolveImport: (ref) => resolveViaImport(ref, this.context) ??
        ((ref.language === 'c' || ref.language === 'cpp') && ref.referenceKind === 'imports' &&
          !isExternalImport(ref.referenceName, ref.language, this.context) ? matchByFilePath(ref, this.context) : null),
      // A path alias makes an import the project's only when it maps the
      // import to a file the index holds. Matching its prefix is not enough:
      // cord-field's `"*": ["./typings/*"]` matches every package, and
      // counting the match bound 169 imports of `@mui/material`'s Typography
      // to its own. Nor is a path that exists on disk: home-assistant's
      // `"lit/decorators": ["./node_modules/lit/decorators.js"]` lands in
      // `node_modules`, topcoder's `config` package on its `config/` folder.
      isOutOfRepoImport: (source, fromFile, language) => {
        if (!isExternalImport(source, language, this.context, { aliasPrefixes: false, fromFile })) return false;
        const resolved = resolveImportPath(source, fromFile, language, this.context);
        if (resolved !== null && this.isIndexedFile(resolved)) return false;
        return this.isDeclaredOutsidePackage(source, fromFile);
      },
      resolveModuleFile: (source, fromFile, language) =>
        resolveImportPath(source, fromFile, language, this.context),
      isDeclaredPackage: (source, fromFile) => this.isDeclaredOutsidePackage(source, fromFile),
      isIndexedFile: (filePath) => this.isIndexedFile(filePath),
      getNodesInFile: (filePath: string) => {
        if (!this.nodeCache.has(filePath)) {
          this.nodeCache.set(filePath, this.queries.getNodesByFile(filePath));
        }
        return this.nodeCache.get(filePath)!;
      },

      fileHasExportedNode: (filePath: string) => {
        const cached = this.nodeCache.get(filePath);
        return cached !== undefined ? cached.some((n) => n.isExported) : this.queries.fileHasExportedNode(filePath);
      },

      getExportedNodesInFile: (filePath: string) => {
        const cached = this.nodeCache.get(filePath);
        return cached !== undefined ? cached.filter((n) => n.isExported) : this.queries.getExportedNodesByFile(filePath);
      },

      getNodesInFileNamed: (filePath: string, name: string) => {
        const cached = this.nodeCache.get(filePath);
        return cached !== undefined ? cached.filter((n) => n.name === name) : this.queries.getNodesByFileAndName(filePath, name);
      },

      getNodesByName: (name: string) => {
        const cached = this.nameCache.get(name);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByName(name);
        this.nameCache.set(name, result);
        return result;
      },

      // The set warmCaches loads (`SELECT DISTINCT name FROM nodes`, the exact
      // match getNodesByName makes); unloaded, no name is absent.
      isAbsentName: (name: string) => this.knownNames !== null && !this.knownNames.has(name),

      getMethodMatches: (typeName: string, methodName: string, language: Language) => {
        const key = `${language} ${typeName}::${methodName}`;
        const cached = this.methodMatchCache.get(key);
        if (cached !== undefined) return cached;
        let candidates = this.nameCache.get(methodName);
        if (candidates === undefined) {
          candidates = this.queries.getNodesByName(methodName);
          this.nameCache.set(methodName, candidates);
        }
        const want = `${typeName}::${methodName}`;
        let matches: Node[];
        if (typeName.includes('::') || methodName.includes(':')) {
          // Legacy linear filter for the shapes the owner index below can't
          // key exactly: a multi-segment typeName (the endsWith test then
          // spans more than two `::` segments) and ObjC selectors (whose
          // single/empty-keyword colons defeat the segment split). Tiny
          // populations; the per-key memo above still amortizes them.
          matches = [];
          for (const m of candidates) {
            if (m.kind !== 'method') continue;
            if (!sameLanguageFamily(m.language, language)) continue;
            const qn = m.qualifiedName;
            if (qn === want || qn.endsWith(`::${want}`)) matches.push(m);
          }
        } else {
          // Owner index: the linear filter above is O(all same-named methods)
          // per CACHE MISS, and on overload-heavy landscapes the distinct
          // (type, method) key space is so large the per-key memo never
          // amortizes — Swift's `init` has tens of thousands of candidates
          // and the compiler repo measured 732µs per failing call, most of it
          // this scan (re-entered once per supertype recursion level, too).
          // Bucket each (language, methodName)'s candidates ONCE by the
          // qualifiedName's last two `::` segments — exactly the span the
          // `qn === want || qn.endsWith('::' + want)` predicate tests for a
          // segment-clean typeName — then every query is a map lookup.
          // Bucket insertion follows candidate order, so each bucket is
          // byte-identical to what the linear filter produced.
          const idxKey = `${language} ${methodName}`;
          let ownerIndex = this.methodOwnerIndexCache.get(idxKey);
          if (!ownerIndex) {
            ownerIndex = new Map<string, Node[]>();
            for (const m of candidates) {
              if (m.kind !== 'method') continue;
              if (!sameLanguageFamily(m.language, language)) continue;
              const qn = m.qualifiedName;
              const i2 = qn.lastIndexOf('::');
              if (i2 < 0) continue; // single-segment qn can never match `T::m`
              const i1 = qn.lastIndexOf('::', i2 - 1);
              const bucketKey = i1 < 0 ? qn : qn.slice(i1 + 2);
              const bucket = ownerIndex.get(bucketKey);
              if (bucket) bucket.push(m);
              else ownerIndex.set(bucketKey, [m]);
            }
            this.methodOwnerIndexCache.set(idxKey, ownerIndex);
          }
          matches = ownerIndex.get(want) ?? [];
        }
        this.methodMatchCache.set(key, matches);
        return matches;
      },

      getNodesByQualifiedName: (qualifiedName: string) => {
        const cached = this.qualifiedNameCache.get(qualifiedName);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByQualifiedNameExact(qualifiedName);
        this.qualifiedNameCache.set(qualifiedName, result);
        return result;
      },

      getNodesByKind: (kind: Node['kind']) => {
        const cached = this.nodesByKindCache.get(kind);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByKind(kind);
        this.nodesByKindCache.set(kind, result);
        return result;
      },

      // Streamed, uncached — synthesizers scan-and-filter whole kinds, and
      // both the materialized array AND the per-kind cache retention are
      // O(nodes) memory (#1212). Per-ref resolvers keep the cached array
      // variant above.
      iterateNodesByKind: (kind: Node['kind']) => this.queries.iterateNodesByKind(kind),

      fileExists: (filePath: string) => {
        // Check pre-built known files set first (O(1))
        if (this.knownFiles) {
          const normalized = filePath.replace(/\\/g, '/');
          if (this.knownFiles.has(filePath) || this.knownFiles.has(normalized)) {
            return true;
          }
        }
        // Fall back to filesystem for files not yet indexed. `path.join` does
        // not clamp, and relative-import resolution hands us paths carrying
        // `../` segments, so the probe has to be contained (#1631): a path
        // outside the root can never be an indexed project file, and the
        // `knownFiles` check above already answered for everything that is.
        // Lexical containment only: this is a per-candidate hot path, and the
        // symlink half of `validatePathWithinRoot` costs two `realpathSync`
        // calls per probe (~70x slower here). It would also be wrong to apply
        // — indexing deliberately follows in-root symlinks whose targets live
        // outside the root (#935), so only the `../` escape is refused.
        // Memoized: import resolution probes the same candidate paths (every
        // extension of a specifier) from every file that imports it, and the
        // tree does not change within a resolution pass (same window as the
        // file-content cache; dropped by clearCaches).
        const probed = this.fileExistsMemo.get(filePath);
        if (probed !== undefined) return probed;
        const fullPath = lexicalPathWithinRoot(this.projectRoot, filePath);
        let exists = false;
        if (fullPath !== null) {
          try {
            exists = fs.existsSync(fullPath);
          } catch (error) {
            logDebug('Error checking file existence', { filePath, error: String(error) });
          }
        }
        if (this.fileExistsMemo.size >= 200_000) this.fileExistsMemo.clear();
        this.fileExistsMemo.set(filePath, exists);
        return exists;
      },

      readFile: (filePath: string) => this.readFileCached(filePath),

      fileContains: (filePath: string, needle: string) => this.fileContains(filePath, needle),

      getFileLines: (filePath: string) => {
        const cached = this.fileLinesCache.get(filePath);
        if (cached !== undefined) return cached;
        const source = this.readFileCached(filePath);
        const lines = source === null ? null : source.split(/\r?\n/);
        this.fileLinesCache.set(filePath, lines);
        return lines;
      },

      getProjectRoot: () => this.projectRoot,

      getAllFiles: () => {
        return this.queries.getAllFilePaths();
      },

      listDirectories: (relativePath: string) => {
        const target = relativePath === '.' || relativePath === ''
          ? this.projectRoot
          : path.join(this.projectRoot, relativePath);
        try {
          return fs
            .readdirSync(target, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
        } catch (error) {
          logDebug('Failed to list directory for resolution', {
            relativePath,
            error: String(error),
          });
          return [];
        }
      },

      getNodesByLowerName: (lowerName: string) => {
        const cached = this.lowerNameCache.get(lowerName);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByLowerName(lowerName);
        this.lowerNameCache.set(lowerName, result);
        return result;
      },

      getNodeNamesOfKinds: (language, kinds) => this.queries.getNodeNamesOfKinds(language, kinds),

      rememberNode: (node: Node) => {
        if (!this.nodeByIdCache.has(node.id)) this.nodeByIdCache.set(node.id, node);
      },

      getNodeById: (id: string) => {
        return this.nodeById(id);
      },

      getSupertypes: (typeName: string, language) => {
        // Union the `implements`/`extends` targets of every same-named type node.
        // Matching by simple name (not id) reconciles a type declared in one node
        // (`KF::Builder`) with conformance declared in a separate extension node
        // (`KF.Builder: KFOptionSetter`) — both have name `Builder`.
        // Memoized per batch generation (see supertypeMemo): within a batch the
        // edge state is fixed, and the conformance walk re-queries the same
        // popular supertypes (Swift stdlib protocols especially) thousands of
        // times per batch.
        const memoKey = `${language} ${typeName}`;
        const hit = this.supertypeMemo.get(memoKey);
        if (hit && hit.gen === this.supertypeGen) return hit.supers;
        const typeNodes = this.context
          .getNodesByName(typeName)
          // Scala singletons can inherit members even though they cannot be parents.
          .filter((n) => n.language === language && (SUPERTYPE_BEARING_KINDS.has(n.kind) ||
            (n.language === 'scala' && n.kind === 'module')));
        let supers: string[];
        if (typeNodes.length === 0) {
          supers = [];
        } else {
          const supertypes = new Set<string>();
          for (const tn of typeNodes) {
            for (const edge of this.queries.getOutgoingEdges(tn.id, RESOLUTION_READ_EDGE_KINDS)) {
              const target = this.nodeById(edge.target);
              if (target?.name && target.name !== typeName) supertypes.add(target.name);
            }
            // A Swift conformance to a type the project only extends (SwiftUI's
            // `View`) resolves to nothing — the extension is not the type — yet
            // the members its extensions add are still the conformer's.
            if (language === 'swift') {
              for (const name of swiftExtendedConformances(tn, this.context)) {
                if (name !== typeName) supertypes.add(name);
              }
            }
          }
          supers = [...supertypes];
        }
        this.supertypeMemo.set(memoKey, { gen: this.supertypeGen, supers });
        return supers;
      },

      getSupertypeNodes: (id: string) => {
        const hit = this.supertypeNodeMemo.get(id);
        if (hit && hit.gen === this.supertypeGen) return hit.nodes;
        const nodes: Node[] = [];
        for (const edge of this.queries.getOutgoingEdges(id, RESOLUTION_READ_EDGE_KINDS)) {
          const target = this.nodeById(edge.target);
          if (target) nodes.push(target);
        }
        this.supertypeNodeMemo.set(id, { gen: this.supertypeGen, nodes });
        return nodes;
      },

      getSuperclassNodes: (id: string) => {
        const hit = this.superclassNodeMemo.get(id);
        if (hit && hit.gen === this.supertypeGen) return hit.nodes;
        const nodes: Node[] = [];
        for (const edge of this.queries.getOutgoingEdges(id, ['extends'])) {
          const target = this.nodeById(edge.target);
          if (target) nodes.push(target);
        }
        this.superclassNodeMemo.set(id, { gen: this.supertypeGen, nodes });
        return nodes;
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

      getProjectAliases: () => {
        if (this.projectAliases === undefined) {
          this.projectAliases = loadProjectAliases(this.projectRoot);
        }
        return this.projectAliases;
      },

      getNearestAliases: (fromFile: string) => {
        let dir = path.posix.dirname(fromFile.replace(/\\/g, '/'));
        const walked: string[] = [];
        let found: AliasMap | null = null;
        while (dir && dir !== '.' && dir !== '/') {
          const hit = this.dirAliases.get(dir);
          if (hit !== undefined) {
            found = hit;
            break;
          }
          walked.push(dir);
          const abs = path.join(this.projectRoot, dir);
          if (['tsconfig.json', 'jsconfig.json'].some((name) => fs.existsSync(path.join(abs, name)))) {
            const aliases = loadProjectAliases(abs);
            if (aliases) {
              found = aliases;
              break;
            }
          }
          dir = path.posix.dirname(dir);
        }
        for (const d of walked) this.dirAliases.set(d, found);
        return found;
      },

      getGoPackageDir: (importPath: string, fromFile?: string) => {
        const own = fromFile === undefined ? null : this.nearestGoModule(goDirOf(fromFile));
        const key = `${importPath}\0${own?.rootDir ?? ''}`;
        const hit = this.goPackageDirs.get(key);
        if (hit !== undefined) return hit;
        const mod = findGoModuleForImport(importPath, this.getGoModules(), own);
        const dir = mod ? goModulePackageDir(importPath, mod, this.projectRoot) : null;
        this.goPackageDirs.set(key, dir);
        return dir;
      },

      getWorkspacePackages: () => {
        if (this.workspacePackages === undefined) {
          this.workspacePackages = loadWorkspacePackages(this.projectRoot);
        }
        return this.workspacePackages;
      },

      getReExports: (filePath: string, language) => {
        const cached = this.reExportCache.get(filePath);
        if (cached) return cached;
        const content = this.context.readFile(filePath);
        if (!content) {
          this.reExportCache.set(filePath, []);
          return [];
        }
        // What matters is the BARREL file's own language — not the consuming
        // reference's. A `.svelte`/`.vue` consumer threads its own language
        // down the re-export chase, which would make extractReExports() bail
        // on a `.ts` index barrel and silently break the chain (#629). Re-key
        // the parse on the barrel's extension so the chase works no matter
        // what kind of file imports through it. Python re-exports through its
        // imports (a package `__init__.py`), so a `.py` barrel parses as Python.
        const isJsFamily = /\.(?:d\.ts|[cm]?tsx?|[cm]?jsx?|ets)$/i.test(filePath);
        const barrelLanguage = isJsFamily ? 'typescript' : /\.py$/i.test(filePath) ? 'python' : language;
        const reExports = extractReExports(content, barrelLanguage);
        this.reExportCache.set(filePath, reExports);
        return reExports;
      },

      getCppIncludeDirs: () => {
        return loadCppIncludeDirs(this.projectRoot);
      },

      getCppIncludeNodes: () => this.queries.getCppIncludeNodes(),
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
    this.advanceSupertypeGeneration();

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
      rowId: ref.rowId,
    }));

    const total = refs.length;
    let lastReportedPercent = -1;

    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]!; // Array index is guaranteed to be in bounds
      const result = this.resolveOneTimed(ref);

      if (result) {
        resolved.push(result);
        byMethod[result.resolvedBy] = (byMethod[result.resolvedBy] || 0) + 1;
      } else {
        unresolved.push(this.parkable(ref));
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

  /** Lowercased `knownNames`, built the first time a case-insensitive language asks. */
  private knownLowerNames: Set<string> | null = null;

  /** `hasAnyPossibleMatch` for a language whose names ignore case: the name, or any `.`/`::`/`->` part of it. */
  private hasAnyPossibleMatchIgnoringCase(name: string): boolean {
    if (!this.knownNames) return true;
    if (!this.knownLowerNames || this.knownLowerNames.size === 0) {
      this.knownLowerNames = new Set();
      for (const known of this.knownNames) this.knownLowerNames.add(known.toLowerCase());
    }
    const lower = name.toLowerCase();
    if (this.knownLowerNames.has(lower)) return true;
    return lower.split(/::|->|\./).some((part) => part.length > 0 && this.knownLowerNames!.has(part));
  }

  /**
   * Check if a reference name has any possible match in the codebase.
   * Uses the pre-built knownNames set to skip expensive resolution
   * for names that definitely don't exist as symbols.
   */
  private hasAnyPossibleMatch(name: string): boolean {
    if (!this.knownNames) return true; // no pre-filter available
    // In the view outside the class expressions, names only their classes
    // and members carry name nothing (classExpressionFreeContextFor).
    const only = this.classExpressionFreeBases.has(this.context) ? this.classExpressionOnlyNames() : null;
    const known = (n: string): boolean => this.knownNames!.has(n) && !(only?.has(n) ?? false);

    // Direct name match
    if (known(name)) return true;

    // For qualified names like "obj.method" or "Class::method", check the parts
    const dotIdx = name.indexOf('.');
    if (dotIdx > 0) {
      const receiver = name.substring(0, dotIdx);
      const member = name.substring(dotIdx + 1);
      if (known(receiver) || known(member)) return true;
      // Also check capitalized receiver (instance-method resolution)
      const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
      if (known(capitalized)) return true;
      // JVM FQN: `com.example.foo.Bar` — the only useful segment is the
      // last one (`Bar`); the earlier check finds `example.foo.Bar` which
      // never matches a node name.
      const lastDot = name.lastIndexOf('.');
      if (lastDot > dotIdx) {
        const tail = name.substring(lastDot + 1);
        if (tail && known(tail)) return true;
      }
    }
    const colonIdx = name.indexOf('::');
    if (colonIdx > 0) {
      const receiver = name.substring(0, colonIdx);
      const member = name.substring(colonIdx + 2);
      if (known(receiver) || known(member)) return true;
      // Multi-segment path `a::b::c` (a Rust/C++ module call like
      // `database::profiles::find`) — the only segment that names a symbol is
      // the last (`c`); `member` above is `b::c`, which never matches a node
      // name, so without this the pre-filter drops the ref before the Rust path
      // resolver ever sees it. Mirror the dotted-name leaf check above.
      const lastColon = name.lastIndexOf('::');
      if (lastColon > colonIdx) {
        const tail = name.substring(lastColon + 2);
        if (tail && known(tail)) return true;
      }
    }

    // Lua/Luau method calls use a single `:` (`lg:log`); R uses `$` (`lg$log`).
    // Check the member (and receiver) around these separators too, so the ref
    // isn't dropped here before the method-call resolver ever sees it. The `:`
    // case is skipped when the name actually contains `::` (handled above).
    for (const sep of [':', '$']) {
      if (sep === ':' && name.includes('::')) continue;
      const sepIdx = name.indexOf(sep);
      if (sepIdx > 0) {
        const receiver = name.substring(0, sepIdx);
        const member = name.substring(sepIdx + 1);
        if (known(member) || known(receiver)) return true;
        const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
        if (known(capitalized)) return true;
      }
    }

    // For path-like references (e.g., "snippets/drawer-menu.liquid"), check the filename
    const slashIdx = name.lastIndexOf('/');
    if (slashIdx > 0) {
      const fileName = name.substring(slashIdx + 1);
      if (known(fileName)) return true;
    }

    return false;
  }

  /**
   * Does `ref.referenceName` match an import declared in its containing
   * file? Used as a pre-filter escape so re-export chain resolution
   * still gets a chance when the name has no project-wide declaration.
   */
  private matchesAnyImport(ref: UnresolvedRef): boolean {
    const imports = this.context.getImportMappings(ref.filePath, ref.language);
    if (imports.length === 0) return false;
    for (const imp of imports) {
      if (
        imp.localName === ref.referenceName ||
        ref.referenceName.startsWith(imp.localName + '.')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolve a single reference.
   *
   * Thin decorator over `resolveOneInner` so every strategy — framework,
   * import, name-match, chain, CFML component path — passes through the
   * inheritance target-kind gate at ONE seam. Filtering inside the
   * name-matcher would have covered `matchByExactName` only.
   * Calls that land on an alias binding then forward once to the callable
   * the alias names (see ./alias-binding), regardless of the strategy.
   */
  /**
   * The failed python attribute-chain refs that an edit to `touched` makes
   * resolvable now — what a sync retries after a factory or a base class
   * changed in another file (`pythonAttrRefResolves` answers each one).
   *
   * The candidates are the refs in the files that import a touched file
   * within a few hops, counted once per (calling symbol, name). When there
   * are more than `ceiling` of them — an edit to a module most of the project
   * imports — only those the edit can plausibly reach are kept: an attribute
   * a touched file assigns, a call receiver it defines, a class that
   * subclasses one of its classes, or an attribute assigned from a call to
   * something it defines. Null when even that is over the ceiling; those refs
   * wait for a full index.
   *
   * Past the ceiling, then, these become resolvable only at the next full
   * index: a factory two hops from the edit, a subclass two hops away, and an
   * attribute typed by an annotation — a parameter `c: Client`, or a
   * class-level `c: Client` in a class that only gains the base or import that
   * resolves `Client` in the touched file.
   */
  pythonAttrRetryCandidates(touched: string[], ceiling: number = 2000): UnresolvedReference[] | null {
    const touchedSet = new Set(touched);
    const closure = this.queries.getPythonImporterClosure(touched).filter((f) => !touchedSet.has(f));
    // One answer per (calling symbol, name): the same call written twice in
    // one function resolves the same way, so it is asked — and counted — once.
    const keyOf = (ref: { fromNodeId: string; referenceName: string }) => `${ref.fromNodeId}\0${ref.referenceName}`;
    const resolvable = (refs: UnresolvedReference[]) => {
      const answers = new Map<string, boolean>();
      return refs.filter((ref) => {
        if (!ref.filePath || !ref.language) return false;
        const key = keyOf(ref);
        let ok = answers.get(key);
        if (ok === undefined) answers.set(key, (ok = pythonAttrRefResolves(ref as UnresolvedRef, this.context)));
        return ok;
      });
    };
    const candidates = this.queries.getFailedPythonAttrRefKeys(closure);
    const load = (keys: typeof candidates) => this.queries.getUnresolvedReferencesByIds(keys.map((k) => k.id));
    if (new Set(candidates.map(keyOf)).size <= ceiling) return resolvable(load(candidates));

    const assigned = new Set<string>();
    const defined = new Set<string>();
    const subclassing = new Set<string>();
    const calling = new Set<string>();
    for (const file of touched) {
      const source = this.context.readFile(file);
      if (source) {
        const text = stripCommentsForRegex(source, 'python');
        for (const m of text.matchAll(/\b(?:self|cls)\.(\w+)\s*(?::[^=\n]*)?=(?!=)|^[ \t]+(\w+)\s*(?::[^=\n]*)?=(?!=)/gm)) {
          assigned.add((m[1] ?? m[2])!);
        }
      }
      for (const n of this.context.getNodesInFile(file)) {
        if (n.kind === 'class' || n.kind === 'function' || n.kind === 'method') defined.add(n.name);
      }
      for (const f of this.queries.getPythonFilesWithEdgesInto(file, ['extends'], ['class'])) subclassing.add(f);
      for (const f of this.queries.getPythonFilesWithEdgesInto(file, ['calls', 'instantiates'], ['function', 'method', 'class'])) {
        calling.add(f);
      }
    }

    const callees = new Map<string, Map<string, Set<string>>>(); // file → attr → callee names
    const assignedCallees = (file: string, attr: string): Set<string> => {
      let byAttr = callees.get(file);
      if (!byAttr) {
        byAttr = new Map();
        const source = this.context.readFile(file);
        const text = source ? stripCommentsForRegex(source, 'python') : '';
        for (const m of text.matchAll(/\b(\w+)\s*(?::[^=\n]*)?=(?!=)\s*(?:await\s+)?(?:[\w.]*\.)?(\w+)\s*\(/g)) {
          let set = byAttr.get(m[1]!);
          if (!set) byAttr.set(m[1]!, (set = new Set()));
          set.add(m[2]!);
        }
        callees.set(file, byAttr);
      }
      return byAttr.get(attr) ?? new Set();
    };

    const kept = candidates.filter((ref) => {
      const name = ref.referenceName;
      if (name.includes('().')) return defined.has(name.split('().')[0]!.split('.').pop()!);
      const segs = name.split('.');
      if (segs.length !== 3 || !segs.every((seg) => /^[A-Za-z_]\w*$/.test(seg))) return false;
      const attr = segs[1]!;
      if (assigned.has(attr)) return true;
      if (subclassing.has(ref.filePath) && (segs[0] === 'self' || segs[0] === 'cls')) return true;
      return calling.has(ref.filePath) && [...assignedCallees(ref.filePath, attr)].some((c) => defined.has(c));
    });
    return new Set(kept.map(keyOf)).size <= ceiling ? resolvable(load(kept)) : null;
  }

  resolveOne(ref: UnresolvedRef): ResolvedRef | null {
    // Production code is resolved as if the project's manual mocks were not
    // indexed (see mocklessContextFor), and code outside the named class
    // expressions as if their classes were not (classExpressionFreeContextFor);
    // every strategy below reads the graph through this.context, so it
    // answers for that view.
    const outer = this.context;
    const unviewed = this.classExpressionFreeBases.get(outer) ?? outer;
    const base = unviewed === this.mocklessContext && this.mocklessBase ? this.mocklessBase : unviewed;
    const mockless = this.mocklessContextFor(ref, base) ?? base;
    return this.resolveOneWith(this.classExpressionFreeContextFor(ref, mockless) ?? mockless, ref);
  }

  /** resolveOneIn with every strategy reading the graph through `context`. */
  private resolveOneWith(context: ResolutionContext, ref: UnresolvedRef): ResolvedRef | null {
    const outer = this.context;
    if (context === outer) return this.resolveOneIn(ref);
    this.context = context;
    try {
      return this.resolveOneIn(ref);
    } finally {
      this.context = outer;
    }
  }

  private resolveOneIn(ref: UnresolvedRef): ResolvedRef | null {
    // A Rust call kept with its receiver chain — `self.services.store.put`,
    // `self.store().put` (#2836) — resolves as the call by its method's name
    // did before the extractor kept the chain: every strategy and gate reads
    // that name the same way, and the receiver's type is read through the
    // whole chain where the call is written (matchRustWrittenReceiverCall).
    // The edge keeps the call as written.
    const byName = rustChainedCallByName(ref);
    if (byName) {
      const resolved = this.resolveOneIn(byName);
      return resolved && { ...resolved, original: ref };
    }
    // A C/C++ "call" whose name is a function-like macro visible in this
    // translation unit is a macro expansion, not a call — it must never bind
    // to a same-named function in another file (#1838).
    if (isVisibleCppMacro(ref, this.context)) return null;
    // A Swift type reference never lands on an `extension X {}` node, nor on a
    // nested type it cannot name bare (see ./swift-type-visibility).
    // A name a declaration around the reference declares as a type parameter
    // (`def f[A]`, `class Foo<T>`) is that parameter (see ./type-parameters),
    // and a Dart call to a parameter or local calls that (./dart-local-scope).
    const candidate = gateDartLocal(
      gateTypeParameter(
        gateSwiftTypeTarget(this.gateTargetKind(this.resolveOneInner(ref), ref), ref, this.context),
        ref,
        this.context,
      ),
      ref,
      this.context,
    );
    const scoped = this.gateRustScope(candidate, ref);
    // A Go name its package defines once per build target is the definition
    // the reference's file builds with (see preferGoBuildTwin).
    const resolved = preferGoBuildTwin(this.gateSuperSelfCall(
      scoped?.resolvedBy === 'framework' ? this.gateFrameworkLanguage(scoped, ref) : this.gateLanguage(scoped, ref),
      ref,
    ), ref, this.context);
    // A Dart class whose field holds its own type (`class Node { Node? next; }`)
    // names itself: a self-edge that says nothing (#2327).
    if (resolved && ref.language === 'dart' && ref.referenceKind === 'references' &&
        resolved.targetNodeId === ref.fromNodeId) return null;
    if (resolved && isPythonFromImportModule(ref, this.context)) {
      const module = this.nodeById(resolved.targetNodeId);
      if (module && module.kind !== 'file' && module.kind !== 'module') return null;
    }
    if (resolved && (resolved.byName || resolved.resolvedBy === 'exact-match' || resolved.resolvedBy === 'fuzzy') &&
        isGuessedRecordAccessor(resolved, ref, this.context)) return null;
    // A name the calling JS/TS function binds itself (a parameter, a local) in
    // scope at the reference is that binding even when the file imports the
    // name, which the import resolver answers before the matcher's own check.
    if (resolved && resolved.resolvedBy === 'import' && isImportShadowedByJsBinding(resolved, ref, this.context)) return null;
    // A declaration of a declaration file's `declare module 'x'` is reached
    // through an import of `x`, never by its bare name from a file that
    // reaches no `x` (see reachesAmbientModule).
    if (resolved && resolved.resolvedBy !== 'import') {
      const specifier = ambientModuleDeclarations(this.context).get(resolved.targetNodeId);
      const declaringFile = specifier === undefined ? undefined : this.nodeById(resolved.targetNodeId)?.filePath;
      if (declaringFile !== undefined && declaringFile !== ref.filePath &&
          !reachesAmbientModule(ref, specifier!, declaringFile, this.context)) return null;
    }
    if (!resolved || ref.referenceKind !== 'calls') return resolved;
    // A Pascal call to data runs only a routine the data holds, in scope, and
    // one to a routine nested in another comes only from inside that one (see
    // gatePascalCall).
    const call = ref.language === 'pascal' ? gatePascalCall(resolved, ref, this.context) : resolved;
    if (!call) return null;

    const target = this.nodeById(call.targetNodeId);
    if (!target) return call;

    const dot = ref.referenceName.lastIndexOf('.');
    const memberName = dot >= 0 ? ref.referenceName.slice(dot + 1) : null;
    const forwarded = resolveAliasBinding(target, memberName, this.context);
    if (!forwarded || forwarded.id === call.targetNodeId) return call;

    return this.gateLanguage({
      ...call,
      targetNodeId: forwarded.id,
      confidence: Math.min(call.confidence, 0.85),
    }, ref);
  }

  private resolveOneInner(ref: UnresolvedRef): ResolvedRef | null {
    // A local C++ object construction (`T obj(args)`, ref `ns::T::T/1`)
    // resolves ONLY to a constructor of the lexically nearest `T` (#1839).
    if (isCppConstructorRef(ref)) return matchCppConstructor(ref, this.context);
    // A C or C++ base class is the one C++ name lookup finds from where the
    // class is declared — never a namesake of another namespace or language,
    // which a framework's heuristics or name matching would take (see
    // ./cpp-supertypes).
    if (isCppSupertypeRef(ref)) return matchCppSupertype(ref, this.context);

    // A Pascal name written without parentheses (#2514) links only to a
    // routine its scope reaches, or through a receiver to a method of the
    // receiver's declared type; data of that name links nothing.
    if (isPascalParenlessRef(ref)) return matchPascalParenlessRef(ref, this.context);
    // So does a Pascal call to a name the compiler or the System unit gives
    // meaning to (`SizeOf`, `TypeInfo`, `length(S)`, `Pointer(P)`), whatever
    // its case: only a declaration in the call's scope shadows it.
    if (isPascalSystemCall(ref, this.context)) return matchPascalSystemCall(ref, this.context);
    // A bare Pascal call to a routine nested where it is made (`Inner(1)` in
    // the routine that declares `procedure Inner(N: Integer);`) is that one,
    // and one made in a nested routine is what its scope declares first.
    const nested = matchPascalNestedCall(ref, this.context);
    if (nested) return nested;
    // A Dart member read (`x.area`) links the getter the receiver's type
    // reaches, as a call, or nothing — never a guess by name (#2338).
    if (isDartMemberRead(ref)) return matchDartMemberRead(ref, this.context);
    // So does a later link of a Dart call chain (`X.autoDispose.family(…)`,
    // `events.map(f).transform(…)`), which arrives by its bare name: a member
    // of what the chain's head and links are declared to be, or nothing (#750).
    if (isDartChainLink(ref, this.context)) return matchDartChainLink(ref, this.context);
    // A Dart annotation (`@riverpod`, `@Riverpod(…)`) is a constant or a
    // constructor call, as written — never a method or function by its name.
    if (isDartAnnotation(ref)) return matchDartAnnotation(ref, this.context);
    // A Go call through a type assertion (`srv.(KVServer).Range(ctx, in)`),
    // which arrives by its bare name, is to a method of the asserted type, or
    // to nothing the project declares.
    const asserted = matchGoAssertedCall(ref, this.context);
    if (asserted !== undefined) return asserted;
    // So is one on an indexed element (`schemas[ix].ValidateBytes(data)`,
    // deepcopy's `(*in)[i].DeepCopyInto(…)`): to a method of the element type.
    const indexed = matchGoIndexedCall(ref, this.context);
    if (indexed !== undefined) return indexed;
    // And one on any other receiver the extractor keeps no name for: a
    // fluent chain's later link, a call's result, a composite literal
    // (`model.WithContext(0).Where(1)`, `GitOracle{}.Worktree()`, #2543).
    const chained = matchGoChainedCall(ref, this.context);
    if (chained !== undefined) return chained;

    // A section or snippet a Shopify theme's file names is that theme's own,
    // or nothing: Shopify never looks in another theme (see ./shopify-themes).
    const themeFile = matchShopifyThemeFile(ref, this.context);
    if (themeFile !== undefined) return themeFile;

    // A TS/JS `super.run(…)` runs the method of the class's parent or a
    // nearer ancestor, or one outside the project: never a method found by
    // its name alone (see ./js-super-calls).
    const superCall = matchJsSuperCall(ref, this.context);
    if (superCall !== undefined) return superCall;

    // Skip built-in/external references — except a python call of a
    // builtin-named method through a local or a parameter its def types as a
    // project class (`reg = Registry(); reg.get(k)`, #2583): that reading,
    // by evidence only, is the one way back, and nothing guesses past it.
    if (this.isBuiltInOrExternal(ref)) {
      return this.isPythonBuiltinNamedMethodCall(ref)
        ? this.gateLanguage(matchPythonTypedLocalCall(ref, this.context), ref)
        : null;
    }

    // CFML component paths in inheritance (#1152): `extends="coldbox.system.web.
    // Controller"` names the supertype by its dot-separated path (or `extends=
    // "../base"` by relative file path) — the graph indexes the class under its
    // final segment only, so these die at the fast pre-filter below and never
    // resolved. Handled by a dedicated path-corroborated matcher, gated to
    // inheritance refs only (a dotted `calls` ref is a member-access chain, not
    // a component path). No fallthrough on miss: the full path string can only
    // ever mis-match downstream, and an unresolvable supertype usually lives in
    // an out-of-repo library (mxunit, testbox) — silent beats wrong.
    if (
      (ref.language === 'cfml' || ref.language === 'cfscript') &&
      (ref.referenceKind === 'extends' || ref.referenceKind === 'implements') &&
      (ref.referenceName.includes('.') || ref.referenceName.includes('/'))
    ) {
      return this.resolveCfmlComponentPath(ref);
    }
    // The component a CFML `createObject("component", "a.b.Batch")` makes,
    // named by its component path as `extends` names one (#2652), and a call
    // chained onto a construction — `createObject(…).init()`, `new
    // a.b.Batch().init()`, encoded `a.b.Batch().init` — which is a method of
    // that component or of nothing: no name match may guess past it.
    if (ref.language === 'cfml' || ref.language === 'cfscript') {
      if (ref.referenceKind === 'instantiates' && ref.referenceName.includes('.')) return this.resolveCfmlComponentPath(ref);
      if (ref.referenceKind === 'calls' && CFML_CONSTRUCTED_CALL.test(ref.referenceName)) return this.resolveCfmlConstructedCall(ref);
    }

    // A CFML include names a template by its path from the including file's
    // directory, or from the web root (#2651): `<cfinclude template="../shared/
    // helpers.cfm">` is that file, not whichever `helpers.cfm` file-name
    // matching would settle on. A path that names no file here (one through a
    // server mapping, `/contenscms/…`) is matched by its file name, as before,
    // but only to a file: the symbol strategies below took a path no file
    // matched for another template's import statement of the same path. Nor
    // is it the including file, which a file-name match can land on (Wheels'
    // `views/wheels/wheels.cfm` including `../../wheels/public/wheels.cfm`).
    if ((ref.language === 'cfml' || ref.language === 'cfscript') && ref.referenceKind === 'imports' && isCfmlTemplatePath(ref.referenceName)) {
      const included = this.resolveCfmlIncludePath(ref) ?? matchByFilePath(ref, this.context);
      if (included && this.nodeById(included.targetNodeId)?.filePath === ref.filePath) return null;
      return this.gateLanguage(included, ref);
    }

    // A PHP class written with a namespace in it — `new Alias\X()` through a
    // `use Ns as Alias;` namespace alias, `extends Sub\Base`, `\Ns\X::make()`
    // (#2256). The pre-filter below would drop most of these before any import
    // strategy ran, and PHP gives each one exactly one meaning; resolve it first.
    const phpQualified = resolvePhpQualifiedClassRef(ref, this.context);
    if (phpQualified !== undefined) return this.gateLanguage(phpQualified, ref);

    // A Ruby constant written with its namespace (`Billing::ChargeCard`,
    // `::Foo`) and a call on one (`Billing::ChargeCard.call`) are what Ruby's
    // constant lookup finds from where they are written, or nothing the
    // project declares (see ./ruby-constant-paths). The pre-filter below
    // drops a `::`-rooted name, and the strategies past it would take a
    // namesake by its last name.
    const rubyPath = matchRubyConstantPathRef(ref, this.context);
    if (rubyPath !== undefined) return this.gateLanguage(rubyPath, ref);

    // Fast pre-filter: skip if no symbol with this name exists anywhere
    // AND the name doesn't match a local import. The import escape is
    // necessary because re-export rename chains (`import { login }
    // from './barrel'` where the barrel has `export { signIn as login }
    // from './auth'`) intentionally call a name that has no
    // declaration anywhere — only the renamed upstream symbol does.
    // ArkTS chained-attribute refs carry a leading dot (`.titleStyle`) that
    // routes them to the decorator-gated matcher; the symbol itself is
    // indexed under the bare name, so the existence check strips the dot.
    // Nix static path imports (`import ./x.nix`) and JS/TS module paths
    // (`require('./x')`) name a FILE, not a symbol — they bypass the
    // symbol-existence check and resolve via resolveViaImport.
    let existenceName =
      ref.language === 'arkts' && ref.referenceName.startsWith('.')
        ? ref.referenceName.slice(1)
        : ref.referenceName;
    // Erlang refs carry the call-site arity (`f/1`, `mod::f/2` — #1610); the
    // name index stores bare names, so existence is checked arity-less.
    if (ref.language === 'erlang') existenceName = existenceName.replace(/\/\d{1,3}$/, '');
    // A C or C++ name written from the global scope (`::_pbi::PrivateAccess::
    // GenerateParseTable`, `::memset`) exists when the name under the `::` does.
    if ((ref.language === 'cpp' || ref.language === 'c') && existenceName.startsWith('::')) {
      existenceName = existenceName.slice(2);
    }
    const tPre = this.profileStages ? process.hrtime.bigint() : 0n;
    const preFilterPass =
      isNixPathImportRef(ref) ||
      isJsPathImportRef(ref) ||
      this.hasAnyPossibleMatch(existenceName) ||
      // PHP, Pascal, CFML, COBOL and VB.NET names ignore case: `formatprice()`
      // calls `FormatPrice`, which the exact-name set never lists.
      (CASE_INSENSITIVE_LANGUAGES.has(ref.language) && this.hasAnyPossibleMatchIgnoringCase(existenceName)) ||
      this.matchesAnyImport(ref) ||
      this.frameworksFor(ref.language).some((f) => f.claimsReference?.(ref.referenceName));
    if (this.profileStages) this.stageAdd('preFilter', ref, preFilterPass, tPre);
    if (!preFilterPass) {
      return this.gateLanguage(matchJsStoreBindingCall(ref, this.context), ref);
    }

    // A VB.NET member read (`AppSession.SessionId`, #2305; `x.Normal`,
    // `Me._h.Title`) means what VB.NET's scoping says its receiver is — a
    // project type, whose member and the type itself it links, or a value,
    // whose declared type's member it links — and no framework, import or
    // name strategy guesses past that. Nor past a `With` block's call through
    // a receiver path (`.Run()` in `With Me._h`).
    if (isVbMemberRead(ref)) return this.gateLanguage(matchVbMemberRead(ref, this.context), ref);
    if (isVbPathCall(ref)) {
      return this.gateLanguage(matchVbPathCall(ref, this.context, (name) => isStdMethodName('vbnet', name)), ref);
    }

    // The last name of a TypeScript type written qualified (`React.ReactNode`,
    // `TChat.ChatMessage`) is a member of what its qualifier names, which no
    // framework, import or name strategy may guess past by the name alone.
    const tsQualified = resolveTsQualifiedTypeRef(ref, this.context);
    if (tsQualified !== undefined) return this.gateLanguage(tsQualified, ref);

    // Function-as-value refs (#756) get a dedicated, strictly-gated path:
    // import-based resolution first (an imported callback resolves through its
    // import, the most precise cross-file signal), then matchFunctionRef
    // (same-file first, unique-only cross-file, function/method targets only).
    // They never reach the framework or fuzzy strategies below.
    if (ref.referenceKind === 'function_ref') {
      // `this.<member>` values (TS/JS) resolve ONLY against the enclosing
      // class's own members — never a same-named symbol elsewhere.
      if (ref.referenceName.startsWith('this.')) {
        return this.gateLanguage(this.resolveThisMemberFnRef(ref), ref);
      }
      if ((ref.language === 'python' || ref.language === 'go') && ref.referenceName.includes('.')) {
        return this.gateLanguage(matchFunctionRef(ref, this.context), ref);
      }
      const viaImport = this.gateLanguage(resolveViaImport(ref, this.context), ref);
      if (viaImport) {
        const target = this.nodeById(viaImport.targetNodeId);
        if (
          target &&
          (target.kind === 'function' ||
            target.kind === 'method' ||
            // Python (#1478): an imported class used as a value (`return
            // OrgSerializerFull`) resolves through its import like any
            // callback — mirrors matchFunctionRef's bareClassOk.
            (ref.language === 'python' && target.kind === 'class'))
        ) {
          return viaImport;
        }
      }
      return this.gateLanguage(matchFunctionRef(ref, this.context), ref);
    }

    // JVM FQN imports skip framework/name-matcher: `import com.example.Bar`
    // resolves directly through the qualifiedName index, which is unambiguous
    // even when several `Bar` classes exist in different packages.
    const tJvm = this.profileStages ? process.hrtime.bigint() : 0n;
    const jvmImport = resolveJvmImport(ref, this.context);
    if (this.profileStages) this.stageAdd('jvmImport', ref, !!jvmImport, tJvm);
    if (jvmImport) return jvmImport;

    // Razor/Blazor: a markup or `@code` type ref resolves through the file's
    // `@using` namespaces (incl. folder `_Imports.razor`). This precisely
    // disambiguates a simple name that exists in several namespaces — e.g.
    // `CatalogBrand` resolving to `BlazorShared.Models::CatalogBrand` (the DTO,
    // which the `.razor` `@using`s) rather than the same-named domain entity.
    if (ref.language === 'razor') {
      const razorResult = this.resolveRazorUsing(ref);
      if (razorResult) return razorResult;
    }

    // An explicit PHP class import owns its static calls, including an
    // unavailable method. Do not let same-name fallbacks change the receiver
    // to an unrelated Service/Repository type (#1545).
    const phpStaticImport = resolvePhpImportedStaticCall(ref, this.context);
    if (phpStaticImport !== undefined) return this.gateLanguage(phpStaticImport, ref);

    const candidates: ResolvedRef[] = [];

    // Strategy 1: Try framework-specific resolution, by the frameworks that
    // read this reference's language: Express's `logger` middleware rule took
    // a Go method's `*zap.Logger` result for the method itself (etcd).
    // Cross-language bridges are deliberately preserved (Drupal `routing.yml`
    // → PHP controller, RN JS → native `calls`); each lists the language its
    // references are written in. Other code references obey the shared
    // family gate.
    const tFw = this.profileStages ? process.hrtime.bigint() : 0n;
    let fwEarly: ResolvedRef | null = null;
    for (const framework of this.frameworksFor(ref.language)) {
      const resolved = this.gateFrameworkLanguage(framework.resolve(ref, this.context), ref);
      // Name the resolver on the edge (`metadata.framework`): a Swift→ObjC or
      // React Native bridge hop says how it got into the graph, as a
      // synthesized edge's `synthesizedBy` does.
      const result = resolved ? { ...resolved, metadata: { ...resolved.metadata, framework: framework.name } } : null;
      if (result) {
        if (result.confidence >= 0.9) {
          fwEarly = result; // High confidence, return immediately (below)
          break;
        }
        candidates.push(result);
      }
    }
    if (this.profileStages) this.stageAdd('frameworks', ref, fwEarly !== null, tFw);
    if (fwEarly) return fwEarly;
    // A reference a framework answers alone ends with the frameworks' answer
    // (see FrameworkResolver.ownsReference): Nuxt's `navigateTo(x)` with a
    // destination no route serves is no namesake's call.
    if (this.frameworksFor(ref.language).some((f) => f.ownsReference?.(ref, this.context))) {
      return candidates.length > 0
        ? candidates.reduce((best, curr) => (curr.confidence > best.confidence ? curr : best))
        : null;
    }
    // A retained untyped chain supplies effect/call-site evidence only. In
    // particular, importing its root does not make the root its call target.
    // A path through module namespaces is not untyped: `z.coerce.number()`
    // after `import * as z`, where the barrel has `export * as coerce`.
    if (isUnresolvedJsMemberCall(ref)) {
      const root = ref.referenceName.slice(0, ref.referenceName.indexOf('.'));
      const namespace = this.context.getImportMappings(ref.filePath, ref.language).some((m) => m.isNamespace && m.localName === root);
      // `App.utils.fmt()` through a path an object literal was hung on (#2300).
      if (!namespace) return this.gateLanguage(matchObjectPathCall(ref, this.context), ref);
      const viaNamespace = this.gateLanguage(resolveViaImport(ref, this.context), ref);
      const target = viaNamespace ? this.nodeById(viaNamespace.targetNodeId) : null;
      return target && (target.kind === 'function' || target.kind === 'method' || target.kind === 'class' || target.kind === 'constant' || target.kind === 'variable')
        ? viaNamespace : null;
    }

    // Strategy 2: Try import-based resolution
    // A TS/JS/Python call-receiver chain (`useStore.getState().reset`, #1683)
    // names the ROOT's import, not the method's: letting resolveViaImport see
    // it binds the call to the imported store constant and the method is
    // never looked up. The name-matcher owns the chain shape for these
    // languages — the Java/Kotlin/C++ chains keep their existing path.
    if (
      ref.referenceKind === 'calls' &&
      CHAIN_SHAPE.test(ref.referenceName) &&
      (ref.language === 'typescript' || ref.language === 'javascript' || ref.language === 'tsx' || ref.language === 'jsx' || ref.language === 'python')
    ) {
      const chainResult = this.gateLanguage(matchReference(ref, this.context), ref);
      // `new Sub().inherited()`: the method may live on a supertype of a
      // project class, resolvable once extends edges exist — defer to the
      // conformance pass like the other chained calls.
      if (!chainResult && NEW_RECEIVER_SHAPE.test(ref.referenceName)) {
        const cls = newReceiverClass(ref, this.context);
        if (cls && this.context.getNodesByName(cls).some((n) => n.kind === 'class' && sameLanguageFamily(n.language, ref.language))) {
          this.deferReference(ref, this.deferredChainRefs);
        }
      }
      return chainResult;
    }

    const tImp = this.profileStages ? process.hrtime.bigint() : 0n;
    // `self.get_ip()` is a method call on the instance even when the file
    // also imports a function named `get_ip`: the import never names it.
    const selfCall = ref.language === 'python' && ref.referenceKind === 'calls' &&
      this.context.getImportMappings(ref.filePath, ref.language).some((m) => m.localName === ref.referenceName) &&
      isPythonSelfCall(ref, this.context);
    const importResult = selfCall ? null : this.gateLanguage(resolveViaImport(ref, this.context), ref);
    if (this.profileStages) this.stageAdd('viaImport', ref, !!importResult, tImp);
    if (importResult) {
      if (importResult.confidence >= 0.9) return importResult;
      candidates.push(importResult);
    }

    // PHP include/require paths resolve to files via import resolution only.
    // If that didn't find the file, do NOT fall back to the symbol
    // name-matcher — it would mis-connect e.g. "inc/db.php" to an unrelated
    // db.php elsewhere in the tree (a wrong edge is worse than none, #660).
    // Terraform refs are directory-scoped by language semantics — the
    // framework resolver IS the whole rulebook (`var.X` can never legally
    // bind outside its module directory), so the name-matcher's
    // qualified-name fallback would only ever add wrong cross-module edges.
    // Nix static path imports are file references for the same reason —
    // falling through would let "./x.nix" name-match an unrelated node. So
    // is a Dart import's URI: `package:flutter/foundation.dart` matched by
    // its last segment went to riverpod's own foundation.dart. And a Lua
    // `require`, whose leaf matched the local it is assigned to.
    if (isPhpIncludePathRef(ref) || isCobolCopybookRef(ref) || isNixPathImportRef(ref) || isDartImportRef(ref) || isLuaRequireRef(ref) || ref.language === 'terraform') {
      return candidates.length > 0
        ? candidates.reduce((best, curr) =>
            curr.confidence > best.confidence ? curr : best
          )
        : null;
    }

    // Strategy 3: Try name matching
    const tName = this.profileStages ? process.hrtime.bigint() : 0n;
    let nameResult = this.gateLanguage(matchReference(ref, this.context), ref);
    if (this.profileStages) this.stageAdd('nameMatch', ref, !!nameResult, tName);
    // Nix has no ambient cross-file namespace — a callee binds lexically
    // (same file) or through explicit import/callPackage wiring (the import
    // path above). A cross-file name match is wrong by construction: every
    // module `inherit (lib) mkOption`s the same nixpkgs helpers, so the
    // matcher would link each `mkOption` call to whichever file's inherit
    // binding it happened to pick. Same-file matches only.
    if (nameResult) {
      const target = this.nodeById(nameResult.targetNodeId);
      // A definition its language makes file-local — a C `static`, a Kotlin
      // `private fun`, a Go unexported name in another package, a Rust
      // non-`pub` item outside its module subtree — cannot be what a name in
      // another file means, whichever strategy chose it (#1730).
      if (target && !isVisibleAcrossFiles(target, ref, this.context)) {
        nameResult = null;
      } else if (ref.language === 'nix') {
        if (!target || target.filePath !== ref.filePath) {
          nameResult = null;
        }
      } else if (target && target.language === 'nix') {
        // The reverse direction is just as impossible: no other language can
        // symbolically call into a .nix binding (interop is eval/CLI, never a
        // linkable symbol) — without this, a Python script's `split()` lands
        // on some module's `split = ...` binding as a low-confidence match.
        nameResult = null;
      }
    }
    if (nameResult) {
      candidates.push(nameResult);
    }

    if (candidates.length === 0) {
      // Defer a chained static-factory/fluent call the first pass couldn't
      // resolve — its method may live on a supertype the receiver conforms to,
      // resolvable once implements/extends edges exist (the conformance pass).
      if (
        ref.referenceKind === 'calls' &&
        CHAIN_LANGUAGES.has(ref.language) &&
        CHAIN_SHAPE.test(ref.referenceName)
      ) {
        this.deferReference(ref, this.deferredChainRefs);
      } else if (
        // PHP `$this->prop->method()` (encoded `this->prop.method`): its method
        // may live on the property's declared supertype, resolvable only once
        // implements/extends edges exist — defer to the same conformance pass.
        ref.referenceKind === 'calls' &&
        ref.language === 'php' &&
        PHP_PROP_SHAPE.test(ref.referenceName)
      ) {
        this.deferReference(ref, this.deferredChainRefs);
      }
      return null;
    }

    // Return highest confidence candidate
    return candidates.reduce((best, curr) =>
      curr.confidence > best.confidence ? curr : best
    );
  }

  /**
   * Create edges from resolved references
   */
  createEdges(resolved: ResolvedRef[]): Edge[] {
    return resolved.flatMap((ref) => {
      // `function_ref` (#756) is internal-only: it persists as a `references`
      // edge (the registration site depends on the callback), distinguishable
      // by metadata.resolvedBy === 'function-ref'. callers/impact already
      // traverse `references`, so registration sites surface with no
      // graph-layer changes.
      let kind: Edge['kind'] =
        ref.edgeKind ??
        (ref.original.referenceKind === 'function_ref' ? 'references' : ref.original.referenceKind);

      // Promote "extends" to "implements" when a class/struct targets an interface
      if (kind === 'extends') {
        const targetNode = this.nodeById(ref.targetNodeId);
        if (targetNode && (targetNode.kind === 'interface' || targetNode.kind === 'protocol')) {
          const sourceNode = this.nodeById(ref.original.fromNodeId);
          if (sourceNode && sourceNode.kind !== 'interface' && sourceNode.kind !== 'protocol') {
            kind = 'implements';
          }
        }
      }

      // A Go call whose callee is a type is a conversion — `Category(s)`,
      // `(*Pair)(p)`, `model.Kind(3)` — which uses the type, and calls or
      // instantiates nothing (#2581).
      if (kind === 'calls' && ref.original.language === 'go') {
        const targetNode = this.nodeById(ref.targetNodeId);
        if (targetNode && GO_TYPE_KINDS.has(targetNode.kind)) kind = 'references';
      }

      // A Pascal call written with a bare name that resolves to a type is a
      // typecast: `TButton(Sender).Caption`, `PInt64Rec(P)^.Lo`, `F :=
      // TFoo(Obj)`. Delphi builds an object only through a constructor
      // (`TFoo.Create`), so the code refers to the type and creates nothing.
      if (
        kind === 'calls' &&
        ref.original.language === 'pascal' &&
        !ref.original.referenceName.includes('.') &&
        PASCAL_CAST_TARGET_KINDS.has(this.nodeById(ref.targetNodeId)?.kind ?? '')
      ) {
        kind = 'references';
      }

      // Promote "calls" to "instantiates" when the resolved target is a
      // class/struct/union. Languages without a `new` keyword (Python, Ruby)
      // express instantiation as `Foo()` — extraction can't tell that
      // apart from a function call without symbol info, but resolution
      // can: if `Foo` resolves to a class, the call IS an instantiation.
      if (kind === 'calls') {
        const targetNode = this.nodeById(ref.targetNodeId);
        if (
          targetNode &&
          (targetNode.kind === 'class' || targetNode.kind === 'struct' || targetNode.kind === 'union')
        ) {
          kind = 'instantiates';
        }
      }

      // One reference can name several targets — a navigation whose
      // destination is a conditional reaches every arm. Each becomes its own
      // edge, sharing this resolution's kind and confidence.
      const targets = [
        { targetNodeId: ref.targetNodeId, metadata: ref.metadata },
        ...(ref.alsoTargets ?? []),
      ];
      return targets.map((t) => ({
        source: ref.original.fromNodeId,
        target: t.targetNodeId,
        kind,
        line: ref.original.line,
        column: ref.original.column,
        metadata: {
          ...(t.metadata ?? {}),
          confidence: ref.confidence,
          resolvedBy: ref.resolvedBy,
          // The ORIGINAL reference text (and kind, when edge-kind promotion
          // rewrote it — calls→instantiates, extends→implements,
          // function_ref→references). If this edge's target is later removed
          // by a re-index, the edge is resurrected as exactly this ref and
          // re-resolved (#1240 removal case) — a faithful resurrection, so
          // re-resolution can never bind anywhere a full re-index wouldn't.
          // Reconstruction from the target node's name instead would strip
          // receiver/qualifier context (`h.greet` → `greet`) and risk a
          // wrong rebind; edges without refName (pre-#1240, synthesized) are
          // deliberately NOT resurrected for the same reason.
          refName: ref.original.referenceName,
          ...(ref.original.referenceKind !== kind ? { refKind: ref.original.referenceKind } : {}),
          // Uniform marker for function-as-value edges (#756), regardless of
          // which strategy resolved them (import vs matchFunctionRef) — lets
          // tooling label "callback registration" and lets validation diff
          // exactly the edges this feature added.
          ...(ref.original.referenceKind === 'function_ref' ? { fnRef: true } : {}),
        },
      }));
    });
  }

  /**
   * Split resolved refs into rows deletable by id and hand-built refs that
   * must fall back to the key-tuple delete. Rows loaded from the database
   * carry their row id and are deleted by exactly that id; the key tuple
   * omits line/col, so it also removes SIBLING rows — the same caller calling
   * the same callee at other lines — that a later batch hadn't attempted yet:
   * when a batch boundary split a caller's same-named call sites, the later
   * sites' edges were silently never created (#1269).
   */
  private static partitionResolvedCleanup(resolved: ResolvedRef[]): {
    rowIds: number[];
    legacyKeys: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }>;
  } {
    const rowIds: number[] = [];
    const legacyKeys: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }> = [];
    for (const r of resolved) {
      if (r.original.rowId != null) rowIds.push(r.original.rowId);
      else legacyKeys.push({
        fromNodeId: r.original.fromNodeId,
        referenceName: r.original.referenceName,
        referenceKind: r.original.referenceKind,
      });
    }
    return { rowIds, legacyKeys };
  }

  /**
   * Same row-id precision for parking unresolvable refs as status='failed'
   * (#1240): the key-tuple fallback would flip same-key sibling rows in later
   * batches to 'failed' before they were ever attempted, and resolution
   * outcome can differ per call site (receiver-type inference reads the
   * ref's line), so a sibling must not inherit this row's failure (#1269).
   */
  private static partitionFailedCleanup(unresolved: UnresolvedRef[]): {
    byRowId: Array<{ rowId: number; referenceName: string; referenceKind: string; nameTail?: string }>;
    legacyKeys: Array<{ fromNodeId: string; referenceName: string; referenceKind: string; nameTail?: string }>;
  } {
    const byRowId: Array<{ rowId: number; referenceName: string; referenceKind: string; nameTail?: string }> = [];
    const legacyKeys: Array<{ fromNodeId: string; referenceName: string; referenceKind: string; nameTail?: string }> = [];
    for (const r of unresolved) {
      if (r.rowId != null) byRowId.push({ rowId: r.rowId, referenceName: r.referenceName, referenceKind: r.referenceKind, nameTail: r.nameTail });
      else legacyKeys.push({
        fromNodeId: r.fromNodeId,
        referenceName: r.referenceName,
        referenceKind: r.referenceKind,
        nameTail: r.nameTail,
      });
    }
    return { byRowId, legacyKeys };
  }

  /**
   * `ref`, which no strategy resolved, with the tail it is parked under when
   * that is not the one its name gives: a reference through an import
   * binding the module doesn't declare by that name waits for the module
   * (see importBindingTail). Decided here, where the file's import mappings
   * are still cached from the attempt — in a resolver-pool worker too.
   */
  private parkable(ref: UnresolvedRef): UnresolvedRef {
    const tail = importBindingTail(ref, this.context);
    if (tail) ref.nameTail = tail;
    return ref;
  }

  /** A deferred attempt is unfinished work, not a final failure (#1577). */
  private nonDeferredFailures(unresolved: UnresolvedRef[]): UnresolvedRef[] {
    return unresolved.filter((ref) => ref.rowId == null || !this.deferredRowIds.has(ref.rowId));
  }

  private deferReference(ref: UnresolvedRef, queue: UnresolvedRef[]): void {
    queue.push(ref);
    if (ref.rowId != null) this.deferredRowIds.add(ref.rowId);
  }

  /**
   * Resolve and persist edges to database
   */
  resolveAndPersist(
    unresolvedRefs: UnresolvedReference[],
    onProgress?: (current: number, total: number) => void
  ): ResolutionResult {
    const prerequisites = unresolvedRefs.filter(ReferenceResolver.isPrerequisite);
    if (prerequisites.length > 0 && prerequisites.length < unresolvedRefs.length) {
      const first = this.resolveAndPersist(prerequisites, (current) => onProgress?.(current, unresolvedRefs.length));
      const rest = this.resolveAndPersist(
        unresolvedRefs.filter((ref) => !ReferenceResolver.isPrerequisite(ref)),
        (current) => onProgress?.(prerequisites.length + current, unresolvedRefs.length)
      );
      return ReferenceResolver.mergeResults(first, rest);
    }
    const result = this.resolveAll(unresolvedRefs, onProgress);

    // Create edges from resolved references
    const edges = this.createEdges(result.resolved);

    // Insert edges into database
    if (edges.length > 0) {
      this.queries.insertEdges(edges);
    }

    // Clean up resolved refs from unresolved_refs table so metrics are accurate
    if (result.resolved.length > 0) {
      const { rowIds, legacyKeys } = ReferenceResolver.partitionResolvedCleanup(result.resolved);
      this.queries.deleteReferencesByRowIds(rowIds);
      this.queries.deleteSpecificResolvedReferences(legacyKeys);
    }

    // Park unresolvable refs as status='failed' — parity with
    // resolveAndPersistBatched. Deleting them was wrong (#1240): a ref whose
    // own file never changes is otherwise gone forever, so when a DIFFERENT
    // file later gains the export/symbol that would satisfy it, no sync can
    // recreate the edge — only a full re-index. Failed rows are excluded from
    // the pending readers, which preserves the #1187 orphan sweep's
    // invariant in status form: after a COMPLETED pass nothing it processed
    // is still 'pending', so any pending row at rest belongs to an
    // interrupted run and the sweep can key off the pending count.
    if (result.unresolved.length > 0) {
      const { byRowId, legacyKeys } = ReferenceResolver.partitionFailedCleanup(this.nonDeferredFailures(result.unresolved));
      this.queries.markReferencesFailedByRowIds(byRowId);
      this.queries.markReferencesFailed(legacyKeys);
    }

    return result;
  }

  /**
   * Yielding counterpart of {@link resolveAndPersist} for a caller-supplied
   * ref list — used by sync's failed-ref retry pass (#1240). Same persistence
   * semantics: resolved refs become edges and their rows are deleted;
   * still-unresolvable refs are (re-)marked failed (a no-op for rows already
   * in that status). Yields per-ref because sync can run on the daemon's
   * liveness-watchdog thread (#850/#1091) and a retry set is unbounded when
   * a large edit lands many popular symbol names at once.
   */
  async resolveAndPersistListYielding(refs: UnresolvedReference[]): Promise<ResolutionResult> {
    const prerequisites = refs.filter(ReferenceResolver.isPrerequisite);
    if (prerequisites.length > 0 && prerequisites.length < refs.length) {
      const first = await this.resolveAndPersistListYielding(prerequisites);
      const rest = await this.resolveAndPersistListYielding(refs.filter((ref) => !ReferenceResolver.isPrerequisite(ref)));
      return ReferenceResolver.mergeResults(first, rest);
    }
    const maybeYield = createYielder();
    const result = await this.resolveBatchYielding(refs, maybeYield);
    await this.persistResolutionResult(result, maybeYield);
    return result;
  }

  private async persistResolutionResult(result: ResolutionResult, maybeYield: MaybeYield): Promise<number> {
    const PERSIST_CHUNK = 1000;
    const edges = this.createEdges(result.resolved);
    for (let i = 0; i < edges.length; i += PERSIST_CHUNK) {
      this.queries.insertEdges(edges.slice(i, i + PERSIST_CHUNK));
      await maybeYield();
    }

    const resolvedCleanup = ReferenceResolver.partitionResolvedCleanup(result.resolved);
    for (let i = 0; i < resolvedCleanup.rowIds.length; i += PERSIST_CHUNK) {
      this.queries.deleteReferencesByRowIds(resolvedCleanup.rowIds.slice(i, i + PERSIST_CHUNK));
      await maybeYield();
    }
    for (let i = 0; i < resolvedCleanup.legacyKeys.length; i += PERSIST_CHUNK) {
      this.queries.deleteSpecificResolvedReferences(resolvedCleanup.legacyKeys.slice(i, i + PERSIST_CHUNK));
      await maybeYield();
    }

    const failedCleanup = ReferenceResolver.partitionFailedCleanup(this.nonDeferredFailures(result.unresolved));
    for (let i = 0; i < failedCleanup.byRowId.length; i += PERSIST_CHUNK) {
      this.queries.markReferencesFailedByRowIds(failedCleanup.byRowId.slice(i, i + PERSIST_CHUNK));
      await maybeYield();
    }
    for (let i = 0; i < failedCleanup.legacyKeys.length; i += PERSIST_CHUNK) {
      this.queries.markReferencesFailed(failedCleanup.legacyKeys.slice(i, i + PERSIST_CHUNK));
      await maybeYield();
    }

    return edges.length;
  }

  /** Finalize the durable queue only AFTER its edges have been inserted. */
  private async persistDeferredReferences(deferred: UnresolvedRef[], resolved: ResolvedRef[]): Promise<number> {
    for (const ref of deferred) if (ref.rowId != null) this.deferredRowIds.delete(ref.rowId);
    const matched = new Set(resolved.map((ref) => ref.original));
    const unresolved = deferred.filter((ref) => !matched.has(ref));
    const count = await this.persistResolutionResult({
      resolved,
      unresolved,
      stats: { total: deferred.length, resolved: resolved.length, unresolved: unresolved.length, byMethod: {} },
    }, createYielder());
    if (count > 0) this.clearCaches();
    return count;
  }

  /** Same two phases as the bounded DB reader: persist wiring before calls. */
  private static isPrerequisite(ref: UnresolvedReference): boolean {
    return ref.referenceKind === 'imports' || ref.referenceKind === 'extends' || ref.referenceKind === 'implements';
  }

  private static mergeResults(first: ResolutionResult, rest: ResolutionResult): ResolutionResult {
    const byMethod = { ...first.stats.byMethod };
    for (const [method, count] of Object.entries(rest.stats.byMethod)) {
      byMethod[method] = (byMethod[method] ?? 0) + count;
    }
    return {
      resolved: first.resolved.concat(rest.resolved),
      unresolved: first.unresolved.concat(rest.unresolved),
      stats: {
        total: first.stats.total + rest.stats.total,
        resolved: first.stats.resolved + rest.stats.resolved,
        unresolved: first.stats.unresolved + rest.stats.unresolved,
        byMethod,
      },
    };
  }

  /**
   * Second resolution pass for chained static-factory / fluent calls whose
   * chained method is defined on a SUPERTYPE the receiver's type conforms to —
   * a protocol-extension / inherited / default-interface method (#750). The
   * first pass can't resolve these because `implements`/`extends` edges aren't
   * built yet; this runs AFTER edges are persisted, so `context.getSupertypes`
   * (and the conformance fallback in resolveMethodOnType) can walk them.
   *
   * Operates only on the leftover unresolved refs that have the `inner().method`
   * chain shape, for the dotted-chain languages — a small set — and is idempotent
   * (re-resolving an already-resolved ref is a no-op since it's been deleted).
   * Returns the number of newly-created edges.
   */
  async resolveChainedCallsViaConformance(): Promise<number> {
    const deferred = this.deferredChainRefs;
    this.deferredChainRefs = [];
    if (deferred.length === 0) return 0;

    // Read fresh edges (the main pass built the implements/extends edges after
    // these refs were deferred). matchDottedCallChain now resolves a method on a
    // supertype via context.getSupertypes -> resolveMethodOnType's conformance walk.
    this.clearCaches();
    // This post-pass runs synchronously on the indexer's main thread; yield
    // periodically so the #850 liveness watchdog heartbeat can fire on a repo
    // with many deferred chained calls (#1091).
    const maybeYield = createYielder();
    const resolved: ResolvedRef[] = [];
    for (const ref of deferred) {
      // PHP `this->prop.method` resolves via matchMethodCall (declared-type
      // inference + resolveMethodOnType conformance walk); `::`-receiver
      // languages (Rust) split on `::` (matchScopedCallChain); other
      // dotted-receiver languages on `.` (matchDottedCallChain).
      const chainMatch = (ref.language === 'php' && PHP_PROP_SHAPE.test(ref.referenceName))
        ? matchMethodCall(ref, this.context)
        : NEW_RECEIVER_SHAPE.test(ref.referenceName)
        ? matchNewReceiverCall(ref, this.context)
        : SCOPED_CHAIN_LANGUAGES.has(ref.language)
        ? matchScopedCallChain(ref, this.context)
        : matchDottedCallChain(ref, this.context);
      const match = this.gateLanguage(chainMatch, ref);
      if (match) resolved.push(match);
      await maybeYield();
    }
    return this.persistDeferredReferences(deferred, resolved);
  }

  /**
   * Resolve one batch with a yield checkpoint between EVERY ref so the #850
   * liveness heartbeat can fire on a slow/dense batch (#1091). The checkpoint
   * granularity is per-ref — not per-N-refs — because per-ref cost is unbounded
   * in the worst case (a collision-heavy method name whose candidate set misses
   * the LRU re-fetches tens of thousands of rows): any fixed N multiplies that
   * worst case into the watchdog window, which is how v1.2.0 still got killed
   * at "Resolving refs" on large Java monorepos (#1122). `maybeYield()` is a
   * ~ns time check when under budget, so per-ref checkpoints cost nothing.
   * Behaviourally identical to `resolveAll(batch)`: `warmCaches()` is
   * idempotent (guarded) and `resolveOne` is independent per ref, so yielding
   * between refs changes only timing, never which edges get created.
   */
  private async resolveBatchYielding(
    batch: UnresolvedReference[],
    maybeYield: MaybeYield
  ): Promise<ResolutionResult> {
    this.warmCaches();
    this.advanceSupertypeGeneration();

    const resolved: ResolvedRef[] = [];
    const unresolved: UnresolvedRef[] = [];
    const byMethod: Record<string, number> = {};

    for (const raw of batch) {
      const ref: UnresolvedRef = {
        fromNodeId: raw.fromNodeId,
        referenceName: raw.referenceName,
        referenceKind: raw.referenceKind,
        line: raw.line,
        column: raw.column,
        filePath: raw.filePath || this.getFilePathFromNodeId(raw.fromNodeId),
        language: raw.language || this.getLanguageFromNodeId(raw.fromNodeId),
        rowId: raw.rowId,
      };
      const result = this.resolveOneTimed(ref);
      if (result) {
        resolved.push(result);
        byMethod[result.resolvedBy] = (byMethod[result.resolvedBy] || 0) + 1;
      } else {
        unresolved.push(this.parkable(ref));
      }
      // Fast-path the per-ref yield check: awaiting the async no-op costs a
      // microtask hop per ref, which dominates at ~10⁵ refs (see MaybeYield).
      const y = maybeYield();
      if (y) await y;
    }

    return {
      resolved,
      unresolved,
      stats: {
        total: batch.length,
        resolved: resolved.length,
        unresolved: unresolved.length,
        byMethod,
      },
    };
  }

  /**
   * Resolve a list of refs and return everything the ADMISSION side needs to
   * persist the outcome: resolutions, failures, the deferred post-pass refs
   * this run produced (drained, so the caller owns routing them), and stats.
   * This is the resolver-worker entry point — it runs the exact per-ref loop
   * of resolveBatchYielding, minus the main-thread yields (worker threads have
   * no watchdog heartbeat to starve). Results are in input order.
   */
  /**
   * CODEGRAPH_RESOLVE_PROFILE=1: per-outcome wall-clock histogram of
   * resolveOne, keyed by the winning strategy (`resolvedBy`) or
   * `fail:<referenceKind>` — the §7a.2 "profile the per-ref path" probe. The
   * kernel-scale batch loop is ~430s and CORE-INVARIANT (835.9s pooled-4-on-8
   * ≈ 812.5s sequential-on-2 for the whole superphase), so the next lever is
   * which CLASS of ref the time belongs to, not more parallelism. Off by
   * default: the hrtime pair costs ~100ns/ref only when the env is set.
   */
  private resolveProfile: Map<string, { n: number; ns: bigint }> | null =
    process.env.CODEGRAPH_RESOLVE_PROFILE ? new Map() : null;

  /**
   * CODEGRAPH_RESOLVE_PROFILE=2 additionally attributes time to the
   * STRATEGIES inside resolveOne (`stage:<name>|<refKind>|hit/miss` rows in
   * the same histogram) — i.e. WHICH machinery a failing class of refs pays
   * for, not just that it fails. =1 keeps the per-outcome rows only.
   */
  private profileStages: boolean = process.env.CODEGRAPH_RESOLVE_PROFILE === '2';

  private stageAdd(stage: string, ref: UnresolvedRef, hit: boolean, t0: bigint): void {
    if (!this.resolveProfile) return;
    const dt = process.hrtime.bigint() - t0;
    const key = `stage:${stage}|${ref.referenceKind}|${hit ? 'hit' : 'miss'}`;
    const slot = this.resolveProfile.get(key);
    if (slot) {
      slot.n++;
      slot.ns += dt;
    } else {
      this.resolveProfile.set(key, { n: 1, ns: dt });
    }
  }

  private resolveOneTimed(ref: UnresolvedRef): ResolvedRef | null {
    if (!this.resolveProfile) return this.resolveOne(ref);
    const t0 = process.hrtime.bigint();
    const result = this.resolveOne(ref);
    const dt = process.hrtime.bigint() - t0;
    const key = result ? result.resolvedBy : `fail:${ref.referenceKind}`;
    const slot = this.resolveProfile.get(key);
    if (slot) {
      slot.n++;
      slot.ns += dt;
    } else {
      this.resolveProfile.set(key, { n: 1, ns: dt });
    }
    return result;
  }

  /** Dump the CODEGRAPH_RESOLVE_PROFILE histogram to stderr (no-op when off). */
  dumpResolveProfile(label: string): void {
    if (!this.resolveProfile || this.resolveProfile.size === 0) return;
    const rows = [...this.resolveProfile.entries()]
      .map(([k, v]) => ({ k, n: v.n, ms: Number(v.ns / 1_000_000n) }))
      .sort((a, b) => b.ms - a.ms);
    for (const r of rows) {
      console.error(
        `[resolve-profile] ${label} ${r.k}: n=${r.n} total=${(r.ms / 1000).toFixed(1)}s avg=${((r.ms * 1000) / Math.max(1, r.n)).toFixed(0)}µs`
      );
    }
    // =2 only: this thread's matchReference sub-stage table rides along.
    dumpNameMatcherProfile(label);
  }

  resolveListForAdmission(refs: UnresolvedReference[]): {
    resolved: ResolvedRef[];
    unresolved: UnresolvedRef[];
    deferredChain: UnresolvedRef[];
    deferredThisMember: UnresolvedRef[];
    byMethod: Record<string, number>;
  } {
    this.warmCaches();
    this.advanceSupertypeGeneration();
    const resolved: ResolvedRef[] = [];
    const unresolved: UnresolvedRef[] = [];
    const byMethod: Record<string, number> = {};
    for (const raw of refs) {
      const ref: UnresolvedRef = {
        fromNodeId: raw.fromNodeId,
        referenceName: raw.referenceName,
        referenceKind: raw.referenceKind,
        line: raw.line,
        column: raw.column,
        filePath: raw.filePath || this.getFilePathFromNodeId(raw.fromNodeId),
        language: raw.language || this.getLanguageFromNodeId(raw.fromNodeId),
        rowId: raw.rowId,
      };
      const result = this.resolveOneTimed(ref);
      if (result) {
        resolved.push(result);
        byMethod[result.resolvedBy] = (byMethod[result.resolvedBy] || 0) + 1;
      } else {
        unresolved.push(this.parkable(ref));
      }
    }
    this.deferredRowIds.clear(); // the admission side now owns both queues
    return {
      resolved,
      unresolved,
      deferredChain: this.deferredChainRefs.splice(0),
      deferredThisMember: this.deferredThisMemberRefs.splice(0),
      byMethod,
    };
  }

  /**
   * The resolver's live ResolutionContext — resolver-pool workers use it to
   * run synthesis passes against their own read-only connection.
   */
  getResolutionContext(): ResolutionContext {
    return this.context;
  }

  /**
   * Re-queue deferred post-pass refs produced by resolver workers, preserving
   * their admission order so resolveChainedCallsViaConformance /
   * resolveDeferredThisMemberRefs process them exactly as the sequential path
   * would have.
   */
  appendDeferredFromWorkers(deferredChain: UnresolvedRef[], deferredThisMember: UnresolvedRef[]): void {
    for (const ref of deferredChain) this.deferReference(ref, this.deferredChainRefs);
    for (const ref of deferredThisMember) this.deferReference(ref, this.deferredThisMemberRefs);
  }

  /**
   * Resolve and persist in batches to keep memory bounded.
   * Processes unresolved references in chunks, persisting edges and cleaning
   * up resolved refs after each batch to avoid accumulating large arrays.
   */
  async resolveAndPersistBatched(
    onProgress?: (current: number, total: number) => void,
    batchSize: number = 5000,
    onSynthesisProgress?: (done: number, total: number) => void,
    // When provided, big batches fan out across a read-only resolver-worker
    // pool with results admitted in canonical order (see resolver-pool.ts).
    // Sequential fallback on any pool failure. CODEGRAPH_NO_PARALLEL_RESOLVE=1
    // disables entirely. bulkEdgeLoad hooks (when provided) bracket the batch
    // loop with drop/recreate of the non-unique edge indexes on big runs —
    // see DatabaseConnection.beginBulkEdgeLoad. backpressure (when provided)
    // is the WAL valve's writer-side backstop (WalCheckpointValve.backpressure):
    // called at pool-idle boundaries so a full backfill can actually complete —
    // the valve's timer-driven passive passes stay perpetually partial against
    // the pool's continuous reads, which is how a kernel-scale resolution grew
    // a 22GB WAL on a 4.6GB DB (migration plan §7a.1).
    parallel?: {
      dbPath: string;
      bulkEdgeLoad?: {
        begin: () => void;
        end: () => void | Promise<void>;
        /** Indexes `end` leaves for later; built while the pool runs synthesis. */
        deferred?: () => void;
      };
      /** unresolved_refs index window for the batched loop — the loop only
       *  reads the status index + PK; dropping the sync-path ref indexes cuts
       *  each per-batch DELETE's B-tree work (DatabaseConnection.beginBulkRefLoad). */
      refIndexLoad?: { begin: () => void; end: () => void | Promise<void> };
      backpressure?: () => Promise<void> | null;
    },
    synthesize: boolean = true
  ): Promise<ResolutionResult> {
    // Resolution runs on the indexer's MAIN thread, and the #850 liveness
    // watchdog SIGKILLs a process whose event loop stalls past its window (60s
    // by default). A single dense batch's resolveAll — or the synthesis pass
    // below — can exceed that on a large repo, killing a VALID in-progress index
    // (#1091). A shared yielder lets both give the watchdog heartbeat a regular
    // window to fire; see ./cooperative-yield.
    const maybeYield = createYielder();

    if (process.env.CODEGRAPH_SYNTH_TIMINGS) {
      console.error(`[pool-timing] backpressure hook: ${parallel?.backpressure ? 'present' : 'absent'}`);
    }

    // CODEGRAPH_RESOLVE_PROFILE loop-stage attribution: the §7a.2 kernel-scale
    // histogram showed resolveOne owns only ~93s of the ~436s batch loop —
    // these counters name where the other ~340s goes (reads, edge build+insert,
    // deletes/marks, the per-batch count guard).
    const loopProf: Record<string, number> | null = process.env.CODEGRAPH_RESOLVE_PROFILE
      ? { read: 0, settle: 0, backpressure: 0, recycle: 0, createEdges: 0, insertEdges: 0, deletes: 0, marks: 0, countGuard: 0 }
      : null;
    const lp = (k: string, t0: number): void => { if (loopProf) loopProf[k] = (loopProf[k] ?? 0) + (Date.now() - t0); };
    let tLp = 0;

    await this.warmCachesYielding(maybeYield);

    const total = this.queries.getUnresolvedReferencesCount();
    let processed = 0;
    const aggregateStats = {
      total: 0,
      resolved: 0,
      unresolved: 0,
      byMethod: {} as Record<string, number>,
    };

    // Parallel pool, started immediately but never awaited up front: early
    // batches run sequentially while the workers boot (module load + readonly
    // DB open + framework detect + cache warm ≈ hundreds of ms), and the loop
    // switches to fan-out the moment the pool reports ready — so pool boot
    // costs zero wall-clock. Any failure downgrades to sequential permanently.
    let pool: ResolverPool | null = null;
    let poolReady = false;
    // True once pool creation has been attempted by EITHER engage site (the
    // up-front ref-count gate or the adaptive projection below) — a pool that
    // failed or was destroyed must stay down (downgrade is permanent), and
    // tryCreate's sizing probes shouldn't re-run every batch on hosts that
    // declined.
    let poolEngageTried = false;
    const createPool = (t0: number, why: string): ResolverPool | null => {
      poolEngageTried = true;
      if (!parallel) return null;
      const p = ResolverPool.tryCreate(parallel.dbPath, this.projectRoot);
      p?.ready().then(
        () => {
          poolReady = true;
          if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[pool-timing] pool ready after ${Date.now() - t0}ms (${why})`);
        },
        () => {
          void p.destroy().catch(() => undefined);
          if (pool === p) pool = null;
        }
      );
      return p;
    };
    if (parallel && total >= minRefsForPool()) {
      pool = createPool(Date.now(), 'ref-count');
    }
    // Adaptive engagement bar (see the batch-loop hook): projected remaining
    // sequential settle above this boots the pool mid-loop. Boot is async and
    // fan-out waits for ready, so a marginal engage costs background boot
    // only; the bar just needs to clear the fan-out's own overhead class.
    const ADAPTIVE_ENGAGE_SETTLE_MS = 400;
    let adaptiveSeqMs = 0;
    let adaptiveSeqRefs = 0;

    // Process in PIPELINED batches (double-buffer). The enumeration is the
    // head of the pending set in rowid order; every ref a persisted batch
    // processed leaves the pending set (resolved rows are deleted,
    // unresolvable ones flip to status='failed'), shifting the remaining
    // pending rows forward.
    let prevRemaining = Number.POSITIVE_INFINITY;

    // Cadence for the worker connection recycling below — ~8 batches
    // ≈ 40k refs between recycles keeps the WAL shallow at kernel scale
    // while a small sync never recycles at all. (25 recovered only half
    // the write tax — the WAL re-deepened between recycles; reopens are
    // sub-millisecond so the shorter cadence is ~free.)
    const RECYCLE_EVERY_BATCHES = 8;
    let batchesSinceRecycle = 0;

    // Fan-out result of ResolverPool.resolveBatch, settled (never rejecting)
    // so a fan-out begun before the previous batch's persist can't produce an
    // unhandled rejection while it waits to be awaited.
    type PoolSettled =
      | { ok: true; out: Awaited<ReturnType<ResolverPool['resolveBatch']>> }
      | { ok: false; err: unknown };
    type InFlight = { mode: 'pool'; settled: Promise<PoolSettled> } | { mode: 'seq' };

    // Begin one batch: fan out to the pool when it's ready and the batch is
    // big enough — workers then resolve batch k+1 WHILE the main thread
    // persists batch k (persist measured at ~58% of resolution wall on a
    // 255k-ref repo, all of it previously spent with the pool idle).
    // Sequential batches stay lazy: they run on the main thread at settle
    // time, where an early start would only contend with the persist.
    const beginBatch = (batch: UnresolvedReference[]): InFlight => {
      if (pool && poolReady && ResolverPool.worthParallel(batch.length)) {
        return {
          mode: 'pool',
          settled: pool.resolveBatch(batch).then(
            (out) => ({ ok: true as const, out }),
            (err: unknown) => ({ ok: false as const, err })
          ),
        };
      }
      return { mode: 'seq' };
    };

    // Settle an in-flight batch to a ResolutionResult. Deferred post-pass refs
    // are appended HERE, in loop order — never inside the fan-out promise — so
    // admission order stays exactly the sequential order even while a later
    // batch resolves concurrently. A pool failure downgrades to sequential
    // permanently and re-resolves this batch on the main thread.
    const settleBatch = async (
      inFlight: InFlight,
      batch: UnresolvedReference[]
    ): Promise<ResolutionResult> => {
      if (inFlight.mode === 'pool') {
        const settled = await inFlight.settled;
        if (settled.ok) {
          this.appendDeferredFromWorkers(settled.out.deferredChain, settled.out.deferredThisMember);
          return {
            resolved: settled.out.resolved,
            unresolved: settled.out.unresolved,
            stats: {
              total: batch.length,
              resolved: settled.out.resolved.length,
              unresolved: settled.out.unresolved.length,
              byMethod: settled.out.byMethod,
            },
          };
        }
        logDebug('Parallel resolution failed; falling back to sequential', {
          error: settled.err instanceof Error ? settled.err.message : String(settled.err),
        });
        if (pool) await pool.destroy().catch(() => undefined);
        pool = null;
      }
      return this.resolveBatchYielding(batch, maybeYield);
    };

    // Bulk edge load: on big runs, drop the non-unique edge indexes for the
    // duration of the batch loop (the identity index stays — OR IGNORE dedup
    // and the source-keyed supertype-walk reads both live on it). Recreated in
    // the inner finally BEFORE synthesis, whose passes read kind-keyed.
    // Measured on a 224k-edge resolution set: insert 2.8s → 1.1s + 0.3s
    // recreate. Same ref-count gate as the pool so small syncs never pay the
    // recreate cost.
    let bulkEdgesActive = false;
    if (parallel?.bulkEdgeLoad && total >= minRefsForPool()) {
      try {
        parallel.bulkEdgeLoad.begin();
        bulkEdgesActive = true;
      } catch { /* keep the indexes; inserts just pay the per-row maintenance */ }
    }
    // Same gate for the ref-index window: the loop's deletes stop maintaining
    // the five sync-path unresolved_refs indexes, and the end-of-loop rebuild
    // is near-free (only failed refs survive the loop).
    let bulkRefsActive = false;
    if (parallel?.refIndexLoad && total >= minRefsForPool()) {
      try {
        parallel.refIndexLoad.begin();
        bulkRefsActive = true;
      } catch { /* keep the indexes; deletes just pay the per-row maintenance */ }
    }

    try {
    try {
    // Orphans retain interruption/re-extraction order, not clean-index order.
    // A caller can precede its imports or supertypes by many batches (#1577).
    // Drain those prerequisites first, then start a fresh keyset cursor over
    // the remaining kinds. The disjoint filters let us prefetch across the
    // phase boundary before cleanup without re-reading the current batch.
    let prerequisites = true;
    let afterRowId = 0;
    const readNextBatch = (): UnresolvedReference[] => {
      let next = this.queries.getUnresolvedReferencesBatchAfter(afterRowId, batchSize, prerequisites);
      if (next.length === 0 && prerequisites) {
        prerequisites = false;
        afterRowId = 0;
        next = this.queries.getUnresolvedReferencesBatchAfter(afterRowId, batchSize, prerequisites);
      }
      if (next.length > 0) afterRowId = next[next.length - 1]!.rowId!;
      return next;
    };
    tLp = Date.now();
    let batch = readNextBatch();
    lp('read', tLp);
    let inFlight: InFlight | null = batch.length > 0 ? beginBatch(batch) : null;
    while (batch.length > 0 && inFlight) {
      // Prefetch the NEXT batch before this one persists: this batch's rows
      // are still pending (nothing has mutated the table since they were
      // read), so seeking past this batch's last row id in the same rowid
      // enumeration yields the following batch (keyset — OFFSET re-walked the
      // accumulated failed prefix every read, 54.6s at kernel scale, §7a.2).
      tLp = Date.now();
      const nextBatch = readNextBatch();
      lp('read', tLp);

      const tBatch = Date.now();
      const result = await settleBatch(inFlight, batch);
      if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[pool-timing] batch ${inFlight.mode}: ${batch.length} refs in ${Date.now() - tBatch}ms`);
      lp('settle', tBatch);

      // Adaptive pool engagement: the fixed ref-count gate can't see PER-REF
      // cost, and settle rates differ ~9× by language (56k Rust refs cost
      // more sequential settle than 154k Go refs — 36µs vs 4µs measured on
      // tokio/prometheus). After each sequential batch, project the remaining
      // settle from the observed rate and boot the pool mid-loop when it
      // clears the bar. The loop already switches to fan-out only when the
      // async boot reports ready, admission order is mode-independent, and
      // 2-core/low-memory hosts still decline inside tryCreate's sizing —
      // so the switch changes wall-clock, never the graph.
      if (inFlight.mode === 'seq' && parallel && pool === null && !poolEngageTried) {
        adaptiveSeqMs += Date.now() - tBatch;
        adaptiveSeqRefs += batch.length;
        const remaining = total - processed - batch.length;
        const projectedMs = (adaptiveSeqMs / Math.max(1, adaptiveSeqRefs)) * Math.max(0, remaining);
        if (shouldEngageAdaptively(projectedMs, remaining, ADAPTIVE_ENGAGE_SETTLE_MS)) {
          if (process.env.CODEGRAPH_SYNTH_TIMINGS) {
            console.error(`[pool-timing] adaptive engage: projected ${Math.round(projectedMs)}ms sequential settle over ${remaining} remaining refs`);
          }
          pool = createPool(Date.now(), 'adaptive');
        }
      }

      // WAL-valve backstop at the ONE pool-idle boundary of the double-buffer
      // (this batch settled, the next not yet fanned out): past the hard cap
      // the writer parks for a full backfill here, where the pool's readers
      // are all between statements — so the backfill completes, readers
      // re-enter at SQLite's backfilled mark, and the next persist commit
      // WRAPS the WAL instead of growing it. No-op (one fstat) under the cap.
      tLp = Date.now();
      const bp = parallel?.backpressure?.();
      if (bp) await bp;
      lp('backpressure', tLp);

      // Recycle the workers' read connections periodically at this same
      // worker-idle boundary (batch k settled, batch k+1 not yet fanned
      // out): a long-lived reader pins WAL checkpoint progress, and the
      // deep WAL that accumulates behind it taxes the writer's OWN page
      // operations — the §7a.6 writes-under-readers finding (deletes
      // 42.6s → 118.8s from 0 to 4 attached readers; an aggressive valve
      // recovered the writes but paid +129s in full-park folds). Releasing
      // the read marks every ~25 batches lets the existing checkpoints
      // advance instead, at ~milliseconds of reopen cost. A failed recycle
      // downgrades to sequential permanently, same as a failed fan-out.
      if (pool && poolReady && ++batchesSinceRecycle >= RECYCLE_EVERY_BATCHES) {
        batchesSinceRecycle = 0;
        tLp = Date.now();
        try {
          await pool.recycleWorkers();
        } catch (err) {
          logDebug('Worker connection recycle failed; falling back to sequential', {
            error: err instanceof Error ? err.message : String(err),
          });
          await pool.destroy().catch(() => undefined);
          pool = null;
        }
        lp('recycle', tLp);
      }

      // Persist in bounded sub-transactions with yields between: a whole
      // batch's edge insert / keyed deletes are otherwise one solid
      // synchronous span each on a multi-GB index, sitting BETWEEN the
      // per-ref yields — the last unyielded stretch of the resolution loop.
      // Crash semantics are unchanged (already several transactions): edges
      // land before their refs are deleted, so a kill mid-way re-resolves
      // the remainder idempotently on the next run/sweep (#1187).
      const PERSIST_CHUNK = 1000;
      const tPersist = Date.now();

      // A batch that made `extends`/`implements` edges persists them BEFORE
      // fanning out the next batch: later batches read them —
      // resolveMethodOnType walks supertype chains over edges that earlier
      // batches resolved, so a receiver typed as a subclass only reaches a
      // method declared on its base class if those edges are visible.
      // (Validated on dubbo: fanning out first downgraded exactly those
      // supertype-method resolutions from the 0.9 typed-receiver path to the
      // 0.65 word-overlap fallback.) They are the only edges resolution reads
      // (RESOLUTION_READ_EDGE_KINDS), so a batch that made none — every batch
      // after the prerequisite phase readNextBatch drains first — fans the
      // next batch out now and inserts while it resolves: the same writes in
      // the same order, and nothing the workers read differs.
      tLp = Date.now();
      const edges = this.createEdges(result.resolved);
      lp('createEdges', tLp);
      const readEdge = edges.some((e) => RESOLUTION_READ_EDGE_KINDS.includes(e.kind));
      let nextInFlight = !readEdge && nextBatch.length > 0 ? beginBatch(nextBatch) : null;
      tLp = Date.now();
      for (let i = 0; i < edges.length; i += PERSIST_CHUNK) {
        this.queries.insertEdges(edges.slice(i, i + PERSIST_CHUNK));
        await maybeYield();
      }
      lp('insertEdges', tLp);

      // NOW fan the next batch out (if not already) — workers see exactly the
      // edge state the sequential baseline would (every batch ≤ this one
      // committed), while the main thread spends the REST of the persist (ref
      // deletes + failed parking below) overlapped with their resolution —
      // the double-buffer.
      if (!nextInFlight && nextBatch.length > 0) nextInFlight = beginBatch(nextBatch);

      // Clean up resolved refs so they don't appear in the next batch —
      // by row id, so a same-key sibling ref in a LATER batch (same caller
      // calling the same callee at another line) is left pending for its own
      // attempt instead of being swept out with this batch's rows (#1269).
      tLp = Date.now();
      let removedThisBatch = 0;
      const resolvedCleanup = ReferenceResolver.partitionResolvedCleanup(result.resolved);
      for (let i = 0; i < resolvedCleanup.rowIds.length; i += PERSIST_CHUNK) {
        removedThisBatch += this.queries.deleteReferencesByRowIds(resolvedCleanup.rowIds.slice(i, i + PERSIST_CHUNK));
        await maybeYield();
      }
      for (let i = 0; i < resolvedCleanup.legacyKeys.length; i += PERSIST_CHUNK) {
        removedThisBatch += this.queries.deleteSpecificResolvedReferences(resolvedCleanup.legacyKeys.slice(i, i + PERSIST_CHUNK));
        await maybeYield();
      }
      lp('deletes', tLp);

      // Park unresolvable refs from this batch as status='failed' so they
      // leave the pending set (the batch reader and non-progress guard below
      // only see pending rows) but stay retryable when a later sync adds a
      // symbol that could satisfy them (#1240).
      tLp = Date.now();
      const failures = this.nonDeferredFailures(result.unresolved);
      const deferredCount = result.unresolved.length - failures.length;
      const failedCleanup = ReferenceResolver.partitionFailedCleanup(failures);
      for (let i = 0; i < failedCleanup.byRowId.length; i += PERSIST_CHUNK) {
        removedThisBatch += this.queries.markReferencesFailedByRowIds(failedCleanup.byRowId.slice(i, i + PERSIST_CHUNK));
        await maybeYield();
      }
      for (let i = 0; i < failedCleanup.legacyKeys.length; i += PERSIST_CHUNK) {
        removedThisBatch += this.queries.markReferencesFailed(failedCleanup.legacyKeys.slice(i, i + PERSIST_CHUNK));
        await maybeYield();
      }
      lp('marks', tLp);

      if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[pool-timing] batch persist: ${Date.now() - tPersist}ms`);

      // Aggregate stats
      aggregateStats.total += result.stats.total;
      aggregateStats.resolved += result.stats.resolved;
      aggregateStats.unresolved += result.stats.unresolved;
      for (const [method, count] of Object.entries(result.stats.byMethod)) {
        aggregateStats.byMethod[method] = (aggregateStats.byMethod[method] || 0) + count;
      }

      processed += batch.length;
      onProgress?.(processed, total);

      // Yield so progress UI can render between batches
      await new Promise(resolve => setImmediate(resolve));

      // NOTE: there used to be an extra early break here when a batch resolved
      // nothing (`result.unresolved.length === batch.length`). That was wrong:
      // an all-unresolvable batch still DELETES its rows (progress), yet the
      // break abandoned every batch after it in the same run — on a repo whose
      // first 5000 refs are all external/stdlib calls, resolution stopped at
      // batch one and left the rest of the table as permanent orphans (#1187).
      // The count-based guard below catches the true no-progress case.

      // Non-progress guard (defense-in-depth). Ordinary attempts must leave
      // the pending set; a mismatched original reference can make legacy-key
      // cleanup a no-op. Keep the guard against that broken persistence even
      // though keyset pagination now advances independently of row cleanup.
      // An abandoned prefetched batch has no side effects until settleBatch.
      // Non-progress signal, now O(1): `changes` summed across this batch's
      // deletes + failed-parks is the DIRECT evidence the guard's old count
      // diff inferred — a resolver returning a mismatched name makes the keyed
      // cleanup no-op, which shows up here as zero removals. The per-batch
      // COUNT(*) it replaces walked every remaining pending row — O(N²/batch)
      // over a run, 93.9s of the kernel-scale batch loop (§7a.2). A REAL count
      // runs only on the suspicious path (claimed-work batch removed nothing —
      // e.g. every row was a sibling a legacy-key sweep already consumed),
      // where it arbitrates stop-vs-continue exactly as before.
      // Deferred refs legitimately remain pending for the post-pass. The
      // keyset cursor advances past them; they must not trigger this guard.
      if (removedThisBatch + deferredCount <= 0 && batch.length > 0) {
        tLp = Date.now();
        const remaining = this.queries.getUnresolvedReferencesCount();
        lp('countGuard', tLp);
        if (remaining >= prevRemaining) break;
        prevRemaining = remaining;
      }

      // Advance the pipeline: the prefetched batch (already fanned out when
      // the pool is on) becomes the current one.
      batch = nextBatch;
      inFlight = nextInFlight;
    }
    } finally {
      // Recreate the edge indexes BEFORE synthesis (kind-keyed reads) and on
      // any error path. A crash before this line is healed by the next
      // DatabaseConnection open (schema.sql re-applies IF NOT EXISTS).
      if (bulkRefsActive) {
        const tRef = Date.now();
        await parallel!.refIndexLoad!.end();
        if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] ref-index-recreate: ${Date.now() - tRef}ms`);
      }
      if (bulkEdgesActive) {
        const tIdx = Date.now();
        await parallel!.bulkEdgeLoad!.end();
        if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] edge-index-recreate: ${Date.now() - tIdx}ms`);
        // The recreate just wrote every non-unique edge index into the WAL
        // (multi-GB at kernel scale) with the pool idle — fold before the
        // synthesis passes pin readers against it for minutes.
        const bp = parallel?.backpressure?.();
        if (bp) await bp;
      }
    }

    // Indexes the bulk-edge window's end deferred: built once, while the pool
    // is busy with synthesis when it is, and in any case before this returns.
    let deferredBuilt = !bulkEdgesActive || !parallel?.bulkEdgeLoad?.deferred;
    const buildDeferredIndexes = (): void => {
      if (deferredBuilt) return;
      deferredBuilt = true;
      const tDeferred = Date.now();
      try {
        parallel!.bulkEdgeLoad!.deferred!();
      } catch { /* healed by schema.sql on the next open, like a crash in the window */ }
      if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] deferred-edge-index: ${Date.now() - tDeferred}ms`);
    };

    // Dynamic-edge synthesis: now that all base `calls` edges are persisted,
    // synthesize observer/callback dispatch edges (dispatcher → registered
    // callbacks) that static parsing leaves out. Best-effort — never fail the
    // index on it. The pool (when it survived resolution) is REUSED to fan the
    // independent passes across its read-only workers — that's why its destroy
    // lives in the finally below, after synthesis, not at the end of the batch
    // loop. See docs/design/callback-edge-synthesis.md.
    const tSynth = Date.now();
    try {
      if (synthesize) aggregateStats.byMethod['callback-synthesis'] = await synthesizeCallbackEdges(
        this.queries,
        this.context,
        onSynthesisProgress,
        pool,
        parallel?.backpressure,
        buildDeferredIndexes
      );
    } catch {
      // synthesis is additive and optional; ignore failures
    }
    buildDeferredIndexes();
    if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(`[phase-timing] callback-synthesis: ${Date.now() - tSynth}ms`);
    } finally {
      if (pool) await pool.destroy().catch(() => undefined);
    }

    if (loopProf) {
      const parts = Object.entries(loopProf).map(([k, v]) => `${k}=${(v / 1000).toFixed(1)}s`).join(' ');
      console.error(`[resolve-profile] loop-stages ${parts}`);
    }
    this.dumpResolveProfile('main');

    return {
      resolved: [],
      unresolved: [],
      stats: aggregateStats,
    };
  }

  /** Replace synthesis only after every base-resolution pass has finished. */
  async refreshSynthesis(
    dbPath: string,
    onProgress?: (done: number, total: number) => void,
    backpressure?: () => Promise<void> | null
  ): Promise<number> {
    this.clearCaches();
    const stage = new SynthesisStage(dbPath);
    try {
      const fresh = new ReferenceResolver(this.projectRoot, stage.queries);
      const count = await synthesizeCallbackEdges(stage.queries, fresh.context, onProgress, null, backpressure);
      await stage.publish(backpressure);
      return count;
    } finally {
      stage.close();
      this.clearCaches();
    }
  }

  /**
   * Digest of the package roots Python import resolution rests on (see
   * `pythonRootFingerprint`). Build configs are read from disk rather than
   * the file cache, so a sync after an edit sees the edit. Empty for a
   * project with no Python.
   */
  getPythonRootFingerprint(): string {
    return pythonRootFingerprint(this.diskContext());
  }

  /**
   * The workspace packages and path dependencies as package.json files
   * declare them now, read again from disk, and their fingerprint (see
   * `workspaceFingerprint`). The resolver keeps the map for its lifetime, so
   * a sync calls this to see a manifest edit; when the map moved, the
   * resolver takes the new one and drops every memo resolved through the old
   * one, and the caller re-opens what was linked by it.
   */
  refreshWorkspacePackages(): string {
    const fresh = loadWorkspacePackages(this.projectRoot);
    const fingerprint = workspaceFingerprint(fresh);
    if (this.workspacePackages === undefined || workspaceFingerprint(this.workspacePackages) !== fingerprint) {
      this.workspacePackages = fresh;
      this.clearCaches();
    }
    return fingerprint;
  }

  /** The fingerprint of the workspace map this resolver resolves by (see `workspaceFingerprint`). */
  getWorkspaceFingerprint(): string {
    return workspaceFingerprint(this.context.getWorkspacePackages?.() ?? null);
  }

  /** The folder of the workspace package or path dependency `file` is in (see `workspacePackageDirOf`), or null. */
  workspacePackageDirOf(file: string): string | null {
    const ws = this.context.getWorkspacePackages?.();
    return ws ? workspacePackageDirOf(ws, file) : null;
  }

  /** What a sync must re-open after these Python files were added or removed (see `pythonReopenScope`). */
  getPythonReopenScope(changedFiles: string[]): ReturnType<typeof pythonReopenScope> {
    return pythonReopenScope(this.diskContext(), changedFiles);
  }

  /** Importers of Python packages whose `__init__.py` was edited, with the names they bind (see `pythonPackageImporters`). */
  getPythonPackageImporters(initFiles: string[]): Map<string, Map<string, string | null>> {
    return pythonPackageImporters(this.context, initFiles);
  }

  /** The resolution context, reading build configs from disk rather than the file cache. */
  private diskContext(): ResolutionContext {
    return {
      ...this.context,
      readFile: (filePath: string) => {
        try {
          return fs.readFileSync(path.join(this.projectRoot, filePath), 'utf-8');
        } catch {
          return null;
        }
      },
    };
  }

  /**
   * Get detected frameworks
   */
  getDetectedFrameworks(): string[] {
    return this.frameworks.map((f) => f.name);
  }

  /** The project file a module specifier written in `fromFile` names, as its import resolves it; null when none. */
  resolveModuleFile(specifier: string, fromFile: string, language: Language): string | null {
    return resolveImportPath(specifier, fromFile, language, this.context);
  }

  /**
   * What `ref` resolves to against the graph as it is now, writing nothing:
   * its target and how it was found, or null. A sync compares it with the
   * edge the reference made before, to re-open only an edge an edit moved.
   */
  resolveNow(ref: UnresolvedReference): { targetNodeId: string; resolvedBy: string } | null {
    if (!ref.filePath || !ref.language) return null;
    const resolved = this.resolveOne({ ...ref, filePath: ref.filePath, language: ref.language });
    return resolved ? { targetNodeId: resolved.targetNodeId, resolvedBy: resolved.resolvedBy } : null;
  }

  /** True when a detected router binds navigation calls to its routes (see {@link reopenNavigationsFor}). */
  hasNavigationRouters(): boolean {
    return this.frameworks.some((f) => f.navigation !== undefined);
  }

  /**
   * Put back in the pending set the navigation calls `routes` — route nodes a
   * sync added, removed or renamed ({@link changedRoutes}) — may now resolve
   * differently, for the sync's resolution sweep: the calls parked as failed,
   * and the calls whose `navigates` edges a router's resolver made. Calls in
   * `changedFilePaths` are left alone; the sync resolved them against the new
   * routes already. Returns the number of references put back.
   *
   * A navigation call names its route by path (`navigate('/login')`) and its
   * reference by the router's method (`navigate`, `history.push`), so a route
   * table that changed in another file is invisible to the rest of sync. A
   * call parked as failed while its route was missing is keyed on `push`,
   * which no synced file defines, and a resolved call keeps the route it bound
   * to while a better one was missing (a catch-all, a parameter route, one arm
   * of a conditional) or a route renamed under it. A full index resolves every
   * call against the final table. Each router says which calls a route of its
   * own can answer (`FrameworkResolver.navigation`): the method tails, and the
   * apps whose files match against that route's table. A name more of those
   * calls share than `perNameCeiling` is skipped, as the symbol retry skips a
   * common tail.
   */
  reopenNavigationsFor(routes: readonly Node[], changedFilePaths: readonly string[] = [], perNameCeiling: number = 500): number {
    if (routes.length === 0) return 0;
    const plans: Array<{ router: FrameworkResolver; scopes: string[] }> = [];
    const tails = new Set<string>();
    for (const router of this.frameworks) {
      if (!router.navigation) continue;
      const scopes = new Set<string>();
      for (const route of routes) {
        for (const scope of router.navigation.scope(route, this.context) ?? []) scopes.add(scope);
      }
      if (scopes.size === 0) continue;
      plans.push({ router, scopes: [...scopes] });
      for (const tail of router.navigation.tails) tails.add(tail);
    }
    if (plans.length === 0) return 0;
    const claimed = (name: string, filePath: string): boolean =>
      plans.some(({ router, scopes }) => scopes.some((scope) => filePath.startsWith(scope)) && router.claimsReference?.(name) === true);

    const fresh = new Set(changedFilePaths);
    const failed = new Map<string, number[]>();
    for (const ref of this.queries.getFailedCallsByTail([...tails])) {
      if (fresh.has(ref.filePath) || !claimed(ref.referenceName, ref.filePath)) continue;
      const rowIds = failed.get(ref.referenceName);
      if (rowIds) rowIds.push(ref.rowId);
      else failed.set(ref.referenceName, [ref.rowId]);
    }
    const resolved = new Map<string, Array<Edge & { edgeId: number; sourceFilePath: string; sourceLanguage: Language }>>();
    for (const edge of this.queries.getResolvedNavigations()) {
      const name = edge.metadata?.refName;
      if (typeof name !== 'string' || fresh.has(edge.sourceFilePath) || !claimed(name, edge.sourceFilePath)) continue;
      const edges = resolved.get(name);
      if (edges) edges.push(edge);
      else resolved.set(name, [edge]);
    }

    const rowIds: number[] = [];
    const edgeIds: number[] = [];
    const refs: UnresolvedReference[] = [];
    // A conditional's arms are edges of one call: it goes back as one reference.
    const sites = new Set<string>();
    for (const name of new Set([...failed.keys(), ...resolved.keys()])) {
      const rows = failed.get(name) ?? [];
      const edges = resolved.get(name) ?? [];
      if (rows.length + edges.length > perNameCeiling) continue;
      for (const rowId of rows) rowIds.push(rowId);
      for (const edge of edges) {
        const ref = resurrectRefFromDroppedEdge(edge);
        if (!ref) continue;
        edgeIds.push(edge.edgeId);
        const site = `${ref.fromNodeId}\0${ref.referenceName}\0${ref.line}\0${ref.column}`;
        if (sites.has(site)) continue;
        sites.add(site);
        refs.push(ref);
      }
    }
    if (edgeIds.length > 0) this.queries.replaceResolutionEdgesWithUnresolvedRefs(edgeIds, refs);
    return this.queries.reopenFailedReferences(rowIds) + refs.length;
  }

  /**
   * The edited modules among `modifiedFilePaths` whose default export moved:
   * an edit made `export default A` into `export default B`, or took the
   * default away, while `A` stayed declared. A sync moves the edges other
   * files made into a changed file onto the node that replaces each target, so
   * `new Y()` after `import Y from './x'` kept `A` where a full index links
   * `B`. An `export default` statement is no node, so neither the definition
   * delta nor a failed-reference retry sees it change.
   *
   * The default a module had is read off the edges into it, with no file read:
   * a default or namespace import of it is an `imports` edge into its file
   * node named for the binding, and a whole-name reference through that
   * binding (`Y`, not `Y.run`) that resolved through the import names exactly
   * its default (a namespace binding's `NS` names the file). Only edges bound
   * before this sync resolved anything count (up to `resolvedUpToEdgeId`), and
   * only from files it left alone. A module that forwards its default from
   * another file (`export { default } from './impl'`) has those edges there,
   * so a few of its importers' are read instead. An edit that leaves the
   * default alone, nearly every one, finds them all still on it. Each module
   * comes with the declarations its default was (`was`), as those edges say.
   */
  changedDefaultExports(
    modifiedFilePaths: readonly string[],
    changedFilePaths: readonly string[],
    resolvedUpToEdgeId: number,
  ): Array<{ path: string; language: Language; was: string[] }> {
    const fresh = new Set(changedFilePaths);
    const moved: Array<{ path: string; language: Language; was: string[] }> = [];
    for (const filePath of modifiedFilePaths) {
      if (!isJsFamilyFile(filePath)) continue;
      const bindings = new Map<string, Set<string>>();
      for (const i of this.queries.getImportsInto(`file:${filePath}`, filePath)) {
        if (i.refName === null || fresh.has(i.filePath) || !isModuleBindingName(i.refName)) continue;
        const names = bindings.get(i.filePath) ?? new Set<string>();
        names.add(i.refName);
        bindings.set(i.filePath, names);
      }
      if (bindings.size === 0) continue;
      const language = this.queries.getFileByPath(filePath)?.language;
      if (!language) continue;
      const readsDefault = (e: Edge & { edgeId: number; sourceFilePath: string }): boolean => {
        const name = e.metadata?.refName;
        return typeof name === 'string' && e.metadata?.resolvedBy === 'import' && e.edgeId <= resolvedUpToEdgeId &&
          !e.target.startsWith('file:') && bindings.get(e.sourceFilePath)?.has(name) === true;
      };
      let readers: Array<Edge & { edgeId: number; sourceFilePath: string; sourceLanguage: Language }> =
        this.queries.getCrossFileIncomingEdgesWithTarget(filePath).filter(readsDefault);
      if (readers.length === 0) {
        const now = moduleDefaultExport(filePath, language, this.context);
        if (!now || now.filePath === filePath) continue;
        readers = [...bindings].slice(0, DEFAULT_READER_SAMPLE_FILES)
          .flatMap(([file, names]) => this.queries.getResolutionEdgesThrough(file, [...names]))
          .filter(readsDefault);
      }
      const was = new Set<string>();
      for (const e of readers) {
        const now = moduleDefaultExport(filePath, e.sourceLanguage, this.context);
        // A call that lands on an alias binding goes on to the callable it names (resolveOne).
        if (now && (e.target === now.id || (e.kind === 'calls' && resolveAliasBinding(now, null, this.context)?.id === e.target))) continue;
        was.add(e.target);
      }
      if (was.size > 0) moved.push({ path: filePath, language, was: [...was] });
    }
    return moved;
  }

  /**
   * Whether a failed import could name one of `files`, the files a sync just
   * added: the test the import retry puts a crowded key's imports to
   * (`QueryBuilder.getRetryableFailedImports`). `utils` is the path stem of a
   * project's own `./utils` and of every `jotai/utils` and `@scope/pkg/utils`
   * import alike, and `assert` the name of every binding of `import * as
   * assert from 'assert'`, so past the retry's ceiling a key holds the few
   * imports an added `utils.ts` or `assert.ts` is for among hundreds that no
   * file of the project is.
   *
   * A JavaScript or TypeScript import reaches a file by the module it is
   * written as (a path, a tsconfig alias or a workspace package, an `index`
   * file and the emitted `.js` of a `.ts` included), by a framework's alias
   * (SvelteKit's `$lib/…`) or by the file's own name (`…/utils.js`). One that
   * none of those lead to an added file — a package, an import binding, a
   * workspace package's subpath only its `exports` map resolves — names none
   * of them. Of an import written in another language this knows nothing, so
   * a crowded key skips it, as it always has.
   */
  couldNameAnyOf(files: readonly string[]): (reference: UnresolvedReference) => boolean {
    const added = new Set(files);
    const names = new Set(files.map((file) => file.slice(file.lastIndexOf('/') + 1)));
    return (reference) => {
      const language = reference.language || this.getLanguageFromNodeId(reference.fromNodeId);
      if (!ESM_IMPORT_LANGUAGES.has(language)) return false;
      const ref: UnresolvedRef = {
        fromNodeId: reference.fromNodeId,
        referenceName: reference.referenceName,
        referenceKind: reference.referenceKind,
        line: reference.line,
        column: reference.column,
        filePath: reference.filePath || this.getFilePathFromNodeId(reference.fromNodeId),
        language,
        rowId: reference.rowId,
      };
      const name = ref.referenceName;
      if (names.has(name.slice(name.lastIndexOf('/') + 1))) return true;
      // Where the specifier leads first: a package's leads nowhere, and only
      // then is it worth asking whether the resolver reads the reference as a
      // module, which for a bare name means reading the file's imports.
      const target = resolveImportPath(name, ref.filePath, language, this.context);
      if (target !== null && added.has(target) && jsModuleFile(ref, this.context) === target) return true;
      // A framework's alias is a path (`$lib/x`, `~/x`); a bare name, which
      // every binding is, is no alias, and asking reads the file.
      return name.includes('/') && this.frameworksFor(language).some((framework) => {
        const result = framework.resolve(ref, this.context);
        return result !== null && added.has(this.nodeById(result.targetNodeId)?.filePath ?? '');
      });
    };
  }

  /**
   * True when `receiver` is a local name bound by an import that resolves to a
   * file IN THIS PROJECT — the only case where letting a python
   * built-in-method name through the filter is safe (#1681).
   *
   * Asking only whether SOME import bound the local name is not enough: every
   * import produces a mapping, stdlib and PyPI included, so that would also be
   * true for `os`, `requests`, `np`. Opening the filter for them lets
   * resolveViaImport find no project file, fall through to bare-name matching,
   * and bind `os.remove(p)` to whatever project method happens to be named
   * `remove` — reintroducing, through its own escape hatch, the fabricated-edge
   * class this filter exists to prevent.
   *
   * Resolving the specifier is the same question resolveViaImport will ask
   * next, so a receiver that passes here is one the qualified path can actually
   * serve; anything else stays a silent miss rather than a wrong edge.
   */
  private isPythonProjectModule(ref: UnresolvedRef, receiver: string): boolean {
    for (const imp of this.context.getImportMappings(ref.filePath, ref.language)) {
      if (imp.localName !== receiver) continue;
      // `import pkg.mod` / `import pkg.mod as m` binds the module `source`
      // names. `from pkg import mod` binds `pkg.mod`, and `from . import mod`
      // binds `.mod` — join without doubling the dot that makes `.` mean the
      // current package.
      const specifier = imp.isNamespace
        ? imp.source
        : imp.source.endsWith('.')
          ? `${imp.source}${imp.exportedName}`
          : `${imp.source}.${imp.exportedName}`;
      if (resolveImportPath(specifier, ref.filePath, ref.language!, this.context)) {
        return true;
      }
    }
    return false;
  }

  /** A python call `x.get(…)` of a method named like a builtin collection, string or file method. */
  private isPythonBuiltinNamedMethodCall(ref: UnresolvedRef): boolean {
    if (ref.language !== 'python' || ref.referenceKind !== 'calls') return false;
    const dot = ref.referenceName.indexOf('.');
    return dot > 0 && PYTHON_BUILT_IN_METHODS.has(ref.referenceName.slice(dot + 1)) &&
      !PYTHON_BUILT_IN_TYPES.has(ref.referenceName.slice(0, dot));
  }

  /**
   * True when the Go file imports `qualifier` — by its last path segment or
   * an alias — from a package of one of the project's own modules.
   */
  private isGoProjectPackage(ref: UnresolvedRef, qualifier: string): boolean {
    return this.context
      .getImportMappings(ref.filePath, ref.language)
      .some((imp) => imp.localName === qualifier && this.context.getGoPackageDir?.(imp.source, ref.filePath) != null);
  }

  /**
   * Check if reference is to a built-in or external symbol
   */
  private isBuiltInOrExternal(ref: UnresolvedRef): boolean {
    const name = ref.referenceName;
    const isJsTs = ref.language === 'typescript' || ref.language === 'javascript'
      || ref.language === 'tsx' || ref.language === 'jsx' || ref.language === 'arkts'
      || ref.language === 'vue' || ref.language === 'svelte' || ref.language === 'astro';

    // JavaScript/TypeScript built-ins — unless the file imports its own
    // binding of that name (`import Map from './Map.svelte'`).
    if (isJsTs && JS_BUILT_INS.has(name) &&
        !this.context.getImportMappings(ref.filePath, ref.language).some((m) => m.localName === name)) {
      return true;
    }

    // ArkTS resource-reference intrinsics — `$r('app.string.x')` /
    // `$rawfile('x.png')` are framework-provided and appear dozens of times
    // per UI file; without this they can resolve to a stray same-named
    // symbol (e.g. a checked-in hvigor wrapper's `$r`).
    if (ref.language === 'arkts' && (name === '$r' || name === '$rawfile')) {
      return true;
    }

    // Common JS/TS library calls (console.log, Math.floor, JSON.parse)
    if (isJsTs && (name.startsWith('console.') || name.startsWith('Math.') || name.startsWith('JSON.'))) {
      return true;
    }

    // React hooks from React itself
    if (isJsTs && REACT_HOOKS.has(name)) {
      return true;
    }

    // Python built-ins (bare calls only — dotted calls like console.print are method calls)
    if (ref.language === 'python' && PYTHON_BUILT_INS.has(name)) {
      return true;
    }

    // Python built-in method calls (e.g., list.extend, dict.update)
    if (ref.language === 'python') {
      const dotIdx = name.indexOf('.');
      if (dotIdx > 0) {
        const receiver = name.substring(0, dotIdx);
        const method = name.substring(dotIdx + 1);
        // Filter calls on built-in types (list.append, dict.update, etc.)
        if (PYTHON_BUILT_IN_TYPES.has(receiver)) {
          return true;
        }
        // Filter built-in methods on non-class receivers
        // (e.g., items.append where items is a local list variable)
        // But allow if the capitalized receiver matches a known codebase class,
        // OR the receiver is itself an imported project module — a module can
        // export a top-level function sharing a common collection-method name
        // (`ledger.append`, `from . import ledger`), and that call is a real
        // project dependency, not `list.append` (#1681). Without this, the
        // qualified ref never reaches resolveViaImport / resolvePythonModuleMember.
        if (PYTHON_BUILT_IN_METHODS.has(method)) {
          // A module-scope collection binding is stronger evidence than a
          // coincidentally matching class name (#1652). Only use this file's
          // binding: an unrelated module may reuse the receiver for a collection.
          const isCollection = this.context.getNodesByName(receiver).some((node) =>
            node.language === 'python' && node.filePath === ref.filePath &&
            (node.kind === 'variable' || node.kind === 'constant') &&
            node.qualifiedName === receiver &&
            /^=\s*(?:[\[{]|(?:dict|list|set|tuple|frozenset)\s*\(|\(\s*\)|\([^()]*,)/.test(node.signature ?? '')
          );
          if (isCollection) return true;

          const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
          const isKnownClass = this.context.getNodesByName(capitalized).some((node) =>
            node.language === 'python' &&
            (node.kind === 'class' || node.kind === 'struct' || node.kind === 'interface')
          );
          const isProjectModule =
            !isKnownClass && this.isPythonProjectModule(ref, receiver);
          if (!isKnownClass && !isProjectModule) {
            return true;
          }
        }
      }
      // A bare name colliding with a builtin method (index, get, update, count…)
      // is only a builtin when NOTHING in the codebase declares it. A declared
      // symbol with that exact name — e.g. a Flask/FastAPI view `def index()` or
      // `def get()` — is a real reference target. Without this guard, every
      // handler named after a builtin method silently loses its route→handler edge.
      if (PYTHON_BUILT_IN_METHODS.has(name) && !this.knownNames?.has(name)) {
        return true;
      }
    }

    // Go standard library packages — refs like "fmt.Println", "http.ListenAndServe", etc.
    if (ref.language === 'go') {
      const dotIdx = name.indexOf('.');
      // What the file imports decides before the name does: a project package
      // may be called `errors`, `log` or `types` too.
      if (dotIdx > 0 && !this.isGoProjectPackage(ref, name.substring(0, dotIdx))) {
        const pkg = name.substring(0, dotIdx);
        // Not a local bound from a type assertion that is named like one:
        // grpc-go's `parser.ParseConfig(…)` after `parser, ok :=
        // b.(balancer.ConfigParser)`. Nor a call on any other parameter or
        // local of the name that can hold one of the project's values: gin's
        // `context.AbortWithError(…)` in `func(context *Context)`.
        if (GO_STDLIB_PACKAGES.has(pkg) && !isGoAssertedLocal(pkg, ref, this.context) &&
            !isGoProjectLocalCall(ref, this.context)) {
          return true;
        }
      }
      if (GO_BUILT_INS.has(name)) {
        return true;
      }
    }

    // Pascal/Delphi built-ins, whatever their case: Pascal names ignore it
    // (`length(S)`, `system.TypeInfo(T)`). And standard library units.
    if (ref.language === 'pascal') {
      const lower = name.toLowerCase();
      if (PASCAL_UNIT_PREFIXES.some((p) => name.startsWith(p)) || lower.startsWith('system.')) {
        return true;
      }
      if (PASCAL_BUILT_INS.has(lower)) {
        return true;
      }
    }

    // C/C++ standard library symbols (printf, malloc, std::vector, etc.).
    // Names that collide with user-defined symbols are NOT filtered —
    // C and C++ projects routinely shadow stdlib names (custom allocators
    // define `malloc`/`free`, stream wrappers define `read`/`write`/`open`,
    // containers define `move`/`swap`, logging libs wrap `printf`). Killing
    // those resolutions makes the graph wrong, not cleaner. We only filter
    // when there's no user node with this name — then name-matching would
    // produce zero edges anyway and the filter just short-circuits work.
    if (ref.language === 'c' || ref.language === 'cpp') {
      // A leading `::` names the global scope: `::std::move` is `std::move`,
      // `::memset` is `memset`.
      const scoped = name.startsWith('::') ? name.slice(2) : name;
      // C++ std:: namespace prefix — safe to filter unconditionally,
      // since `std::foo` is never a user-defined qualified name in
      // tree-sitter output.
      if (scoped.startsWith('std::')) return true;
      if (C_BUILT_INS.has(scoped) || CPP_BUILT_INS.has(scoped)) {
        return !this.hasAnyPossibleMatch(scoped);
      }
    }

    return false;
  }

  /**
   * Get file path from node ID
   */
  private getFilePathFromNodeId(nodeId: string): string {
    const node = this.nodeById(nodeId);
    return node?.filePath || '';
  }

  /**
   * Get language from node ID
   */
  private getLanguageFromNodeId(nodeId: string): UnresolvedRef['language'] {
    const node = this.nodeById(nodeId);
    return node?.language || 'unknown';
  }

  /**
   * Collect the `@using` namespaces in scope for a `.razor`/`.cshtml` file: its
   * own `@using` directives plus every `_Imports.razor` from the file's folder up
   * to the project root (Razor `_Imports` cascade). Cached per file.
   */
  private getRazorUsings(filePath: string): string[] {
    const cached = this.razorUsingsCache.get(filePath);
    if (cached) return cached;
    const usings = new Set<string>();
    const addFrom = (src: string | null): void => {
      if (!src) return;
      for (const m of src.matchAll(/^\s*@using\s+(?:static\s+)?([A-Za-z_][\w.]*)/gm)) usings.add(m[1]!);
    };
    addFrom(this.context.readFile(filePath));
    let dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
    // Walk up to the project root, reading each level's _Imports.razor.
    for (;;) {
      addFrom(this.context.readFile(dir ? `${dir}/_Imports.razor` : '_Imports.razor'));
      if (!dir) break;
      const slash = dir.lastIndexOf('/');
      dir = slash >= 0 ? dir.slice(0, slash) : '';
    }
    const arr = [...usings];
    this.razorUsingsCache.set(filePath, arr);
    return arr;
  }

  /**
   * Resolve a Razor/Blazor simple type ref through the file's `@using`
   * namespaces: `CatalogBrand` + `@using BlazorShared.Models` → the node whose
   * qualified name is `BlazorShared.Models::CatalogBrand`. Only resolves when the
   * `@using` set yields exactly ONE type (otherwise it stays ambiguous and falls
   * through to name-matching).
   */
  private resolveRazorUsing(ref: UnresolvedRef): ResolvedRef | null {
    if (ref.referenceName.includes('.') || ref.referenceName.includes('::')) return null;
    const usings = this.getRazorUsings(ref.filePath);
    if (usings.length === 0) return null;
    const found = new Map<string, Node>();
    for (const ns of usings) {
      for (const cand of this.context.getNodesByQualifiedName(`${ns}::${ref.referenceName}`)) {
        found.set(cand.id, cand);
      }
    }
    if (found.size !== 1) return null;
    const target = found.values().next().value!;
    return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'import' };
  }

  /**
   * Resolve a CFML inheritance reference written as a component path (#1152).
   * Two forms exist in real code:
   *
   * - Dotted: `extends="coldbox.system.web.Controller"` — dots are directory
   *   separators from the webroot or a CFML mapping. Mappings live in server
   *   config / Application.cfc, so the leading segments may not exist in the
   *   repo at all (in the coldbox repo itself the path is `system/web/
   *   Controller.cfc` — the `coldbox.` root IS the repo). Matched by final
   *   segment (the class), corroborated right-to-left against the candidate's
   *   parent directories.
   * - Relative: `extends="../base"` / `extends="./base"` (the FW/1 style) —
   *   resolved against the referencing file's own directory.
   *
   * Conservative by design: a candidate needs at least one corroborating
   * directory segment (a dotted path whose only same-named class sits in an
   * unrelated directory is almost always an out-of-repo library supertype —
   * mxunit/testbox/coldbox-as-dependency), and a corroboration tie yields no
   * edge. Directory comparison is case-insensitive (CFML path resolution is);
   * the class segment itself is matched exactly, which real code satisfies —
   * dotted paths are written to match the on-disk file name.
   *
   * A test suite is no candidate for production code (#2209's rule), and on a
   * tie it yields to the one component outside the test suites (#2650): a
   * TestBox spec mirroring the component's path (`tests/specs/unit/core/
   * basecore.cfc` beside `core/basecore.cfc`) corroborates the same segments,
   * and a mapping root like `contenscms` (onto `contens/`) matches neither.
   *
   * The one exception to corroboration is a path with a single folder segment
   * and a component at the project root (#2652): `wheels.JobWorker` in Wheels'
   * own source, where `wheels` is the mapping onto the root, has no folder of
   * the file's to corroborate. It ranks below any candidate a folder
   * corroborates, and the file must be named like the component.
   */
  private resolveCfmlComponentPath(ref: UnresolvedRef): ResolvedRef | null {
    const cfmlCandidates = (name: string): Node[] =>
      this.context
        .getNodesByName(name)
        .filter(
          (n) =>
            (n.kind === 'class' || n.kind === 'interface') &&
            (n.language === 'cfml' || n.language === 'cfscript')
        );
    const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

    // Relative-path form: `../base`, `./base`, `sub/thing` — resolve against
    // the referencing file's directory and require an exact (case-insensitive)
    // file match.
    if (ref.referenceName.includes('/')) {
      const rel = ref.referenceName.replace(/\.cfc$/i, '');
      const fromDir = ref.filePath.replace(/\\/g, '/').split('/').slice(0, -1);
      const parts = [...fromDir];
      for (const seg of rel.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
          if (parts.length === 0) return null; // escapes the project root
          parts.pop();
        } else {
          parts.push(seg);
        }
      }
      const wantPath = norm(parts.join('/') + '.cfc');
      const className = parts[parts.length - 1];
      if (!className) return null;
      const target = cfmlCandidates(className).find((c) => norm(c.filePath) === wantPath);
      return target
        ? { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'file-path' }
        : null;
    }

    // Dotted form.
    const segments = ref.referenceName.split('.').map((s) => s.trim()).filter(Boolean);
    if (segments.length < 2) return null;
    const className = segments[segments.length - 1]!;
    const dirSegments = segments.slice(0, -1);

    // Production code never names a component in a test suite; a test can
    // name one, by the path to it.
    const fromTest = isTestPath(ref.filePath);
    let bestScore = 0;
    let tied: Node[] = [];
    for (const cand of cfmlCandidates(className)) {
      if (!fromTest && isTestSuitePath(cand.filePath)) continue;
      const dirs = cand.filePath.replace(/\\/g, '/').split('/').slice(0, -1);
      // Count matching directory segments right-to-left: for
      // `coldbox.system.web.Controller` vs `system/web/Controller.cfc`,
      // `web` and `system` match, then the repo root ends the run → score 2.
      let score = 0;
      while (
        score < dirSegments.length &&
        score < dirs.length &&
        dirSegments[dirSegments.length - 1 - score]!.toLowerCase() ===
          dirs[dirs.length - 1 - score]!.toLowerCase()
      ) {
        score++;
      }
      if (
        score === 0 && dirs.length === 0 && dirSegments.length === 1 &&
        cand.filePath.replace(/\.cfc$/i, '').toLowerCase() === className.toLowerCase()
      ) {
        score = 0.5; // a root component, named by the mapping onto the root
      }
      if (score > bestScore) {
        bestScore = score;
        tied = [cand];
      } else if (score === bestScore && score > 0) {
        tied.push(cand);
      }
    }
    // A test's tie between a component and a suite mirroring its path: the
    // path names the component, as it does from production code.
    if (tied.length > 1) tied = tied.filter((c) => !isTestSuitePath(c.filePath));
    if (bestScore === 0 || tied.length !== 1) return null;
    return { original: ref, targetNodeId: tied[0]!.id, confidence: bestScore >= 1 ? 0.9 : 0.8, resolvedBy: 'qualified-name' };
  }

  /**
   * A CFML call chained onto a construction (#2652): `createObject("component",
   * "a.b.Batch").init()` or `new a.b.Batch().init()`, encoded
   * `a.b.Batch().init`. The component is the one its path names, by
   * resolveCfmlComponentPath's rules, or for a bare name the one beside the
   * calling file (where CFML looks first), else the only one of that name. The
   * method is the component's own or one it inherits — inheritance is wired
   * before calls are resolved. Null when either is missing: the bare `init`
   * such a call used to emit matched whichever component's `init` came first.
   */
  private resolveCfmlConstructedCall(ref: UnresolvedRef): ResolvedRef | null {
    const match = CFML_CONSTRUCTED_CALL.exec(ref.referenceName);
    if (!match) return null;
    const component = match[1]!;
    const cls = component.includes('.')
      ? this.nodeById(this.resolveCfmlComponentPath({ ...ref, referenceName: component, referenceKind: 'instantiates' })?.targetNodeId ?? '')
      : this.cfmlComponentByName(component, ref.filePath);
    const method = cls ? this.cfmlMethodOf(cls, match[2]!.toLowerCase(), new Set()) : undefined;
    return method ? { original: ref, targetNodeId: method.id, confidence: 0.9, resolvedBy: 'instance-method' } : null;
  }

  /** The CFML component a bare name reaches from `fromFile`: the one in its directory, else the only one so named. */
  private cfmlComponentByName(name: string, fromFile: string): Node | undefined {
    const components = this.context
      .getNodesByLowerName(name.toLowerCase())
      .filter((n) => (n.kind === 'class' || n.kind === 'interface') && (n.language === 'cfml' || n.language === 'cfscript'));
    const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/') + 1);
    const beside = components.filter((n) => dirOf(n.filePath) === dirOf(fromFile));
    if (beside.length === 1) return beside[0];
    return components.length === 1 ? components[0] : undefined;
  }

  /** A CFML component's method by its lowercased name (CFML names ignore case): its own, else one a supertype has. */
  private cfmlMethodOf(cls: Node, lowerName: string, seen: Set<string>): Node | undefined {
    if (seen.has(cls.id) || seen.size >= 8) return undefined;
    seen.add(cls.id);
    const own = this.context.getNodesInFile(cls.filePath).find((n) =>
      n.kind === 'method' &&
      n.name.toLowerCase() === lowerName &&
      n.qualifiedName.toLowerCase() === `${cls.name}::${n.name}`.toLowerCase() &&
      n.startLine >= cls.startLine && n.endLine <= cls.endLine
    );
    if (own) return own;
    for (const supertype of this.context.getSupertypeNodes?.(cls.id) ?? []) {
      const inherited = this.cfmlMethodOf(supertype, lowerName, seen);
      if (inherited) return inherited;
    }
    return undefined;
  }

  /**
   * The file a CFML include names (#2651) — `include "x.cfm";`,
   * `<cfinclude template="x.cfm">`, `cfinclude(template="x.cfm")`. A template
   * path is relative to the directory of the file that includes it
   * (`formlistshared.cfm`, `../shared/helpers.cfm`), or to the web root when
   * it starts with `/`: the project root, when the project is the web root —
   * an assumption, so such a match is less sure. Null when no indexed file is
   * there. CFML code written on a case-blind file system often spells a path
   * in another case, so a single file that matches ignoring case counts too.
   */
  private resolveCfmlIncludePath(ref: UnresolvedRef): ResolvedRef | null {
    const written = ref.referenceName.trim().replace(/\\/g, '/');
    const fromRoot = written.startsWith('/');
    const parts = fromRoot ? [] : ref.filePath.replace(/\\/g, '/').split('/').slice(0, -1);
    for (const seg of written.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (parts.length === 0) return null; // above the project root
        parts.pop();
      } else {
        parts.push(seg);
      }
    }
    const fileName = parts[parts.length - 1];
    if (!fileName) return null;
    const wanted = parts.join('/');
    const files = this.context.getNodesByLowerName(fileName.toLowerCase()).filter((n) => n.kind === 'file');
    const exact = files.find((n) => n.filePath === wanted);
    if (exact) return { original: ref, targetNodeId: exact.id, confidence: fromRoot ? 0.85 : 0.95, resolvedBy: 'file-path' };
    const folded = files.filter((n) => n.filePath.toLowerCase() === wanted.toLowerCase());
    return folded.length === 1
      ? { original: ref, targetNodeId: folded[0]!.id, confidence: fromRoot ? 0.8 : 0.9, resolvedBy: 'file-path' }
      : null;
  }

  /**
   * Resolve a `this.<member>` function-as-value reference (#756/#808) to the
   * ENCLOSING CLASS's own member — never a same-named symbol elsewhere. The
   * registration idiom (`btn.on('click', this.handleClick)`) names a member
   * of the class being defined, so the only valid target shares the
   * from-symbol's qualified-name scope. Function/method targets only — a
   * property (a data field, post-#808 classification) yields no edge — same
   * file required, no fallback of any kind.
   */
  private resolveThisMemberFnRef(ref: UnresolvedRef): ResolvedRef | null {
    const member = ref.referenceName.slice('this.'.length);
    if (!member) return null;
    const written = this.nodeById(ref.fromNodeId);
    if (!written) return null;
    // Inside an object literal: its own method's `this` is the object, an
    // arrow member's is the method around the literal (#2300).
    const fromNode = thisScopeCaller(written, this.context);
    // A hook declared at class-body level (Ruby `before_action :authenticate`)
    // attributes to the CLASS node itself — its qualified name IS the scope.
    // For members, strip the member segment.
    let classPrefix: string;
    if (SUPERTYPE_BEARING_KINDS.has(fromNode.kind) || fromNode.kind === 'module') {
      classPrefix = fromNode.qualifiedName;
    } else {
      const sep = fromNode.qualifiedName.lastIndexOf('::');
      if (sep <= 0) return null; // not inside a class scope
      classPrefix = fromNode.qualifiedName.slice(0, sep);
    }
    const candidates = this.context
      .getNodesByQualifiedName(`${classPrefix}::${member}`)
      .filter(
        (n) =>
          (n.kind === 'function' || n.kind === 'method') &&
          n.filePath === ref.filePath &&
          n.id !== ref.fromNodeId
      );
    if (candidates.length === 0) {
      // Not on the class itself — possibly INHERITED. implements/extends
      // edges don't exist yet in this pass, so retry in the supertype pass
      // (resolveDeferredThisMemberRefs) instead of giving up.
      this.deferReference(ref, this.deferredThisMemberRefs);
      return null;
    }
    const target = candidates.reduce((a, b) => (a.startLine <= b.startLine ? a : b));
    return {
      original: ref,
      targetNodeId: target.id,
      confidence: 0.95,
      resolvedBy: 'function-ref',
    };
  }

  /**
   * Second pass for `this.<member>` refs whose member wasn't on the enclosing
   * class itself (#808): once implements/extends edges exist, walk the
   * class's supertypes (transitively, depth-capped) and resolve the member on
   * the nearest one that declares it — `this.handleSubmit` registered in a
   * subclass resolves to `FormBase::handleSubmit`. Validated targets only
   * (function/method kind, same language family); no match → no edge.
   * Mirrors resolveChainedCallsViaConformance's lifecycle. Returns the number
   * of newly-created edges.
   */
  async resolveDeferredThisMemberRefs(): Promise<number> {
    const deferred = this.deferredThisMemberRefs;
    this.deferredThisMemberRefs = [];
    if (deferred.length === 0) return 0;

    this.clearCaches();
    // Synchronous main-thread post-pass with a per-ref supertype BFS — yield
    // periodically so the #850 liveness watchdog heartbeat can fire (#1091).
    const maybeYield = createYielder();
    const resolved: ResolvedRef[] = [];
    // Refs share supertypes (every `this.dispose` walks the same chain), and
    // nothing is written until the loop ends: read each type's supertype
    // edges, and each supertype's callable members by name, once.
    const supertypeEdges = new Map<string, Edge[]>();
    const callableMembers = new Map<string, Map<string, Node[]>>();
    const supertypesOf = (id: string): Edge[] => {
      let edges = supertypeEdges.get(id);
      if (!edges) {
        edges = this.queries.getOutgoingEdges(id, ['implements', 'extends']);
        supertypeEdges.set(id, edges);
      }
      return edges;
    };
    const callableMembersOf = (id: string): Map<string, Node[]> => {
      let byName = callableMembers.get(id);
      if (!byName) {
        byName = new Map();
        for (const c of this.queries.getOutgoingEdges(id, ['contains'])) {
          const m = this.nodeById(c.target);
          if (!m || (m.kind !== 'function' && m.kind !== 'method')) continue;
          const list = byName.get(m.name);
          if (list) list.push(m);
          else byName.set(m.name, [m]);
        }
        callableMembers.set(id, byName);
      }
      return byName;
    };
    for (const ref of deferred) {
      await maybeYield();
      const member = ref.referenceName.slice('this.'.length);
      const written = this.nodeById(ref.fromNodeId);
      if (!written || !member) continue;
      const fromNode = thisScopeCaller(written, this.context);
      // Class-body-level hooks (Ruby) attribute to the CLASS node itself.
      let className: string;
      if (SUPERTYPE_BEARING_KINDS.has(fromNode.kind) || fromNode.kind === 'module') {
        className = fromNode.name;
      } else {
        const sep = fromNode.qualifiedName.lastIndexOf('::');
        if (sep <= 0) continue;
        const classPrefix = fromNode.qualifiedName.slice(0, sep);
        className = classPrefix.includes('::')
          ? classPrefix.slice(classPrefix.lastIndexOf('::') + 2)
          : classPrefix;
      }

      // NODE-anchored BFS up the supertype graph: start from the class node
      // in the ref's own file (never a same-named class elsewhere — rails has
      // a dozen `Engine`s), follow implements/extends EDGES to supertype
      // NODES, and look members up through `contains` edges. No name-based
      // unions anywhere — a name-keyed getSupertypes('Engine') merged every
      // Engine's parents and produced a cross-class wrong edge on rails.
      let frontierNodes = this.context
        .getNodesByName(className)
        .filter(
          (n) =>
            SUPERTYPE_BEARING_KINDS.has(n.kind) &&
            n.filePath === ref.filePath
        );
      if (frontierNodes.length === 0) {
        // The class itself may be declared in another file (partial/reopened
        // classes); fall back to same-family nodes of that name.
        frontierNodes = this.context
          .getNodesByName(className)
          .filter(
            (n) =>
              SUPERTYPE_BEARING_KINDS.has(n.kind) &&
              sameLanguageFamily(n.language, ref.language)
          );
      }
      const seenNodes = new Set<string>(frontierNodes.map((n) => n.id));
      let target: Node | null = null;
      for (let depth = 0; depth < 5 && frontierNodes.length > 0 && !target; depth++) {
        const next: Node[] = [];
        for (const typeNode of frontierNodes) {
          for (const edge of supertypesOf(typeNode.id)) {
            const superNode = this.nodeById(edge.target);
            if (!superNode || seenNodes.has(superNode.id)) continue;
            seenNodes.add(superNode.id);
            if (!SUPERTYPE_BEARING_KINDS.has(superNode.kind)) continue;
            // Member lookup anchored on the supertype's contains edges.
            target =
              callableMembersOf(superNode.id)
                .get(member)
                ?.find((m) => sameLanguageFamily(m.language, ref.language)) ?? null;
            if (target) break;
            next.push(superNode);
          }
          if (target) break;
        }
        frontierNodes = next;
      }

      if (target) {
        resolved.push({
          original: ref,
          targetNodeId: target.id,
          confidence: 0.85,
          resolvedBy: 'function-ref',
        });
      }
    }
    return this.persistDeferredReferences(deferred, resolved);
  }

  /**
   * Drop a resolution whose target cannot be what the reference names.
   * Applied at the `resolveOne` seam so it covers every strategy uniformly —
   * framework, import, name-match, chain, CFML component path.
   *
   * For `imports`: the target must be importable. A member that only exists
   * inside a type never is, and neither is the import statement the reference
   * was written in.
   *
   * For a Go type position: the target is a type of the package Go reads the
   * name from, moved there when a strategy found a method, a function or
   * another package's type (see goTypePositionTarget).
   *
   * For `extends`/`implements`, it cannot be describing a real supertype when:
   *
   *  1. The target's kind can never be a supertype (an enum member, a method,
   *     a variable). `matchByExactName` additionally narrows its candidate
   *     pool by the same set, so a legitimate supertype outranks a same-named
   *     non-type rather than merely losing its edge.
   *  2. The name is imported from outside the repo, so NO local node is the
   *     referent. Without this, filtering by kind alone just relocates the
   *     false edge onto the next same-named local type.
   *
   * One exception to (1): a TypeScript VALUE that shares its name with a type
   * in the same file. `export const IFoo = createDecorator<IFoo>('foo')` beside
   * `export interface IFoo` is how VS Code declares every service, and an
   * import of `IFoo` resolves to the file with both — a strategy that takes the
   * first export of that name gets the value. The strategy found the right
   * file and name; the type declared there is the supertype, so the edge moves
   * to it rather than being dropped (dropping it lost ~900 `implements` edges
   * on vscode).
   *
   * Otherwise this only ever REMOVES an edge, never adds one. A dropped ref
   * stays in `unresolved_refs` as `failed`, which is the honest record for a
   * supertype that lives outside the repo — silent beats wrong.
   */
  private gateTargetKind(result: ResolvedRef | null, ref: UnresolvedRef): ResolvedRef | null {
    if (!result) return result;

    // A Go name called or passed bare that the function around it binds
    // itself — a parameter, a `:=`, a `var` — is that binding, never a
    // declaration of the package: client-go's `init := func(…)` then
    // `init(t)` calls no `func init()`.
    if (ref.language === 'go' && (ref.referenceKind === 'calls' || ref.referenceKind === 'function_ref') &&
        isGoBareName(ref, this.context) && isGoLocallyBound(ref, this.context)) return null;

    // A `#define` is a value, never a callee (#1838): a macro defined only in
    // an unrelated file is not what `NAME(x)` here expands to either.
    if (ref.referenceKind === 'calls') {
      const target = this.nodeById(result.targetNodeId);
      if (target?.kind === 'constant' && CPP_DEFINE_SIGNATURE.test(target.signature ?? '')) return null;
      // A Go call made through an expression — `h.Validate().Error()`, a
      // `.Metrics()` chained onto the line above — calls a method of whatever
      // the expression is. A type is called only bare (`T(x)`, `(*T)(x)`) or
      // through its package; as a struct here it read as an instantiation.
      if (target && ref.language === 'go' && GO_TYPE_KINDS.has(target.kind) &&
          !ref.referenceName.includes('.') && !isGoBareName(ref, this.context)) return null;
    }

    // A TypeScript interface or type alias is no value: nothing calls one or
    // makes an instance of it. A strategy that found one by name meant the
    // value its file declares beside it (`interface Ok` and `function Ok` in a
    // result module); with none there, the name is a value from elsewhere
    // that the project only types (`new Response()`, `new Worker()`), and
    // links nothing.
    if ((ref.referenceKind === 'calls' || ref.referenceKind === 'instantiates') && ESM_IMPORT_LANGUAGES.has(ref.language)) {
      const target = this.nodeById(result.targetNodeId);
      if (target && (target.kind === 'interface' || target.kind === 'type_alias')) {
        const value = this.sameNamedValueOfType(target);
        if (!value) return null;
        result = { ...result, targetNodeId: value.id };
      }
    }

    // An `imports` reference names something importable — never a member that
    // only exists inside a type, nor its own import statement. A module path
    // that names no file (`./missing`, `stdio.h`, `pkg.mod`, a C# `using` of
    // an outside namespace) reaches the statement by its qualified name; as an
    // edge to itself it is never retried, while a failed ref is retried by the
    // sync that adds the file it names.
    if (ref.referenceKind === 'imports') {
      const target = this.nodeById(result.targetNodeId);
      if (target?.kind === 'import' && target.filePath === ref.filePath) return null;
      return target && !isImportableKind(target.kind) ? null : result;
    }

    // A Go type declaration — an alias, a defined type, a struct's fields —
    // names its types as an embedding does (below): written through a package
    // that is none of the file's imports as indexed, the type found by its
    // bare name is another package's namesake, or the declaration itself
    // (`op clientv3.Op` beside the file's own `Op`).
    if (ref.language === 'go' && ref.referenceKind === 'references' &&
        GO_TYPE_KINDS.has(this.nodeById(ref.fromNodeId)?.kind ?? '') && isGoUnknownQualified(ref, this.context)) return null;

    // A Go type position — a parameter or result type, a composite literal's
    // type — names a type of the package Go reads it from (route handlers are
    // `references` too, but values).
    if (ref.language === 'go' && (ref.referenceKind === 'instantiates' ||
        (ref.referenceKind === 'references' && this.nodeById(ref.fromNodeId)?.kind !== 'route'))) {
      return goTypePositionTarget(result, ref, this.context);
    }

    if (!isInheritanceRef(ref)) return result;
    const target = this.nodeById(result.targetNodeId);
    if (target && !isSupertypeTarget(target)) {
      const type = this.sameNamedTypeOfValue(target);
      if (!type) return null;
      result = { ...result, targetNodeId: type.id };
    }
    if (isBoundToOutOfRepoImport(ref, this.context)) return null;
    // A Go type embedded through a package (`clientv3.KV`) is that package's.
    // When the package is none of the file's imports as indexed (clientv3
    // imported unaliased as `go.etcd.io/etcd/client/v3`), a type found by its
    // bare name is some other package's namesake.
    if (ref.language === 'go' && isGoUnknownQualified(ref, this.context)) return null;
    // One embedded bare that only a package the file dot-imports declares is
    // that package's, not a namesake as near the file.
    if (ref.language === 'go') return goDotImportedSupertype(result, ref, this.context);
    return result;
  }

  /**
   * `super.didMoveToWindow()` inside an override of `didMoveToWindow` calls
   * the PARENT's implementation, never the method making the call. Extraction
   * keeps a `super` call under the bare method name, so every strategy found
   * the enclosing method itself: one expo-camera view had eleven of its
   * overrides "calling" themselves. The parent's method is usually a
   * framework's (UIKit, Android, React); a self-edge is never it. Real
   * recursion keeps its edge — only a call written through `super` / `base`
   * (C#) / `[super …]` (Objective-C) / `parent::` (PHP) / `super().` (Python)
   * is declined.
   */
  private gateSuperSelfCall(result: ResolvedRef | null, ref: UnresolvedRef): ResolvedRef | null {
    if (!result || ref.referenceKind !== 'calls' || result.targetNodeId !== ref.fromNodeId) return result;
    // A TS/JS call is read where it starts, so a `this.run()` that shares its
    // line with a `super.run()` keeps its edge (#2497).
    if (isJsSuperCallLanguage(ref.language)) return isJsSuperCallSite(ref, this.context) ? null : result;
    const name = ref.referenceName.slice(Math.max(ref.referenceName.lastIndexOf('.'), ref.referenceName.lastIndexOf(':')) + 1);
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return result;
    const line = (this.context.getFileLines?.(ref.filePath) ?? this.context.readFile(ref.filePath)?.split(/\r?\n/))?.[ref.line - 1];
    if (!line) return result;
    const escaped = name.replace(/\$/g, '\\$');
    const viaSuper = new RegExp(
      String.raw`(?:\b(?:super|base)\s*(?:\(\s*(?:[\w.]+\s*,\s*\w+)?\s*\))?\s*\??\.\s*|\[\s*super\s+|\bparent\s*::\s*)` + escaped + String.raw`\b`,
    );
    return viaSuper.test(line) ? null : result;
  }

  /**
   * A bare Rust name reaches only what is in scope — every strategy's result,
   * a framework resolver's `Ok(x)` → `struct Ok` construction included (see
   * isRustNameInScope). A call through a path whose type is from outside the
   * project reaches only the project's impls for that type (or of that trait,
   * isRustPathCallReachable). And a call, however written, reaches a project
   * impl on a std type only as Rust would pick it (isRustForeignImplCallable).
   */
  private gateRustScope(result: ResolvedRef | null, ref: UnresolvedRef): ResolvedRef | null {
    if (!result || ref.language !== 'rust') return result;
    const bare = /^[A-Za-z_]\w*$/.test(ref.referenceName);
    if (!bare && ref.referenceKind !== 'calls') return result;
    const target = this.nodeById(result.targetNodeId);
    if (!target) return result;
    if (bare && !isRustNameInScope(target, ref, this.context)) return null;
    if (ref.referenceKind !== 'calls') return result;
    if (!bare && !isRustPathCallReachable(target, ref, this.context)) return null;
    return isRustForeignImplCallable(target, ref, this.context) ? result : null;
  }

  /**
   * The context production code is resolved in when the project has Jest or
   * Vitest manual mocks (`__mocks__/`): the graph without them. A mock
   * re-declares its module's names by design and stands in for the module
   * only while a test runs, so production code means what it would mean were
   * the mocks not there (#2455): `formatLabel(name)`, whose import of a
   * workspace package was not followed, is the package's `formatLabel`, never
   * the nearer mock's. Adding or deleting a mock then changes nothing for
   * production code, as a fresh index would have it. Test code, a mock
   * included, keeps the whole graph: a mock is what Jest hands it. Null when
   * the whole graph applies.
   */
  private mocklessContextFor(ref: UnresolvedRef, base: ResolutionContext): ResolutionContext | null {
    if (isTestPath(ref.filePath)) return null;
    const mocks = this.manualMockNames();
    if (!mocks) return null;
    if (this.mocklessContext && this.mocklessBase === base) return this.mocklessContext;
    const isMock = (n: Node): boolean => isManualMockPath(n.filePath);
    const real = (nodes: Node[]): Node[] => (nodes.some(isMock) ? nodes.filter((n) => !isMock(n)) : nodes);
    // Only a name some mock declares can lose a node: other lookups pass
    // straight through, and the filtered answers are kept.
    const byName = new Map<string, Node[]>();
    const byLowerName = new Map<string, Node[]>();
    const byKind = new Map<Node['kind'], Node[]>();
    const getMethodMatches = base.getMethodMatches;
    const iterateNodesByKind = base.iterateNodesByKind;
    this.mocklessBase = base;
    this.mocklessContext = {
      ...base,
      getNodesByName: (name) => {
        if (!mocks.names.has(name)) return base.getNodesByName(name);
        let nodes = byName.get(name);
        if (!nodes) byName.set(name, (nodes = real(base.getNodesByName(name))));
        return nodes;
      },
      getNodesByLowerName: (lowerName) => {
        if (!mocks.lowerNames.has(lowerName)) return base.getNodesByLowerName(lowerName);
        let nodes = byLowerName.get(lowerName);
        if (!nodes) byLowerName.set(lowerName, (nodes = real(base.getNodesByLowerName(lowerName))));
        return nodes;
      },
      getNodesByQualifiedName: (qualifiedName) => real(base.getNodesByQualifiedName(qualifiedName)),
      getNodesByKind: (kind) => {
        let nodes = byKind.get(kind);
        if (!nodes) byKind.set(kind, (nodes = real(base.getNodesByKind(kind))));
        return nodes;
      },
      getMethodMatches: getMethodMatches
        ? (typeName, methodName, language) => {
          const nodes = getMethodMatches(typeName, methodName, language);
          return mocks.names.has(methodName) ? real(nodes) : nodes;
        }
        : undefined,
      iterateNodesByKind: iterateNodesByKind
        ? function* (kind) {
          for (const n of iterateNodesByKind(kind)) if (!isMock(n)) yield n;
        }
        : undefined,
    };
    return this.mocklessContext;
  }

  /** Built on first use from `mocklessBase`; clearCaches drops it, and the memos keyed by it go with it. */
  private mocklessContext: ResolutionContext | null = null;
  private mocklessBase: ResolutionContext | null = null;
  /** The names the project's manual mocks declare, null when it has none; read once per cache window. */
  private manualMocks: { names: Set<string>; lowerNames: Set<string> } | null | undefined;

  private manualMockNames(): { names: Set<string>; lowerNames: Set<string> } | null {
    if (this.manualMocks !== undefined) return this.manualMocks;
    const files = [...(this.knownFiles ?? this.queries.getAllFilePaths())].filter(isManualMockPath);
    const names = new Set<string>();
    const lowerNames = new Set<string>();
    if (files.length > 0) {
      for (const n of this.queries.getNodesByFiles(files)) {
        names.add(n.name);
        lowerNames.add(n.name.toLowerCase());
      }
    }
    this.manualMocks = names.size > 0 ? { names, lowerNames } : null;
    return this.manualMocks;
  }

  /**
   * The context a TS/JS reference is resolved in outside the named class
   * expressions (#2499): one without the classes they declare or their
   * members. An expression's name is bound inside it alone, and its class's
   * value travels in ways resolution doesn't follow. So outside, a reference
   * means what it would were those classes not indexed, with the confidence
   * it had: `const Panel = class Panel {…}` keeps `new Panel()` on the
   * constant, an interface beside a same-named class expression keeps its
   * typed calls, and an `HTMLElement` type stays clear of lit's
   * `HTMLElementShim = class HTMLElement {…}`. A class a CommonJS module
   * exports isn't among them (classExpressions). Null inside a class
   * expression, where the whole graph applies.
   */
  private classExpressionFreeContextFor(ref: UnresolvedRef, base: ResolutionContext): ResolutionContext | null {
    if (!CLASS_EXPRESSION_REF_LANGUAGES.has(ref.language)) return null;
    const expressions = this.classExpressions();
    if (!expressions) return null;
    const dot = ref.referenceName.indexOf('.');
    const named = expressions.byName.get(dot > 0 ? ref.referenceName.slice(0, dot) : ref.referenceName);
    // Written in a class expression, a reference sees its class and the
    // classes around it, as JavaScript scopes them, unless it names another
    // one, which is bound only inside that one.
    const inside = expressions.byFile.get(ref.filePath)?.some((n) => writtenIn(n, ref)) ?? false;
    if (inside && !(named && !named.some((n) => writtenIn(n, ref)))) return null;
    let view = this.classExpressionFreeViews.get(base);
    if (!view) {
      view = this.classExpressionFreeView(base);
      this.classExpressionFreeViews.set(base, view);
      this.classExpressionFreeBases.set(view, base);
    }
    return view;
  }

  /**
   * `base` without the classes class expressions declare and their members.
   * The lookups an import reads a module's exports by (getNodesInFileNamed,
   * getExportedNodesInFile) are left whole.
   */
  private classExpressionFreeView(base: ResolutionContext): ResolutionContext {
    const { hiddenIds } = this.classExpressions()!;
    const hidden = (n: Node): boolean => hiddenIds.has(n.id);
    const keep = (nodes: Node[]): Node[] => (nodes.some(hidden) ? nodes.filter((n) => !hidden(n)) : nodes);
    const byKind = new Map<Node['kind'], Node[]>();
    const getMethodMatches = base.getMethodMatches;
    const iterateNodesByKind = base.iterateNodesByKind;
    const { files } = this.classExpressions()!;
    return {
      ...base,
      getNodesByName: (name) => keep(base.getNodesByName(name)),
      getNodesByLowerName: (lowerName) => keep(base.getNodesByLowerName(lowerName)),
      getNodesByQualifiedName: (qualifiedName) => keep(base.getNodesByQualifiedName(qualifiedName)),
      getNodesInFile: (filePath) => (files.has(filePath) ? keep(base.getNodesInFile(filePath)) : base.getNodesInFile(filePath)),
      getNodesByKind: (kind) => {
        let nodes = byKind.get(kind);
        if (!nodes) byKind.set(kind, (nodes = keep(base.getNodesByKind(kind))));
        return nodes;
      },
      getMethodMatches: getMethodMatches
        ? (typeName, methodName, language) => keep(getMethodMatches(typeName, methodName, language))
        : undefined,
      iterateNodesByKind: iterateNodesByKind
        ? function* (kind) {
          for (const n of iterateNodesByKind(kind)) if (!hidden(n)) yield n;
        }
        : undefined,
    };
  }

  /** classExpressionFreeContextFor's views, by the context each hides from and what it hides, and each view's context; clearCaches drops both. */
  private classExpressionFreeViews = new WeakMap<ResolutionContext, ResolutionContext>();
  private classExpressionFreeBases = new WeakMap<ResolutionContext, ResolutionContext>();
  /**
   * The names that only class expressions' classes and members carry, which
   * name nothing where classExpressionFreeView hides those: lit's DOM shims
   * (`class HTMLElement`, `class Event`) would otherwise send every
   * `HTMLElement` and `new Event()` across the project through the whole
   * resolution only to find nothing, where before the name pre-filter
   * dropped them. Read once per cache window.
   */
  private classExpressionOnlyNames(): Set<string> {
    if (this.classExpressionOnlyNameSet) return this.classExpressionOnlyNameSet;
    const only = new Set<string>();
    const expressions = this.classExpressions();
    if (expressions) {
      const names = new Set<string>();
      for (const id of expressions.hiddenIds) {
        const n = this.nodeById(id);
        if (n) names.add(n.name);
      }
      for (const name of names) {
        if (!this.queries.getNodesByName(name).some((n) => !expressions.hiddenIds.has(n.id))) only.add(name);
      }
    }
    this.classExpressionOnlyNameSet = only;
    return only;
  }

  /** classExpressionOnlyNames' answer; clearCaches drops it. */
  private classExpressionOnlyNameSet: Set<string> | null = null;

  /**
   * The classes named class expressions declare: by name, the files holding
   * them, the ids of them and their members, and the one a member belongs
   * to. Null when there are none. Read once per cache window. A class a
   * CommonJS module exports is left out: the module binds it, so it is read
   * as a declaration is.
   */
  private classExpressionIndex: ClassExpressionIndex | null | undefined;

  private classExpressions(): ClassExpressionIndex | null {
    if (this.classExpressionIndex !== undefined) return this.classExpressionIndex;
    const byName = new Map<string, Node[]>();
    const byFile = new Map<string, Node[]>();
    const byKey = new Map<string, Node>();
    const files = new Set<string>();
    const hiddenIds = new Set<string>();
    const linesOf = (file: string): readonly string[] =>
      this.context.getFileLines?.(file) ?? this.context.readFile(file)?.split(/\r?\n/) ?? [];
    for (const n of this.queries.getNodesByKind('class')) {
      if (!isJsClassExpression(n) || isCommonJsExportedClass(n, linesOf(n.filePath))) continue;
      const named = byName.get(n.name);
      if (named) named.push(n); else byName.set(n.name, [n]);
      const inFile = byFile.get(n.filePath);
      if (inFile) inFile.push(n); else byFile.set(n.filePath, [n]);
      byKey.set(`${n.filePath}\0${n.qualifiedName}`, n);
      files.add(n.filePath);
      hiddenIds.add(n.id);
    }
    // A member is its class's when it is declared in its file under its
    // qualified name (`Widget::run` of `Widget`).
    const ownerOf = (member: Node): Node | undefined => {
      const cut = member.qualifiedName.lastIndexOf('::');
      return cut > 0 ? byKey.get(`${member.filePath}\0${member.qualifiedName.slice(0, cut)}`) : undefined;
    };
    if (files.size > 0) {
      for (const n of this.queries.getNodesByFiles([...files])) {
        if ((n.kind === 'method' || n.kind === 'property' || n.kind === 'field') && ownerOf(n)) hiddenIds.add(n.id);
      }
    }
    this.classExpressionIndex = byName.size > 0 ? { byName, byFile, files, hiddenIds, ownerOf } : null;
    return this.classExpressionIndex;
  }

  /** Is `filePath` (project-relative) one of the files the index holds? */
  private isIndexedFile(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    return this.knownFiles ? this.knownFiles.has(normalized) : this.queries.getFileByPath(normalized) !== null;
  }

  /** The repository's own package name, from its root package.json; null without one. */
  /** Per directory: the package names its package.json and every enclosing one own and depend on. */
  private manifestScopes = new Map<string, { own: Set<string>; deps: Set<string> }>();

  /**
   * Is `source` a package from outside the repository? Only when the importing
   * file's package.json (or an enclosing one) declares it, or it is a Node
   * built-in or a runtime's virtual module. A specifier nothing declares is
   * an alias this resolver does not know — SvelteKit's `$lib/…`, Nuxt's
   * `~/…`, a nested app's own `@/…` — and stays the project's.
   */
  private isDeclaredOutsidePackage(source: string, fromFile: string): boolean {
    // Deno's standard library is `@std/…` from JSR.
    if (/^(?:node|bun|jsr|npm|https?):/.test(source) || source.startsWith('@std/') || NODE_BUILTINS.has(source)) return true;
    const name = source.startsWith('@') ? source.split('/').slice(0, 2).join('/') : source.split('/')[0]!;
    const normalized = fromFile.replace(/\\/g, '/');
    const scope = this.manifestScope(normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '');
    if (scope.own.has(name)) return false;
    if (scope.deps.has(name)) return true;
    // SvelteKit's `$app/…` and Astro's `astro:…` belong to the framework —
    // unless this repository is that framework.
    const provider = source.startsWith('astro:') ? 'astro' : /^\$(?:app|env|service-worker)(?:\/|$)/.test(source) ? '@sveltejs/kit' : null;
    return provider !== null && !scope.own.has(provider) && !this.context.getWorkspacePackages?.()?.byName.has(provider);
  }

  private manifestScope(dir: string): { own: Set<string>; deps: Set<string> } {
    const memo = this.manifestScopes.get(dir);
    if (memo) return memo;
    const parent = dir === '' ? null : this.manifestScope(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '');
    let scope = parent ?? { own: new Set<string>(), deps: new Set<string>() };
    try {
      const json = JSON.parse(this.context.readFile(dir ? `${dir}/package.json` : 'package.json') ?? 'null') as Record<string, unknown> | null;
      if (json && typeof json === 'object') {
        scope = { own: new Set(scope.own), deps: new Set(scope.deps) };
        if (typeof json.name === 'string' && json.name.length > 0) scope.own.add(json.name);
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          const deps = json[field];
          if (!deps || typeof deps !== 'object') continue;
          for (const [dep, version] of Object.entries(deps)) {
            // `workspace:*`, `file:../shared`, `link:…`: a package in this repository.
            if (typeof version === 'string' && /^(?:workspace|file|link|portal):/.test(version)) scope.own.add(dep);
            else scope.deps.add(dep);
          }
        }
      }
    } catch { /* no or unreadable package.json */ }
    // A Deno import map names packages the same way — an entry that maps to a
    // registry or a URL, not one that maps to a path in the repository.
    for (const file of ['deno.json', 'deno.jsonc']) {
      const raw = this.context.readFile(dir ? `${dir}/${file}` : file);
      if (!raw) continue;
      const json = parseJsonc(raw) as { imports?: Record<string, unknown> } | undefined;
      const imports = json && typeof json === 'object' ? json.imports : undefined;
      if (!imports || typeof imports !== 'object') continue;
      for (const [key, target] of Object.entries(imports)) {
        if (typeof target !== 'string' || !/^(?:jsr|npm|https?):/.test(target)) continue;
        if (scope === parent) scope = { own: new Set(scope.own), deps: new Set(scope.deps) };
        scope.deps.add(key.replace(/\/$/, ''));
      }
    }
    this.manifestScopes.set(dir, scope);
    return scope;
  }

  /** The one supertype-kind node a TypeScript value shares its name and file with. */
  /**
   * The value a file declares beside a type of the same name — `export
   * function Ok()` beside `export interface Ok`, a class merged with an
   * interface — which a call or `new` written with the name reaches. The
   * first by position; null when the file declares none.
   */
  private sameNamedValueOfType(type: Node): Node | null {
    return this.context
      .getNodesInFile(type.filePath)
      .filter((n) => n.name === type.name && TYPE_COMPANION_VALUE_KINDS.has(n.kind))
      .sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn)[0] ?? null;
  }

  private sameNamedTypeOfValue(value: Node): Node | null {
    if (value.kind !== 'constant' && value.kind !== 'variable') return null;
    if (value.language !== 'typescript' && value.language !== 'tsx') return null;
    const types = this.context
      .getNodesInFile(value.filePath)
      .filter((n) => n.name === value.name && isSupertypeTarget(n));
    return types.length === 1 ? types[0]! : null;
  }

  private gateLanguage(result: ResolvedRef | null, ref: UnresolvedRef): ResolvedRef | null {
    if (!result) return result;
    return gateLanguageMatch(result, ref, this.context);
  }

  /**
   * Framework calls carry bridge evidence (RN/Expo JS → native). Other
   * framework results obey the same code-family boundary as name matches;
   * markup/config transitions remain open.
   */
  private gateFrameworkLanguage(result: ResolvedRef | null, ref: UnresolvedRef): ResolvedRef | null {
    if (!result) return result;
    if (ref.referenceKind === 'calls') return result;
    const tgt = this.getLanguageFromNodeId(result.targetNodeId);
    // Package imports cannot target prose found by a framework's name lookup.
    if (ref.referenceKind === 'imports' && (tgt as string) === 'markdown' && (ref.language as string) !== 'markdown') return null;
    if (tgt && ref.language && crossesCodeBoundary(tgt, ref.language)) return null;
    return result;
  }
}

/**
 * Whether a CFML `imports` name is the path of a template an include names
 * (`formlistshared.cfm`, `../shared/helpers.cfm`, `/app/x.cfm`), not a
 * cfscript `import com.foo.Bar;` or `import "java:…";` (#2651).
 */
function isCfmlTemplatePath(name: string): boolean {
  return !name.includes(':') && (name.includes('/') || name.includes('\\') || /\.(?:cfml?|cfc|cfs)$/i.test(name.trim()));
}

/** The project-relative directory holding `p` ('' for the project root). */
function goDirOf(p: string): string {
  const dir = path.posix.dirname(p.replace(/\\/g, '/'));
  return dir === '.' || dir === '/' ? '' : dir;
}

/**
 * The routes a sync added, removed or renamed: `before` is every route node
 * before the sync changed a file, `after` every one after its post-extract
 * pass, and a route whose file and path are on one side only changed. A route
 * renamed in place — the same node under a new path — is in the result twice,
 * as its old self and its new one.
 */
export function changedRoutes(before: readonly Node[], after: readonly Node[]): Node[] {
  const key = (route: Node): string => `${route.filePath}\0${route.name}`;
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  return [...before.filter((route) => !afterKeys.has(key(route))), ...after.filter((route) => !beforeKeys.has(key(route)))];
}

/**
 * Create a reference resolver instance
 */
export function createResolver(projectRoot: string, queries: QueryBuilder): ReferenceResolver {
  const resolver = new ReferenceResolver(projectRoot, queries);
  resolver.initialize();
  return resolver;
}
