/**
 * AOSP extension — AIDL interface implementation discovery.
 *
 * Ports the Connect Built-in Apps audit's validated PoC
 * (docs/poc/find_aidl_impl_codegraph.py in the audit workspace) onto
 * CodeGraph's own indexed graph, rather than a fresh AIDL grammar.
 *
 * CodeGraph does not parse `.aidl` files (they carry no language extractor),
 * so an AIDL interface like `IFoo` never becomes a node. But when a Kotlin/Java
 * class declares `: IFoo.Stub()` or `: IFoo`, CodeGraph's extractor still
 * records that extends/implements clause — it just can't resolve the target,
 * so it lands in `unresolved_refs` instead of becoming an edge. That failed
 * resolution is a *more* reliable "who implements this AIDL interface?" signal
 * than name-pattern matching: it fires even when the implementing class's own
 * name carries no hint of the interface (e.g. `ValetModeLogicServiceBinder`
 * implementing `IValetModeService`), which pure substring search on `nodes.name`
 * would miss entirely (verified against a synthetic fixture during the PoC).
 *
 * Naming-convention search (`{Name}.Stub`, `{Name}Impl`, ...) and an
 * `addService`-pattern scan over CodeGraph's own indexed source list are kept
 * as secondary evidence — the same technique opengrok-aosp-mcp's
 * `find_aidl_impl` uses, but scoped to files CodeGraph actually parsed rather
 * than a blind full-text index.
 *
 * Limitation: Kotlin import aliases (`import foo.IBar as IBaz`) and top-level
 * `typealias` declarations are not resolved here. CodeGraph's core records the
 * original extends/implements token, so aliases can bypass all three signals
 * (unresolved_refs, naming conventions, and addService text) without a core
 * extractor change; resolving them is outside this AOSP extension's scope.
 */
import * as fs from 'fs';
import * as path from 'path';
import type CodeGraph from '../index';
import type { NodeKind } from '../types';
import { grepIndexedSources, escapeRegExp, candidateReachesPackagedSymbol, stripCLikeComments, indexingCaveat, findMatchingBraceEnd, testPathEvidence, walkDeclarationFiles, DECLARATION_WALK_MAX_DEPTH, DECLARATION_WALK_MAX_ENTRIES } from './common';
import type { PackageReachability } from './common';

export interface AidlDeclaration {
  /** Path to the .aidl file, relative to repoRoot. */
  filePath: string;
  /** 1-based line of the `interface Name {` declaration. */
  line: number;
  /** Method names declared in the interface body. */
  methods: string[];
  /**
   * The declaration's `package` clause (e.g. `android.hardware.foo`), or
   * null if the file has no `package` line or it couldn't be parsed. Used
   * to disambiguate two same-named interfaces in different packages — see
   * `candidateReachesPackagedSymbol` in common.ts.
   */
  packageName: string | null;
  /**
   * HIDL-only: the `@major.minor` version suffix (e.g. "1.0"), if present.
   * HIDL's generated Java import inserts this as a version sub-package
   * (`{packageName}.V{major}_{minor}.{InterfaceName}`), which is why
   * `packageName` alone isn't enough to build the FQCN a real HIDL Java
   * implementation would import — see hal.ts's use of this via
   * `candidateReachesPackagedSymbol`'s `alternateFqcns` parameter.
   */
  packageVersion?: { major: string; minor: string };
}

export type AospCandidateKind =
  | 'stub_subclass'
  | 'impl_by_interface'
  | 'impl_by_name'
  | 'service_registration'
  // Structural text-pattern evidence found inside a specific, already-matched
  // class's own body — `new Messenger(...)`, `new LocalSocket(...)`,
  // `new LocalServerSocket(...)` — used by messenger.ts and local_socket.ts.
  // Distinct from `service_registration` (a repo-wide grep hit with no class
  // scoping) because these ARE scoped to one class's line range.
  | 'ipc_pattern_match';

