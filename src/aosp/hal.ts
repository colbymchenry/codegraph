/**
 * AOSP extension — HAL interface discovery (AIDL or HIDL).
 *
 * Reuses find_aidl_impl's declaration -> implementation -> registration
 * contract (see aidl.ts's module docstring for the unresolved_refs rationale)
 * but scoped to the AOSP HAL convention: interfaces declared under any
 * `hardware/interfaces/` directory, in either `.aidl` (AIDL HAL, the current
 * AOSP default) or `.hal` (HIDL, legacy) files. HIDL interface syntax
 * (`package android.hardware.foo@1.0; interface IFoo { ... };`) differs
 * slightly from app-level AIDL but the declaration shape — `interface Name {`
 * — is the same for extraction purposes.
 *
 * HAL implementations are commonly native (C++), unlike app-level AIDL Stubs
 * which are Kotlin/Java — so this adds a c/cpp implementation-name search
 * alongside the Kotlin/Java unresolved-refs signal used by find_aidl_impl.
 * Per Codex's Phase 3 scoping review (2026-09-04): reuse the Phase 1
 * contract, add only the HAL-specific path/extension/native-impl pieces —
 * do not invent a new status model.
 *
 * Scope limitation: this module tracks source declarations, implementations,
 * and registration text only. It does not inspect VINTF manifests,
 * compatibility matrices, HAL instances, or vendor/system partition
 * placement, so a source match does not establish device-manifest presence.
 */
import * as fs from 'fs';
import * as path from 'path';
import type CodeGraph from '../index';
import type { NodeKind } from '../types';
import { grepIndexedSources, escapeRegExp, candidateReachesPackagedSymbol, stripCLikeComments, indexingCaveat, findMatchingBraceEnd, testPathEvidence } from './common';
import type { AospCandidate, FindAidlImplStatus, AidlDeclaration } from './aidl';