export interface AospCandidate {
  kind: AospCandidateKind;
  nodeKind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  line: number;
  matchedPattern: string;
  /**
   * Whether the candidate's file can actually reach the declaration's
   * package (via a matching import or same-package membership) —
   * `'unverifiable'` when the declaration's package couldn't be determined
   * (not contradicted, just unchecked — this MUST surface in evidence, not
   * be silently treated as equivalent to a real check). Only `'mismatch'`
   * should ever lower confidence; `'verified'`/`'unverifiable'` are both
   * treated as "no reason to doubt this" for status purposes.
   *
   * hal.ts's `Bn{Name}` C++ Binder-native stub candidates are ALWAYS
   * `'unverifiable'` here, even when the declaration's package IS known —
   * a C++ file has no `import` to check, so there is no way to establish
   * `'verified'` or `'mismatch'` for it regardless. Callers must not read
   * `'unverifiable'` as "declaration package unknown" alone; for this kind
   * of candidate it also means "this language has no reachability check at
   * all." hal.ts deliberately keeps these candidates out of the pool that
   * can promote a result to `found` (see `findHalInterface`) precisely
   * because this flag alone cannot distinguish a real generated stub from
   * an unrelated same-named class.
   */
  packageVerified?: PackageReachability;
}

export type FindAidlImplStatus =
  | 'found' // an extends/implements clause named this interface and failed to resolve — the strongest signal
  | 'convention_derived_candidate' // a naming-convention match, an addService hit, or (hal.ts only) a Bn{Name} Binder-native stub name match with no further correlation — never promoted to "found" alone
  | 'no_implementation_found'
  | 'declaration_not_found';

export interface FindAidlImplResult {
  interfaceName: string;
  declaration: AidlDeclaration | null;
  implementations: AospCandidate[];
  registrations: AospCandidate[];
  evidence: string[];
  status: FindAidlImplStatus;
}