// HIDL interfaces commonly declare a parent (`interface IFoo extends IBase {`);
// AIDL interfaces never do. The optional `extends` clause covers both without
// a separate HIDL-only regex (Codex cross-review finding, 2026-09-04: the
// original pattern only matched the parentless AIDL shape and silently
// treated every HIDL-with-parent declaration as "no declaration found").
// Unicode-aware for the same reason as aidl.ts's AIDL_INTERFACE_RE.
//
// The extends-target character class also needs `.`, `@`, and `:` — real
// HIDL callback interfaces routinely extend a VERSIONED parent written
// `extends @1.0::IGnssCallback` (or a fully-qualified
// `extends android.hardware.foo@1.0::IFoo`), a mainstream shape, not an edge
// case. The previous class excluded all three characters, so the whole
// `extends` clause failed to match and the no-extends fallback branch also
// failed (the character right after the interface name is `e`, not `{`) —
// the entire declaration went unmatched, not just mis-parsed (Red Team
// round-4 finding, 2026-09-05).
const HAL_INTERFACE_RE = /\binterface\s+([\p{L}\p{N}_$]+)(?:\s+extends\s+[\p{L}\p{N}_$.@:]+)?\s*\{/gu;
const HAL_METHOD_RE = /^\s*(?:oneway\s+)?[\w<>[\],.\s]+?\s+([\p{L}\p{N}_$]+)\s*\([^;{]*\)\s*;/gmu;
// HIDL's package clause carries a version suffix (`package android.hardware.foo@1.0;`).
// The bare package (with `@version` stripped) still needs to be captured for the
// same-package-membership check, but the version itself is captured separately —
// HIDL's actual generated Java import is `android.hardware.foo.V1_0.IFoo`, not
// `android.hardware.foo.IFoo` (Codex 3rd-pass review, 2026-09-04: stripping the
// version and comparing only the bare package demoted every real HIDL Java
// implementation, because its import never matches the version-less FQCN).
const HAL_PACKAGE_RE = /^\s*package\s+([\p{L}\p{N}_.]+)(?:@(\d+)\.(\d+))?\s*;/mu;
// NOT a generic "vendored third-party code" list — see aidl.ts's identical
// note. `vendor/` is a first-class AOSP source directory (the Treble vendor
// partition), and excluding it is especially costly here: `findHalFiles`
// only descends into subtrees whose path includes a `hardware/interfaces`
// segment, and Treble-compliant vendor trees commonly place their OWN
// `hardware/interfaces/` under `vendor/<oem>/...` — skipping `vendor/`
// outright means that entire subtree is NEVER walked, not just one
// declaration missed (Black Hat round-4 finding, 2026-09-05).
//
// `aidl_api` IS excluded, deliberately and for a different reason: AIDL API
// freeze directories (`.../aidl/aidl_api/<pkg>/{1,2,...,current}/**/*.aidl`)
// are historical snapshot copies of an already-declared interface, not a
// second independent declaration. Without this, `parseHalDeclarations`
// reported every frozen version as a same-named "declaration collision",
// producing disambiguation noise for the exact versioned-AIDL-HAL shape this
// tool targets (Green Team round-4 finding, 2026-09-05).
const IGNORED_DIR_NAMES = new Set([
  'node_modules', '.git', 'build', '.codegraph', 'out', '.gradle', '.idea', 'bin', 'dist', 'aidl_api',
]);
const CANDIDATE_NODE_KINDS: NodeKind[] = ['class', 'interface', 'struct'];
export const HAL_WALK_MAX_DEPTH = 40;
export const HAL_WALK_MAX_ENTRIES = 200_000;
export interface HalWalkLimits { maxDepth?: number; maxEntries?: number; }
interface HalFileWalkResult { files: string[]; truncated: boolean; }

export type HalType = 'aidl' | 'hidl';

export interface FindHalInterfaceResult {
  halName: string;
  halType: HalType;
  declaration: AidlDeclaration | null;
  implementations: AospCandidate[];
  registrations: AospCandidate[];
  evidence: string[];
  status: FindAidlImplStatus;
}

/**
 * HAL interfaces live under `hardware/interfaces/**`, not repo-root-wide like
 * app-level `.aidl` — restricting the walk to that subtree avoids false
 * matches against an app's own AIDL files that happen to share a HAL's name.
 *
 * Refuses to follow symlinks — both symlinked directories, for the same
 * repoRoot-boundary reasoning as aidl.ts's `findAidlFiles` (Codex 3rd-pass
 * review, 2026-09-04), and a symlinked FILE with a `.aidl`/`.hal`-looking
 * name, which the directory-only check left unguarded (Red Team round-3
 * finding, 2026-09-05 — symmetric with aidl.ts's fix).
 */
function findHalFiles(root: string, extension: string, limits: HalWalkLimits = {}): HalFileWalkResult {
  const maxDepth = limits.maxDepth ?? HAL_WALK_MAX_DEPTH;
  const maxEntries = limits.maxEntries ?? HAL_WALK_MAX_ENTRIES;
  const results: string[] = [];
  let visited = 0;
  let truncated = false;
  const walk = (dir: string, underHalRoot: boolean, depth: number): void => {
    if (truncated || depth > maxDepth) { truncated = true; return; }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= maxEntries) { truncated = true; return; }
      visited++;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name)) continue;
        const nowUnderHal = underHalRoot || entry.name === 'interfaces' && path.basename(dir) === 'hardware';
        walk(path.join(dir, entry.name), nowUnderHal, depth + 1);
      } else if (underHalRoot && entry.name.endsWith(extension)) {
        results.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root, false, 0);
  return { files: results, truncated };
}

/**
 * Parse every HAL declaration named `halName` under `hardware/interfaces/`
 * — not just the first file-system-order match. Same rationale as aidl.ts's
 * `parseAidlDeclarations`: versioned HIDL directories routinely declare the
 * same bare interface name across versions. Comments are stripped before
 * matching for the same data-bleed reason as the AIDL parser.
 */
function parseHalDeclarationsWithWalk(repoRoot: string, halName: string, extension: string, limits: HalWalkLimits = {}): { declarations: AidlDeclaration[]; truncated: boolean } {
  const declarations: AidlDeclaration[] = [];
  const walk = findHalFiles(repoRoot, extension, limits);
  for (const file of walk.files) {
    let rawText: string;
    try {
      rawText = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const text = stripCLikeComments(rawText);
    HAL_INTERFACE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HAL_INTERFACE_RE.exec(text)) !== null) {
      if (match[1] !== halName) continue;

      // Scope the method scan to this interface's own body via brace-depth
      // tracking, not a plain indexOf — same fix and rationale as aidl.ts's
      // parseAidlDeclarations (self-review finding, 2026-09-05; brace-depth
      // fix for nested enum/struct/union, Red Team round-4 finding,
      // 2026-09-05).
      const bodyStart = match.index + match[0].length;
      const bodyEnd = findMatchingBraceEnd(text, bodyStart);
      const body = bodyEnd === -1 ? text.slice(bodyStart) : text.slice(bodyStart, bodyEnd);

      const methods: string[] = [];
      HAL_METHOD_RE.lastIndex = 0;
      let methodMatch: RegExpExecArray | null;
      while ((methodMatch = HAL_METHOD_RE.exec(body)) !== null) {
        const name = methodMatch[1];
        if (name) methods.push(name);
      }
      const packageMatch = HAL_PACKAGE_RE.exec(text);
      declarations.push({
        filePath: path.relative(repoRoot, file),
        line: text.slice(0, match.index).split('\n').length,
        methods,
        packageName: packageMatch?.[1] ?? null,
        packageVersion: packageMatch?.[2] && packageMatch?.[3] ? { major: packageMatch[2], minor: packageMatch[3] } : undefined,
      });
    }
  }
  return { declarations, truncated: walk.truncated };
}

export function parseHalDeclarations(repoRoot: string, halName: string, extension: string, limits: HalWalkLimits = {}): AidlDeclaration[] {
  return parseHalDeclarationsWithWalk(repoRoot, halName, extension, limits).declarations;
}

/** Compute the FQCNs a real Java/Kotlin implementation could import for
 * `declaration`, beyond the plain `{packageName}.{halName}` — currently
 * just HIDL's versioned sub-package (`{packageName}.V{major}_{minor}.{halName}`).
 */
function alternateFqcnsFor(declaration: AidlDeclaration, halName: string): string[] {
  if (!declaration.packageName || !declaration.packageVersion) return [];
  const { major, minor } = declaration.packageVersion;
  return [`${declaration.packageName}.V${major}_${minor}.${halName}`];
}