// Unicode-aware identifier: AIDL/Java identifiers permit any Unicode letter,
// not just ASCII — `\w` silently dropped every non-ASCII interface name
// (e.g. a Korean `I가나다`) from `parseAidlDeclarations`/`AIDL_PACKAGE_RE`
// below (self-review finding, 2026-09-05, verified live against a Korean
// fixture). `\b` itself stays ASCII-word-boundary under the `u` flag by
// spec, which is fine here — the preceding literal `interface` keyword is
// itself ASCII, so the boundary check still does its job.
const AIDL_INTERFACE_RE = /\binterface\s+([\p{L}\p{N}_$]+)\s*\{/gu;
// AIDL method declarations: `<returnType> name(<params>);`, optional `oneway`.
const AIDL_METHOD_RE = /^\s*(?:oneway\s+)?[\w<>[\],.\s]+?\s+([\p{L}\p{N}_$]+)\s*\([^;{]*\)\s*;/gmu;
const AIDL_PACKAGE_RE = /^\s*package\s+([\p{L}\p{N}_.]+)\s*;/mu;
// NOT a general-purpose "vendored third-party code" ignore list — this is an
// AOSP-specific walker, and `vendor/` in an AOSP tree is a first-class,
// heavily-populated source directory (the Treble vendor partition: OEM HALs,
// vendor AIDL contracts, etc.), not vendored dependency code to skip. The
// previous version copied a generic JS/TS project's ignore list wholesale
// and silently excluded every vendor-tree AIDL declaration — an interface
// that's genuinely declared and implemented under `vendor/` reported
// `declaration_not_found`, which an agent could misread as "unused, safe to
// delete" (Black Hat round-4 finding, 2026-09-05).
//
// This only fixes the DECLARATION side. CodeGraph's own core indexer
// (`directory.ts`, `extraction/index.ts`) ignores `vendor/` by default for
// EVERY language, independent of this aosp extension — a Kotlin/Java class
// under `vendor/` still never becomes an `unresolved_refs` hit no matter
// what `findAidlFiles` discovers, so `find_aidl_impl` can now locate the
// `.aidl` declaration itself but may still under-report a vendor-tree
// implementation. Changing that is a core indexing-policy decision (it
// would affect every language, not just AOSP), out of this extension's
// scope — flagged here rather than silently accepted.
const IGNORED_DIR_NAMES = new Set([
  'node_modules', '.git', 'build', '.codegraph', 'out', '.gradle', '.idea', 'bin', 'dist',
]);
const CANDIDATE_NODE_KINDS: NodeKind[] = ['class', 'interface'];
export const AIDL_WALK_MAX_DEPTH = DECLARATION_WALK_MAX_DEPTH;
export const AIDL_WALK_MAX_ENTRIES = DECLARATION_WALK_MAX_ENTRIES;
export interface AidlWalkLimits { maxDepth?: number; maxEntries?: number; }

/**
 * Parse every `.aidl` declaration named `interfaceName` in the repo — not
 * just the first file-system-order match. Two different packages
 * declaring the same bare interface name is a real AOSP shape (versioned
 * HAL directories, or an app-level AIDL happening to share a HAL's name),
 * and picking the wrong one silently compared an unrelated declaration
 * against the real implementation, producing a nonsensical "package
 * mismatch" verdict (self-review finding, 2026-09-05, following up on
 * Blue Team's 2nd-round finding). Comments are stripped before matching so
 * a documentation example or a commented-out stale declaration can never
 * be mistaken for the file's real interface (2nd self-review round:
 * `IWrongDecoy` commented out above a real `ICommented` interface returned
 * `ICommented`'s methods/line/package under `IWrongDecoy`'s name — a data
 * bleed, not just a miss).
 */
function parseAidlDeclarationsWithWalk(repoRoot: string, interfaceName: string, limits: AidlWalkLimits = {}): { declarations: AidlDeclaration[]; truncated: boolean } {
  const declarations: AidlDeclaration[] = [];
  const walk = walkDeclarationFiles(repoRoot, '.aidl', IGNORED_DIR_NAMES, limits);
  for (const aidlFile of walk.files) {
    let rawText: string;
    try {
      rawText = fs.readFileSync(aidlFile, 'utf-8');
    } catch {
      continue;
    }
    const text = stripCLikeComments(rawText);
    AIDL_INTERFACE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = AIDL_INTERFACE_RE.exec(text)) !== null) {
      if (match[1] !== interfaceName) continue;

      // Scope the method scan to THIS interface's body (from its opening
      // `{`, consumed by the match above, to its matching closing `}`).
      // Scanning the whole file here (the original behavior) mixed a second
      // interface's methods into the first when a file declared more than
      // one, e.g. querying the second interface in a two-interface file
      // returned both interfaces' method lists concatenated (self-review
      // finding, 2026-09-05, surfaced by adding multi-declaration support
      // above). A plain `indexOf('}', bodyStart)` (the first fix) assumed
      // AIDL bodies never nest braces — but a nested `enum`/`parcelable`/
      // `union` declared inside the interface has its own `{ ... }`, and
      // that assumption truncated the body at the INNER closing brace,
      // silently dropping every real method after it (Red Team round-4
      // finding, 2026-09-05) — brace-depth tracking via
      // `findMatchingBraceEnd` finds the actual matching close instead.
      const bodyStart = match.index + match[0].length;
      const bodyEnd = findMatchingBraceEnd(text, bodyStart);
      const body = bodyEnd === -1 ? text.slice(bodyStart) : text.slice(bodyStart, bodyEnd);

      const methods: string[] = [];
      AIDL_METHOD_RE.lastIndex = 0;
      let methodMatch: RegExpExecArray | null;
      while ((methodMatch = AIDL_METHOD_RE.exec(body)) !== null) {
        const name = methodMatch[1];
        if (name) methods.push(name);
      }

      const packageMatch = AIDL_PACKAGE_RE.exec(text);
      declarations.push({
        filePath: path.relative(repoRoot, aidlFile),
        line: text.slice(0, match.index).split('\n').length,
        methods,
        packageName: packageMatch?.[1] ?? null,
      });
    }
  }
  return { declarations, truncated: walk.truncated };
}

export function parseAidlDeclarations(repoRoot: string, interfaceName: string, limits: AidlWalkLimits = {}): AidlDeclaration[] {
  return parseAidlDeclarationsWithWalk(repoRoot, interfaceName, limits).declarations;
}

/** Single-declaration convenience wrapper — kept for callers (e.g. hal.ts's
 * declaration-lookup pattern before it grew its own multi-decl path) that
 * only ever want "the first match, if any." New call sites should prefer
 * `parseAidlDeclarations` and pick a specific one deliberately.
 */
export function parseAidlDeclaration(repoRoot: string, interfaceName: string): AidlDeclaration | null {
  return parseAidlDeclarations(repoRoot, interfaceName)[0] ?? null;
}

/**
 * Primary signal: classes/interfaces whose extends/implements clause named
 * `interfaceName` but couldn't resolve to a node (because it's an AIDL type,
 * not a Kotlin/Java one).
 */
export function findUnresolvedExtendsCandidates(
  cg: CodeGraph,
  interfaceName: string,
  packageName: string | null,
  alternateFqcns: string[] = []
): AospCandidate[] {
  const candidates: AospCandidate[] = [];
  for (const ref of cg.getUnresolvedReferencesByQualifiedName(interfaceName)) {
    if (ref.referenceKind !== 'extends' && ref.referenceKind !== 'implements') continue;
    const node = cg.getNode(ref.fromNodeId);
    if (!node) continue;
    const packageVerified = candidateReachesPackagedSymbol(cg, node.filePath, packageName, interfaceName, alternateFqcns);
    candidates.push({
      kind: ref.referenceKind === 'extends' ? 'stub_subclass' : 'impl_by_interface',
      nodeKind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName,
      filePath: node.filePath,
      line: node.startLine,
      matchedPattern: `unresolved ${ref.referenceKind} -> ${ref.referenceName}`,
      packageVerified,
    });
  }
  return candidates;
}

/**
 * Secondary signal: AOSP naming convention (`{Name}Stub`, `{Name}Impl`, ...)
 * matched against CodeGraph's own indexed symbol search. Covers cases the
 * unresolved-extends signal misses (e.g. the interface reference itself was
 * fully qualified and resolved differently).
 *
 * `cg.searchNodes()` is FTS/LIKE/fuzzy, not exact-match — a bare substring
 * hit here (e.g. `IFooImplHelper` for pattern `IFooImpl`) is not evidence of
 * an implementation. Every candidate is filtered down to `node.name ===
 * pattern` (code review finding, 2026-09-04) before being kept, matching the
 * same exact-match discipline find_jni_bridge already applies on its native
 * side. The dotted forms (`{Name}.Stub`, `{Name}.Proxy`) are dropped
 * entirely: a top-level class can't literally be named with a dot, so they
 * never produced a real exact match — that shape is what the primary
 * unresolved_refs signal already covers (`class Foo : IBar.Stub()`).
 *
 * Also tries the bare name with a leading `I` dropped (`IFoo` -> `FooImpl`)
 * — the AOSP convention hal.ts's native-impl search already applied, but
 * this Kotlin/Java naming-convention search never did, so `FooImpl` (far
 * more common in practice than `IFooImpl`) went entirely unmatched (Blue
 * Team 2nd-round finding, 2026-09-04, verified live).
 */