function findUnresolvedExtendsCandidates(
  cg: CodeGraph,
  halName: string,
  packageName: string | null,
  alternateFqcns: string[] = [],
  declarationFilePath?: string
): AospCandidate[] {
  const candidates: AospCandidate[] = [];
  for (const ref of cg.getUnresolvedReferencesByQualifiedName(halName)) {
    if (ref.referenceKind !== 'extends' && ref.referenceKind !== 'implements') continue;
    const node = cg.getNode(ref.fromNodeId);
    if (!node) continue;
    const packageVerified = candidateReachesPackagedSymbol(cg, node.filePath, packageName, halName, alternateFqcns, declarationFilePath);
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
 * Real AOSP AIDL C++ implementations almost never name their class after
 * the interface (`DefaultVehicleHal`, `ExternalCameraProvider`, ...) — the
 * only structural signal that a class IS a HAL's implementation is that it
 * inherits the AIDL compiler's generated `Bn{Name}` Binder-native stub
 * (`class DefaultVehicleHal final : public BnVehicle`), the C++ analog of
 * Java's `{Name}.Stub`. `Bn{Name}` is generated at build time and is never
 * checked into source, so — exactly like a Kotlin/Java `.Stub()` reference —
 * it shows up as an UNRESOLVED extends/implements reference, not a resolved
 * node. Reusing `findUnresolvedExtendsCandidates` against `Bn{bareName}`
 * catches this the same way the Kotlin/Java path already catches `.Stub()`.
 *
 * Real HAL implementations are the specific case that motivated this: the
 * old naming-convention-only search (bare name / `Impl` suffix) silently
 * missed IVehicle/ICameraProvider/ITelephony's actual C++ implementations
 * entirely, because none of them are named after the interface (found by
 * validating against the real hardware/interfaces mirror, 2026-09-10).
 *
 * C++ has no Java-style `import`, so there is no package-membership check
 * to run here the way `candidateReachesPackagedSymbol` does for Kotlin/Java
 * — every hit is reported `unverifiable`, never `verified`, and never
 * `mismatch`. That is an honest reflection of what was actually checked,
 * not a claim of certainty.
 */
/**
 * Bare name AIDL's C++ codegen uses to build `Bn{Name}`/`Bp{Name}`, mirroring
 * upstream `aidl_to_common.cpp`'s `ClassName()`: the leading `I` is dropped
 * only when the name is at least 2 characters AND the second character is
 * itself uppercase (the real `I`-prefix convention, e.g. `IFoo` -> `Foo`).
 * A naive `replace(/^I/, '')` also strips names that merely start with `I`
 * without following the convention (`Interface` -> `nterface`, `Ifoo` ->
 * `foo`, `I` -> ``), which never matches what the real AIDL compiler
 * generates and produced `no_implementation_found` false negatives on those
 * boundary names (Codex adversarial review, 2026-09-10, MEDIUM-1).
 */
function aidlBareName(interfaceName: string): string {
  if (interfaceName.length >= 2 && interfaceName[0] === 'I' && /[A-Z]/.test(interfaceName[1]!)) {
    return interfaceName.slice(1);
  }
  return interfaceName;
}

/**
 * Structural signal specific to AIDL (never HIDL): a C++ class/struct whose
 * extends/implements clause named `Bn{InterfaceName}` — AIDL's C++ codegen
 * name for the Binder-native stub base an implementation subclasses. Gated
 * to `halType === 'aidl'` because HIDL's native wrapper naming is a
 * different family (`BnHw{Name}`), and applying this AIDL-only pattern to a
 * HIDL lookup previously let an unrelated `Bn{Name}` hit falsely promote a
 * HIDL interface too (Codex adversarial review, 2026-09-10, HIGH-3).
 *
 * Deliberately reported as `unverifiable` (never `verified`) and, per
 * `findHalInterface`, deliberately excluded from the candidate set that can
 * promote a result to `found` — an unrelated project-internal class that
 * happens to share the `Bn{Name}` string is not distinguishable here from a
 * real AIDL-generated stub subclass without inspecting the actual generated
 * header, so this alone can only ever raise a `convention_derived_candidate`
 * (Codex adversarial review, 2026-09-10, HIGH-2).
 */
function findBnStubCandidates(cg: CodeGraph, halName: string, halType: HalType): AospCandidate[] {
  if (halType !== 'aidl') return [];
  const bareName = aidlBareName(halName);
  const bnName = `Bn${bareName}`;
  const candidates: AospCandidate[] = [];
  for (const ref of cg.getUnresolvedReferencesByNamespacedSuffix(bnName)) {
    if (ref.referenceKind !== 'extends' && ref.referenceKind !== 'implements') continue;
    const node = cg.getNode(ref.fromNodeId);
    if (!node || node.language !== 'cpp') continue;
    candidates.push({
      kind: 'stub_subclass',
      nodeKind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName,
      filePath: node.filePath,
      line: node.startLine,
      matchedPattern: `unresolved ${ref.referenceKind} -> ${ref.referenceName} (AIDL C++ Binder-native stub)`,
      packageVerified: 'unverifiable',
    });
  }
  return candidates;
}

function findNamingConventionCandidates(cg: CodeGraph, halName: string, seen: Set<string>, evidence: string[]): AospCandidate[] {
  // Also try the bare name with a leading "I" dropped (`IFoo` -> `FooImpl`)
  // — aidl.ts's equivalent search already does this (Blue Team round-2
  // finding, 2026-09-04), but this HAL search never inherited it, even
  // though HAL's own native-impl search two functions below already drops
  // the `I` for C/C++. A mock/test HAL implemented in Kotlin/Java as
  // `FooImpl` (the far more common shape in practice) went entirely
  // unmatched here (Green Team round-3 finding, 2026-09-05).
  const bareName = halName.replace(/^I/, '');
  const patterns = [`${halName}Stub`, `${halName}Impl`, `${bareName}Impl`];
  const candidates: AospCandidate[] = [];
  for (const pattern of patterns) {
    const results = cg.searchNodes(pattern, { kinds: CANDIDATE_NODE_KINDS, limit: 20 });
    if (results.length === 20) evidence.push(`WARNING: searchNodes("${pattern}") 결과가 20개 제한에 도달해 추가 매치가 있을 수 있습니다`);
    for (const { node } of results) {
      if (node.name !== pattern) continue;
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
 * HAL implementations are commonly native, so also look for a c/cpp
 * class/struct exactly named `{HalName}` (the implementation class usually
 * reuses the interface's bare name, e.g. `class Foo : public IFoo` for a
 * HAL named `IFoo` — this checks for a class dropping the leading `I`, the
 * AOSP HAL convention) or `{HalName}Impl` / `{HalName}Hal`.
 *
 * Legacy HAL implementations are frequently plain C (a `struct` with
 * function-pointer members), not C++ — CodeGraph tags these `c`, distinct
 * from `cpp`. Accepting only `cpp` here silently excluded every C-only HAL
 * even though the registration search two lines below already scans both
 * (Codex cross-review finding, 2026-09-04).
 */
function findNativeImplCandidates(cg: CodeGraph, halName: string, seen: Set<string>, evidence: string[]): AospCandidate[] {
  const bareName = halName.replace(/^I/, '');
  const patterns = [bareName, `${bareName}Impl`, `${halName}Impl`];
  const candidates: AospCandidate[] = [];
  for (const pattern of patterns) {
    const results = cg.searchNodes(pattern, { kinds: ['class', 'struct'], limit: 20 });
    if (results.length === 20) evidence.push(`WARNING: searchNodes("${pattern}") 결과가 20개 제한에 도달해 추가 매치가 있을 수 있습니다`);
    for (const { node } of results) {
      if (node.name !== pattern || (node.language !== 'cpp' && node.language !== 'c')) continue;
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
        matchedPattern: `native impl candidate: ${pattern}`,
      });
    }
  }
  return candidates;
}

export function findHalInterface(
  cg: CodeGraph,
  repoRoot: string,
  halName: string,
  halType: HalType = 'aidl',
  walkLimits: HalWalkLimits = {}
): FindHalInterfaceResult {
  const extension = halType === 'hidl' ? '.hal' : '.aidl';
  const parsed = parseHalDeclarationsWithWalk(repoRoot, halName, extension, walkLimits);
  const declarations = parsed.declarations;
  const evidence: string[] = [];
  const caveat = indexingCaveat(cg);
  if (caveat) evidence.push(caveat);
  if (parsed.truncated) evidence.push(`WARNING: 파일 순회가 상한(${HAL_WALK_MAX_ENTRIES}개 또는 깊이 ${HAL_WALK_MAX_DEPTH})에 도달해 중단되었습니다 - 결과가 불완전할 수 있습니다`);

  if (declarations.length === 0) {
    evidence.push(`no ${extension} declaration for "${halName}" found under any hardware/interfaces/ directory`);
    return { halName, halType, declaration: null, implementations: [], registrations: [], evidence, status: 'declaration_not_found' };
  }

  // Same multi-declaration disambiguation as findAidlImpl — versioned HIDL
  // directories are the canonical case this matters for (Blue Team
  // 2nd-round finding, 2026-09-04). Priority is `verified` > `unverifiable`
  // > "matched the most candidates", not just "any non-mismatch candidate" —
  // see aidl.ts's identical fix for the Codex round-4 Blue Team finding this
  // corrects (2026-09-05).
  let declaration: AidlDeclaration = declarations[0]!;
  let unresolvedCandidates: AospCandidate[] = [];
  let verifiedUnresolvedCandidates: AospCandidate[] = [];
  let bestVerifiedDecl: AidlDeclaration | null = null;
  let bestUnverifiableDecl: AidlDeclaration | null = null;
  let bestUnverifiableCandidates: AospCandidate[] = [];
  let bestAnyDecl: AidlDeclaration = declarations[0]!;
  let bestAnyCandidates: AospCandidate[] = [];
  const bnStubCandidates = findBnStubCandidates(cg, halName, halType);
  for (const decl of declarations) {
    const candidates = findUnresolvedExtendsCandidates(cg, halName, decl.packageName, alternateFqcnsFor(decl, halName), decl.filePath);
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

  const seen = new Set([...unresolvedCandidates, ...bnStubCandidates].map((c) => `${c.filePath}:${c.line}`));
  const namingCandidates = findNamingConventionCandidates(cg, halName, seen, evidence);
  const nativeCandidates = findNativeImplCandidates(cg, halName, seen, evidence);

  const shortName = halName.replace(/^I/, '');
  const escapedShortName = escapeRegExp(shortName);
  const registrationHits = grepIndexedSources(
    cg,
    repoRoot,
    ['kotlin', 'java', 'cpp', 'c'],
    new RegExp(`(addService|registerAsService|IPCThreadState).*${escapedShortName}`),
    `(addService|registerAsService|IPCThreadState).*${shortName}`
  );
  const registrations = registrationHits.map((hit): AospCandidate => ({
    kind: 'service_registration',
    nodeKind: 'line',
    name: shortName,
    qualifiedName: hit.filePath,
    filePath: hit.filePath,
    line: hit.line,
    matchedPattern: hit.matchedPattern,
  }));

  evidence.push(
    `unresolved_refs search (Kotlin/Java): extends/implements -> ${halName} (${unresolvedCandidates.length} hit(s))`
  );
  if (declarations.length > 1) {
    evidence.push(
      `${declarations.length} ${extension} declaration(s) named "${halName}" found under hardware/interfaces/ ` +
        `(different files/packages) — used "${declaration.filePath}" (package ${declaration.packageName ?? 'unknown'}) ` +
        `to disambiguate candidates`
    );
  }
  if (declaration.packageName && packageMismatchCandidates.length > 0) {
    evidence.push(
      `${packageMismatchCandidates.length} of those hit(s) could not reach package "${declaration.packageName}" ` +
        `from their file (no matching import, not in that package) — demoted, likely a same-named HAL ` +
        `in a different package`
    );
  }
  if (!declaration.packageName && unverifiablePackageCandidates.length > 0) {
    evidence.push(
      `package verification did NOT run for ${unverifiablePackageCandidates.length} hit(s) — the declaration's ` +
        `${extension} file has no parseable "package" clause, so a same-named HAL in an unrelated package ` +
        `cannot be ruled out here`
    );
  }
  if (halType === 'aidl') {
    evidence.push(
      `Bn{Name} Binder-native stub search (C++, AIDL only, exact or ::-qualified): ` +
        `extends/implements -> Bn${aidlBareName(halName)} (${bnStubCandidates.length} hit(s) — ` +
        `unverifiable name match only, never sufficient alone for "found")`
    );
  }
  evidence.push(
    `naming-convention search (Kotlin/Java, exact-match): ${halName}Stub, ${halName}Impl, ${shortName}Impl (${namingCandidates.length} hit(s))`
  );
  evidence.push(
    `native (c/cpp) implementation search (exact-match): ${shortName}, ${shortName}Impl, ${halName}Impl (${nativeCandidates.length} hit(s))`
  );
  evidence.push(
    `HAL registration search: addService/registerAsService/IPCThreadState for ${shortName} ` +
      `(${registrations.length} hit(s) — supplementary evidence only, never sufficient alone for "found")`
  );
  const registrationTestPathNote = testPathEvidence(registrationHits);
  if (registrationTestPathNote) evidence.push(registrationTestPathNote);

  const implementations = [...unresolvedCandidates, ...bnStubCandidates, ...namingCandidates, ...nativeCandidates];
  let status: FindAidlImplStatus;
  if (verifiedUnresolvedCandidates.length > 0) {
    status = 'found';
  } else if (implementations.length > 0 || registrations.length > 0) {
    status = 'convention_derived_candidate';
  } else {
    status = 'no_implementation_found';
  }

  return { halName, halType, declaration, implementations, registrations, evidence, status };
}