function findNamingConventionCandidates(
  cg: CodeGraph,
  interfaceName: string,
  seen: Set<string>,
  evidence: string[]
): AospCandidate[] {
  const bareName = interfaceName.replace(/^I/, '');
  const patterns = [`${interfaceName}Stub`, `${interfaceName}Proxy`, `${interfaceName}Impl`, `${bareName}Impl`];
  const candidates: AospCandidate[] = [];
  for (const pattern of patterns) {
    const results = cg.searchNodes(pattern, { kinds: CANDIDATE_NODE_KINDS, limit: 20 });
    if (results.length === 20) evidence.push(`WARNING: searchNodes("${pattern}") 결과가 20개 제한에 도달해 추가 매치가 있을 수 있습니다`);
    for (const { node } of results) {
      if (node.name !== pattern) continue; // exact match only — FTS ranking is not evidence
      const key = `${node.filePath}:${node.startLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        kind: 'impl_by_name',
        nodeKind: node.kind,
        name: node.name,
        qualifiedName: node.qualifiedName,
        filePath: node.filePath,
        line: node.startLine,
        matchedPattern: pattern,
      });
    }
  }
  return candidates;
}

/**
 * Service registration search: `addService.*{shortName}` over the source
 * files CodeGraph actually indexed as Kotlin/Java — the same pattern
 * opengrok-aosp-mcp's `find_aidl_impl` uses over a blind OpenGrok full-text
 * index, scoped here to files CodeGraph has already validated as parseable.
 *
 * Case-insensitive: AOSP service-name string constants are conventionally
 * lower/camelCase (`"media.audio_flinger"`) while the interface's bare name
 * is PascalCase (`Foo` from `IFoo`) — a case-sensitive match silently
 * dropped this supplementary signal whenever the two didn't match case
 * exactly (Green Team 2nd-round finding, 2026-09-04, verified live).
 */
function findServiceRegistrations(
  cg: CodeGraph,
  repoRoot: string,
  interfaceName: string
): { candidates: AospCandidate[]; testPathNote: string | null } {
  const shortName = interfaceName.replace(/^I/, '');
  const patternLabel = `addService.*${shortName}`;
  const hits = grepIndexedSources(
    cg,
    repoRoot,
    ['kotlin', 'java'],
    new RegExp(`addService.*${escapeRegExp(shortName)}`, 'i'),
    patternLabel
  );
  return {
    candidates: hits.map((hit) => ({
      kind: 'service_registration',
      nodeKind: 'line',
      name: shortName,
      qualifiedName: hit.filePath,
      filePath: hit.filePath,
      line: hit.line,
      matchedPattern: hit.matchedPattern,
    })),
    testPathNote: testPathEvidence(hits),
  };
}

/**
 * Find who implements an AIDL interface, using CodeGraph's own symbol graph
 * as the source of truth — no generated AIDL stub sources or Gradle
 * classpath resolution required (both were shown to be unnecessary in the
 * PoC: unresolved_refs captures the extends/implements clause straight from
 * the checked-in Kotlin/Java source).
 *
 * Fail-closed by design: a `.aidl` interface with genuinely no in-repo
 * implementation (e.g. the service lives in a different process/repo, or the
 * callback is only ever implemented by a caller not present here) returns
 * `status: 'no_implementation_found'` with `evidence` describing what was
 * searched — never a false positive, and never silence.
 */
export function findAidlImpl(cg: CodeGraph, repoRoot: string, interfaceName: string, walkLimits: AidlWalkLimits = {}): FindAidlImplResult {
  const parsed = parseAidlDeclarationsWithWalk(repoRoot, interfaceName, walkLimits);
  const declarations = parsed.declarations;
  const evidence: string[] = [];
  const caveat = indexingCaveat(cg);
  if (caveat) evidence.push(caveat);
  if (parsed.truncated) evidence.push(`WARNING: 파일 순회가 상한(${AIDL_WALK_MAX_ENTRIES}개 또는 깊이 ${AIDL_WALK_MAX_DEPTH})에 도달해 중단되었습니다 - 결과가 불완전할 수 있습니다`);

  if (declarations.length === 0) {
    evidence.push(`no .aidl declaration for "${interfaceName}" found under the project root`);
    return { interfaceName, declaration: null, implementations: [], registrations: [], evidence, status: 'declaration_not_found' };
  }

  // Multiple `.aidl` files can declare the same bare interface name in
  // different packages (versioned HAL directories, or an unrelated
  // app-level AIDL sharing a HAL's name) — comparing candidates against
  // whichever declaration the file-system walk happened to hit first
  // produced a nonsensical "package mismatch" verdict against a real
  // implementation of a DIFFERENT declaration (Blue Team 2nd-round finding,
  // 2026-09-04, verified live). Try each declaration's package in turn.
  //
  // Priority is `verified` > `unverifiable` > "matched the most candidates"
  // — NOT just "any non-mismatch candidate", which is what the previous
  // version's `verified` variable actually checked despite its name: an
  // `unverifiable` hit (package couldn't even be parsed) satisfied that
  // filter and immediately won via `break`, so a genuinely `verified` later
  // declaration was never even considered (Codex round-4 Blue Team finding,
  // 2026-09-05). Only stop early once a STRICTLY verified hit is found —
  // that's the one signal strong enough to justify not looking further.
  let declaration: AidlDeclaration = declarations[0]!;
  let unresolvedCandidates: AospCandidate[] = [];
  let verifiedUnresolvedCandidates: AospCandidate[] = [];
  let bestVerifiedDecl: AidlDeclaration | null = null;
  let bestUnverifiableDecl: AidlDeclaration | null = null;
  let bestUnverifiableCandidates: AospCandidate[] = [];
  let bestAnyDecl: AidlDeclaration = declarations[0]!;
  let bestAnyCandidates: AospCandidate[] = [];
  for (const decl of declarations) {
    const candidates = findUnresolvedExtendsCandidates(cg, interfaceName, decl.packageName);
    const strictlyVerified = candidates.filter((c) => c.packageVerified === 'verified');
    const nonMismatch = candidates.filter((c) => c.packageVerified !== 'mismatch');
    if (strictlyVerified.length > 0) {
      declaration = decl;
      unresolvedCandidates = candidates;
      verifiedUnresolvedCandidates = nonMismatch;
      bestVerifiedDecl = decl;
      break;
    }
    if (nonMismatch.length > 0 && !bestUnverifiableDecl) {
      bestUnverifiableDecl = decl;
      bestUnverifiableCandidates = candidates;
    }
    if (candidates.length > bestAnyCandidates.length) {
      bestAnyDecl = decl;
      bestAnyCandidates = candidates;
    }
  }
  if (!bestVerifiedDecl) {
    if (bestUnverifiableDecl) {
      declaration = bestUnverifiableDecl;
      unresolvedCandidates = bestUnverifiableCandidates;
      verifiedUnresolvedCandidates = bestUnverifiableCandidates.filter((c) => c.packageVerified !== 'mismatch');
    } else {
      declaration = bestAnyDecl;
      unresolvedCandidates = bestAnyCandidates;
    }
  }
  const packageMismatchCandidates = unresolvedCandidates.filter((c) => c.packageVerified === 'mismatch');
  const unverifiablePackageCandidates = unresolvedCandidates.filter((c) => c.packageVerified === 'unverifiable');

  const seen = new Set(unresolvedCandidates.map((c) => `${c.filePath}:${c.line}`));
  const namingCandidates = findNamingConventionCandidates(cg, interfaceName, seen, evidence);
  const registrationResult = findServiceRegistrations(cg, repoRoot, interfaceName);
  const registrations = registrationResult.candidates;

  evidence.push(
    `unresolved_refs search: extends/implements -> ${interfaceName} ` +
      `(${unresolvedCandidates.length} hit(s) — highest-confidence signal)`
  );
  if (registrationResult.testPathNote) evidence.push(registrationResult.testPathNote);
  if (declarations.length > 1) {
    evidence.push(
      `${declarations.length} .aidl declaration(s) named "${interfaceName}" found in this repo ` +
        `(different files/packages) — used "${declaration.filePath}" (package ` +
        `${declaration.packageName ?? 'unknown'}) to disambiguate candidates`
    );
  }
  if (declaration.packageName && packageMismatchCandidates.length > 0) {
    evidence.push(
      `${packageMismatchCandidates.length} of those hit(s) could not reach package "${declaration.packageName}" ` +
        `from their file (no matching import, not in that package) — demoted, likely a same-named interface ` +
        `in a different package`
    );
  }
  if (!declaration.packageName && unverifiablePackageCandidates.length > 0) {
    evidence.push(
      `package verification did NOT run for ${unverifiablePackageCandidates.length} hit(s) — the declaration's ` +
        `.aidl file has no parseable "package" clause, so a same-named interface in an unrelated package ` +
        `cannot be ruled out here`
    );
  }
  evidence.push(
    `naming-convention search (secondary, exact-match only): ${interfaceName}Stub, ` +
      `${interfaceName}Proxy, ${interfaceName}Impl (${namingCandidates.length} hit(s))`
  );
  evidence.push(
    `service registration search: addService.*${interfaceName.replace(/^I/, '')} ` +
      `(scoped to CodeGraph-indexed kotlin/java sources, ${registrations.length} hit(s) — ` +
      'supplementary evidence only, never sufficient alone for "found")'
  );

  const implementations = [...unresolvedCandidates, ...namingCandidates];

  // "found" requires the primary signal (a real extends/implements clause
  // CodeGraph tried and failed to resolve) AND, when the declaration's
  // package is known, at least one candidate that can actually reach it.
  // Naming-convention matches and addService registrations are real signal
  // but not proof of implementation on their own (code review finding,
  // 2026-09-04) — a registration line can mention the class in an unrelated
  // comment, and an exact-name match on `{Name}Impl` doesn't confirm it
  // implements THIS interface. Both keep `convention_derived_candidate`
  // distinct from `found`, mirroring find_jni_bridge's status model. A
  // package-mismatched unresolved_refs hit (this interface's bare name
  // resolved to a class that can't reach this specific package) is
  // real signal too — just for a different, same-named interface — so it
  // also only earns `convention_derived_candidate`, not silence.
  let status: FindAidlImplStatus;
  if (verifiedUnresolvedCandidates.length > 0) {
    status = 'found';
  } else if (namingCandidates.length > 0 || registrations.length > 0 || packageMismatchCandidates.length > 0) {
    status = 'convention_derived_candidate';
  } else {
    status = 'no_implementation_found';
  }

  return {
    interfaceName,
    declaration,
    implementations,
    registrations,
    evidence,
    status,
  };
}
