/**
 * AOSP extension — shared helpers for the AIDL and JNI query modules.
 *
 * Both modules need to grep CodeGraph-indexed source (not a blind full-text
 * index) for an AOSP naming-convention pattern that the language extractors
 * don't model as a node/edge (`addService(...)`, `RegisterNatives(...)`).
 * Scoping the grep to files CodeGraph has already parsed keeps this
 * consistent with the graph-first design — it never touches build output,
 * vendor stubs, or anything CodeGraph itself ignored.
 */
import * as fs from 'fs';
import * as path from 'path';
import type CodeGraph from '../index';
import type { EdgeKind, Language, Node } from '../types';

export interface DeclarationWalkLimits { maxDepth?: number; maxEntries?: number; }
export const DECLARATION_WALK_MAX_DEPTH = 40;
export const DECLARATION_WALK_MAX_ENTRIES = 200_000;

/** Find declarations within the project without following directory or file symlinks. */
export function walkDeclarationFiles(
  root: string,
  extension: string,
  ignoredDirs: Set<string>,
  limits: DeclarationWalkLimits,
  halOnly = false,
): { files: string[]; truncated: boolean } {
  const maxDepth = limits.maxDepth ?? DECLARATION_WALK_MAX_DEPTH;
  const maxEntries = limits.maxEntries ?? DECLARATION_WALK_MAX_ENTRIES;
  const files: string[] = [];
  let visited = 0;
  let truncated = false;
  const walk = (dir: string, depth: number, underHalRoot: boolean): void => {
    if (truncated || depth > maxDepth) { truncated = true; return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (visited >= maxEntries) { truncated = true; return; }
      visited++;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue;
        const inHal = underHalRoot || (entry.name === 'interfaces' && path.basename(dir) === 'hardware');
        walk(path.join(dir, entry.name), depth + 1, inHal);
      } else if ((!halOnly || underHalRoot) && entry.name.endsWith(extension)) {
        files.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root, 0, false);
  return { files, truncated };
}

/**
 * Result of a package-reachability check — three states, not a boolean,
 * because "we couldn't tell" and "we checked and it doesn't reach" must be
 * distinguishable to the caller (and to evidence output). Collapsing them
 * into one boolean is what let a parse failure silently behave exactly like
 * a real mismatch check with no trace in the output.
 */
export type PackageReachability = 'verified' | 'unverifiable' | 'mismatch';

/**
 * Does the file containing `candidateFilePath` actually have a way to reach
 * `{packageName}.{symbolName}` — a matching import (exact FQCN or a
 * wildcard covering the package), living in that same package (Kotlin/Java
 * resolve same-package symbols without an import), or matching one of
 * `alternateFqcns` ?
 *
 * find_aidl_impl/find_hal_interface match an interface purely by its bare
 * name (`IFoo`) via `unresolved_refs`, which has no package/version field —
 * if two different `.aidl`/`.hal` declarations in the repo happen to share
 * a bare name (a real AOSP shape: `hardware/interfaces/foo/1.0/IFoo.aidl`
 * vs. an unrelated `hardware/interfaces/bar/2.0/IFoo.aidl`), a class that
 * implements one could get reported as implementing the other. CodeGraph already indexes each file's
 * import statements as `kind: 'import'` nodes carrying the full dotted
 * path (verified live: `import android.hardware.foo.IFoo` becomes a node
 * named exactly `android.hardware.foo.IFoo`) and each file's package
 * declaration as a `kind: 'namespace'` node — this reuses both instead of
 * re-parsing source.
 *
 * Returns `'unverifiable'` when package info can't settle the question (no
 * `packageName` on the declaration, e.g. parsing failed) — the caller
 * should treat that as "unverified but not contradicted," not as a
 * mismatch, but MUST say so in evidence rather than silently proceeding as
 * if verification succeeded. Only an explicit `'mismatch'` should lower
 * confidence; missing information must not turn into a new false-negative
 * source.
 *
 * AIDL/HAL intentionally allow an `unverifiable` package to remain eligible
 * for their strongest result when the candidate came from an actual
 * unresolved extends/implements parse, a strong primary signal. JNI is
 * intentionally stricter: its RegisterNatives text grep is weaker, so an
 * unverifiable package also needs same-file correlation before contributing
 * to `found`. This is an intentional module-specific confidence policy.
 */
/**
 * The AOSP HAL "generation family" a `hardware/interfaces/...` path belongs
 * to: the literal `'aidl'` for anything under an `aidl/` directory, or the
 * HIDL version number (`'2.4'`, `'1.0'`, ...) for anything under a versioned
 * directory. Returns `null` when neither pattern is found — a plain
 * app-level AIDL path (not under `hardware/interfaces/`) has no such
 * convention, and this correlation deliberately does not apply there.
 *
 * Two same-named interfaces can legitimately coexist in one real AOSP tree
 * across a HIDL-to-AIDL migration (`camera/provider/2.4/ICameraProvider.hal`
 * next to `camera/provider/aidl/.../ICameraProvider.aidl`) — a real HIDL 2.4
 * `CameraProvider` implementation must never count as evidence for the AIDL
 * declaration, and vice versa, even though both are named `ICameraProvider`.
 */
function halGenerationFamily(filePath: string): string | null {
  const segments = filePath.split('/');
  if (segments.includes('aidl')) return 'aidl';
  const versionSegment = segments.find((s) => /^\d+\.\d+$/.test(s));
  return versionSegment ?? null;
}

export function candidateReachesPackagedSymbol(
  cg: CodeGraph,
  candidateFilePath: string,
  packageName: string | null,
  symbolName: string,
  alternateFqcns: string[] = [],
  declarationFilePath?: string
): PackageReachability {
  if (!packageName) return 'unverifiable';
  const fqcn = `${packageName}.${symbolName}`;
  const wildcard = `${packageName}.*`;
  const acceptable = new Set([fqcn, ...alternateFqcns]);
  const nodesInFile = cg.getNodesInFile(candidateFilePath);
  for (const node of nodesInFile) {
    if (node.kind === 'import' && (acceptable.has(node.name) || node.name === wildcard || node.name === packageName)) {
      return 'verified';
    }
    if (node.kind === 'namespace' && node.name === packageName) return 'verified';
  }
  // This check only understands Java/Kotlin-style dotted-FQCN imports
  // (`import android.hardware.foo.IFoo`) and same-package membership via a
  // `namespace` node. A C/C++ (or any other non-package-import language)
  // candidate's `#include` is a path, never a dotted FQCN, so it can NEVER
  // satisfy the loop above regardless of whether the candidate is genuinely
  // correct. Falling through to an unconditional `mismatch` treated "this
  // language has no way to pass the check" the same as "we checked and it's
  // wrong" — silently demoting a real C++ HIDL/AIDL implementation caught by
  // the primary unresolved-extends signal (`struct DrmPlugin: public
  // IDrmPlugin`) below the `found` threshold whenever the declaration's
  // package happened to be known, which is the common case for a real
  // `.hal`/`.aidl` file.
  //
  // The first fix here was too permissive: treating EVERY non-Java/Kotlin
  // candidate as `unverifiable` let a completely unrelated same-named type
  // in any other language (Rust/Swift/TypeScript/Go, not just C/C++) reach
  // `found`, and — reproduced against the real hardware/interfaces mirror —
  // let a real HIDL 2.4 `CameraProvider` implementation satisfy an AIDL
  // `ICameraProvider` query, since both share the bare interface name across
  // a HIDL-to-AIDL migration.
  // `declarationFilePath` (the specific `.aidl`/`.hal` file this candidate is
  // being checked against, when the caller has one) lets a HAL candidate
  // additionally correlate by generation family: only when the candidate's
  // path and the declaration's path both land in the same family (both
  // `aidl/`, or the same HIDL version number) is the mismatch actually
  // inconclusive rather than a real cross-family collision. Callers with no
  // HAL-directory convention to check against (app-level `aidl-impl`, which
  // never passes `declarationFilePath`) keep the original, conservative
  // `mismatch` fallback.
  const candidateLanguage = nodesInFile[0]?.language;
  if (candidateLanguage && candidateLanguage !== 'java' && candidateLanguage !== 'kotlin') {
    if (declarationFilePath) {
      const declFamily = halGenerationFamily(declarationFilePath);
      const candidateFamily = halGenerationFamily(candidateFilePath);
      if (declFamily && candidateFamily && declFamily === candidateFamily) {
        return 'unverifiable';
      }
    }
    return 'mismatch';
  }
  return 'mismatch';
}

/**
 * All six aosp query functions report a negative status (`no_*_found`,
 * `declaration_not_found`, etc.) purely from what's currently in CodeGraph's
 * index — there's no distinct "still indexing" status, so a query that runs
 * mid-index looks identical to a query against a fully-indexed, genuinely
 * empty repo. A caller polling right after `indexAll()` starts (or a CI
 * step that doesn't wait for completion) gets a silent false negative with
 * no signal that the answer might change once indexing finishes. `cg.isIndexing()` already exists on the
 * core CodeGraph class; this just standardizes the caveat text so every
 * aosp module surfaces it the same way instead of each reinventing wording.
 */
export function indexingCaveat(cg: CodeGraph): string | null {
  return cg.isIndexing()
    ? 'WARNING: CodeGraph is still indexing this repository right now — a ' +
        '"not found" result below may reflect files that have not finished ' +
        'indexing yet, not a genuine absence. Re-run this query after ' +
        'indexing completes for a reliable answer.'
    : null;
}

export interface SourceGrepHit {
  filePath: string;
  line: number;
  matchedPattern: string;
  looksLikeTestPath?: boolean;
}

/**
 * Blank out `//` and `/* *\/` comments in C-family source (`.aidl`/`.hal`
 * use this syntax) while preserving line numbers and file length — every
 * commented-out character is replaced with a space, newlines are kept as
 * newlines. Used before scanning `.aidl`/`.hal` text for interface
 * declarations so a `interface IFoo {` example inside a docstring, or a
 * commented-out stale declaration, can never be mistaken for a live one.
 *
 * Not a full lexer — a `//`/`/* *\/` sequence inside a string literal is
 * still blanked out. AIDL/HAL declaration files essentially never contain
 * string literals in practice, so this trade-off is deliberate: it trades a
 * theoretical false negative in an unrealistic file for eliminating a real,
 * observed false positive (declaration data bleeding from one interface
 * name to another).
 */
/**
 * Find the `}` that closes the brace opened just before `bodyStart` (i.e.
 * `bodyStart` is the index right after that opening `{`), by tracking brace
 * depth rather than taking the first `}` found. AIDL/HIDL interface bodies
 * are not brace-free — a nested `enum`/`struct`/`union`/`parcelable`
 * declaration inside the interface has its own `{ ... }`, and a plain
 * `text.indexOf('}', bodyStart)` truncates the body at THAT inner closing
 * brace, silently dropping every real method declared after it. Comments must already be stripped from
 * `text` (see `stripCLikeComments`) before calling this, or a `}` inside a
 * comment would be counted.
 */
export function findMatchingBraceEnd(text: string, bodyStart: number): number {
  let depth = 1;
  for (let i = bodyStart; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function stripCLikeComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** Blank out XML comments while preserving line numbers for text evidence. */
export function stripXmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

const COMMENT_STRIPPED_LANGUAGES = new Set<Language>(['kotlin', 'java', 'c', 'cpp']);
const TEST_PATH_SEGMENTS = new Set(['test', 'tests', 'androidTest', 'cts', 'vts', '__tests__']);

function looksLikeTestPath(filePath: string): boolean {
  return filePath.split('/').some((segment) => TEST_PATH_SEGMENTS.has(segment));
}

/** Add a compact warning when text hits came from test-like path segments. */
export function testPathEvidence(hits: SourceGrepHit[]): string | null {
  const count = hits.filter((hit) => hit.looksLikeTestPath).length;
  return count > 0
    ? `${count} hit(s) are in test/CTS/VTS-like paths and may not be production code`
    : null;
}

/**
 * Escape a raw string for safe interpolation into a `RegExp` source. Every
 * AOSP grep pattern that interpolates a caller-supplied name (a service
 * name, permission string, broadcast action, HAL name) must run its
 * interpolated pieces through this first — an unescaped `.`/`[`/`(` etc.
 * either silently widens the match (false positives) or throws on
 * `new RegExp()`.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Per-language single-line comment prefix, used to skip the most common
 * false-positive shape in grepIndexedSources() below. XML has no `//` —
 * using that prefix for every language (the original fix) left every XML
 * caller (tracePermission's manifest scan) exposed to a permission string
 * sitting inside `<!-- ... -->`, verified live: a `<!--`-commented-out
 * `<uses-permission>` line matched identically to a real one.
 */
const LINE_COMMENT_PREFIX: Partial<Record<Language, string>> = {
  kotlin: '//',
  java: '//',
  c: '//',
  cpp: '//',
  xml: '<!--',
};

/**
 * Scan every CodeGraph-indexed file in the given language(s) for lines
 * matching `pattern`, returning one hit per matching line.
 *
 * This is a plain per-line regex scan, not an AST match — it has no notion
 * of comments or string literals, so `// addService("foo", this)` left
 * behind in a stale comment matches exactly like live code. Skipping a line
 * that starts with its language's comment prefix removes the single most
 * common false-positive shape (a line comment) without pretending to solve
 * the general problem — a match inside a block comment, an XML comment that
 * opens on an earlier line, or a string literal still passes through.
 * Callers must not treat a hit here as semantic proof; the `AospCandidate`/
 * evidence types this feeds all describe it as supplementary text-match
 * signal, never sufficient alone.
 */
/**
 * `{base}{suffix}` without duplicating the overlap when `base` already ends
 * with (part of) `suffix` — e.g. building the "ServiceManager" candidate for
 * a caller that already queried "AppCardServiceManager" as `base` would
 * otherwise produce "AppCardServiceManagerServiceManager". Shared by
 * system_service.ts (the original AOSP {Name}ManagerService convention) and
 * messenger.ts (the {Name}Service / {Name}ServiceManager convention for
 * Messenger-based IPC), both of which build a class-name candidate from a
 * caller-supplied short name.
 */
export function appendSuffixWithoutDuplication(base: string, suffix: string): string {
  const max = Math.min(base.length, suffix.length);
  for (let overlap = max; overlap > 0; overlap--) {
    if (base.slice(-overlap).toLowerCase() === suffix.slice(0, overlap).toLowerCase()) {
      return base + suffix.slice(overlap);
    }
  }
  return base + suffix;
}

/** PascalCase a short, possibly snake/kebab/space-separated service name (`"app_card"` -> `"AppCard"`). */
export function titleCase(name: string): string {
  return name
    .split(/[_\s-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Find an exact-name `class` node, falling back to a case-insensitive index
 * scan — the same two-step lookup system_service.ts's `analyzeSystemService`
 * already used privately, shared here for messenger.ts and local_socket.ts,
 * neither of which builds candidates through system_service.ts's specific
 * `{Name}ManagerService` convention.
 */
export function findClassNodeByName(cg: CodeGraph, candidateName: string): { node: Node; caseInsensitive: boolean } | null {
  const exact = cg
    .searchNodes(candidateName, { kinds: ['class'], limit: 20 })
    .find((match) => match.node.name === candidateName)?.node;
  if (exact) return { node: exact, caseInsensitive: false };

  const folded = cg
    .getNodesByNameSubstring(candidateName, { kinds: ['class'], limit: 50 })
    .find((node) => node.name.toLowerCase() === candidateName.toLowerCase());
  return folded ? { node: folded, caseInsensitive: true } : null;
}

export interface ContainedRepoRoot {
  resolvedRepoRoot: string;
  realRepoRoot: string;
}

/**
 * Resolve `repoRoot` once (its absolute form, and its realpath after
 * symlink resolution) so every subsequent per-file containment check in a
 * loop can reuse it instead of re-resolving the root on every iteration.
 */
export function resolveContainedRepoRoot(repoRoot: string): ContainedRepoRoot {
  const resolvedRepoRoot = path.resolve(repoRoot);
  let realRepoRoot = resolvedRepoRoot;
  try {
    realRepoRoot = fs.realpathSync(resolvedRepoRoot);
  } catch {
    // A missing root will make individual reads fail as before.
  }
  return { resolvedRepoRoot, realRepoRoot };
}

function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Resolve a CodeGraph-stored relative `filePath` against an already-resolved
 * repo root, refusing to follow it if either the plain resolved path OR its
 * realpath (after symlink resolution) escapes the repo root. Returns `null`
 * when the file should not be read — a missing file, an escaping relative
 * path, or a symlink pointing outside the project boundary.
 *
 * This is the exact containment check `grepIndexedSources` has always
 * applied to every file it reads from `cg.getFiles()` (a CodeGraph-produced
 * list, not user input — but still defended, since a stored path could in
 * principle contain `..` segments or point through a symlink CodeGraph
 * itself followed during indexing). Extracted here so any other AOSP module
 * that reads CodeGraph-indexed files directly, rather than through
 * `grepIndexedSources`, gets the same defense instead of re-deriving it ad
 * hoc.
 */
export function resolveContainedFilePath(root: ContainedRepoRoot, filePath: string): string | null {
  const absolutePath = path.resolve(root.resolvedRepoRoot, filePath);
  if (!isWithinRoot(absolutePath, root.resolvedRepoRoot)) return null;
  let realFilePath: string;
  try {
    realFilePath = fs.realpathSync(absolutePath);
  } catch {
    return null;
  }
  if (!isWithinRoot(realFilePath, root.realRepoRoot)) return null;
  return realFilePath;
}

/**
 * Does `memberQualifiedName` belong DIRECTLY to the class identified by
 * `classQualifiedName`, the class's own qualifiedName itself, or exactly
 * one `::`-separated segment below it (a field/method/etc. declared
 * directly in that class body)? Verified live: CodeGraph qualifies a
 * package with dots and class/member nesting with `::`
 * (`pkg.sub::Outer::Inner::field`).
 *
 * Deliberately rejects a DEEPER path (two or more `::` segments below the
 * class), that is a member of a NESTED class, not this one, and rejects
 * a SIBLING class entirely (a different qualifiedName prefix). Both are
 * real false-positive shapes a same-file + overlapping-line-range check
 * cannot distinguish: `class Outer { static class Inner { Messenger m; }
 * }` querying `Outer`, and `class A {} class B { Messenger m; }` on one
 * source line querying `A`.
 */
export function isDirectMemberOfClass(memberQualifiedName: string, classQualifiedName: string): boolean {
  if (memberQualifiedName === classQualifiedName) return true;
  const prefix = `${classQualifiedName}::`;
  if (!memberQualifiedName.startsWith(prefix)) return false;
  return !memberQualifiedName.slice(prefix.length).includes('::');
}

export interface ResolvedTypeReference {
  /** The node whose body contains the reference (a field, method, or class). */
  fromNode: Node;
  edgeKind: EdgeKind;
}

/**
 * The resolved-graph counterpart to `getUnresolvedReferencesByQualifiedName`:
 * every real edge (of the given kinds) pointing at the class/interface node
 * identified by `{packageName}::{bareTypeName}`, if that node is actually
 * indexed. `messenger.ts`/`local_socket.ts`/`content_provider.ts` normally
 * find their evidence exclusively in `unresolved_refs`, since a typical
 * project has no `android.os.Messenger`/`android.net.LocalSocket`/
 * `android.content.ContentProvider` source of its own; but a project that
 * DOES index real (or stub) SDK source for one of these types (a full AOSP
 * tree, or a synthetic fixture that defines them) resolves every reference
 * successfully, so it never reaches `unresolved_refs` at all, and all three
 * detectors silently lost their only evidence path for an otherwise
 * genuinely correct target.
 * This is the second evidence path that closes that gap: same shape as the
 * unresolved path (a `fromNode` to check with `isDirectMemberOfClass`), but
 * read from real graph edges instead. A resolved edge needs no separate
 * package check the way an unresolved reference does: the type node it
 * points at is already, unambiguously, the real
 * `{packageName}.{bareTypeName}`, so there is no "does this file's imports
 * actually reach it" question left to ask.
 */
export function findResolvedReferencesToType(
  cg: CodeGraph,
  packageName: string,
  bareTypeName: string,
  edgeKinds: EdgeKind[]
): ResolvedTypeReference[] {
  const typeNodes = cg.getNodesByQualifiedName(`${packageName}::${bareTypeName}`);
  if (typeNodes.length === 0) return [];
  const results: ResolvedTypeReference[] = [];
  for (const edge of cg.getIncomingEdgesTo(typeNodes.map((n) => n.id), edgeKinds)) {
    const fromNode = cg.getNode(edge.source);
    if (fromNode) results.push({ fromNode, edgeKind: edge.kind });
  }
  return results;
}

export interface GrepIndexedSourcesOptions {
  /**
   * Skip the comment-blanking pass entirely (default `true`, i.e. blanking
   * runs as before). A `//`-blanking pass over Java/Kotlin source cannot
   * tell a real line comment from a `//` inside a string literal; it
   * blanks BOTH, since it has no notion of string boundaries. That is fine
   * for callers scanning for code shapes (`addService(...)`,
   * `RegisterNatives(...)`), where a stray `//` inside an unrelated string
   * is not the target pattern anyway, but it actively breaks a caller
   * scanning specifically for a `content://` URI literal: the literal's own
   * `//` gets blanked exactly like a real comment, silently deleting
   * everything after it on that line, including the authority the caller
   * was searching for. Set `stripComments: false` for exactly that kind of scan. The
   * line-starts-with-comment-prefix skip below is unaffected either way:
   * it only rejects a line whose first non-whitespace characters ARE the
   * comment marker, which a URI embedded mid-line never matches.
   */
  stripComments?: boolean;
}

export function grepIndexedSources(
  cg: CodeGraph,
  repoRoot: string,
  languages: Language[],
  pattern: RegExp,
  patternLabel: string,
  options: GrepIndexedSourcesOptions = {}
): SourceGrepHit[] {
  const hits: SourceGrepHit[] = [];
  const languageSet = new Set(languages);
  const containedRoot = resolveContainedRepoRoot(repoRoot);
  const stripComments = options.stripComments ?? true;

  for (const file of cg.getFiles()) {
    if (!languageSet.has(file.language)) continue;
    const commentPrefix = LINE_COMMENT_PREFIX[file.language];
    const realFilePath = resolveContainedFilePath(containedRoot, file.path);
    if (!realFilePath) continue;
    let text: string;
    try {
      text = fs.readFileSync(realFilePath, 'utf-8');
    } catch {
      continue; // file removed/renamed since last index sync — skip, don't abort
    }
    const scanText = !stripComments
      ? text
      : COMMENT_STRIPPED_LANGUAGES.has(file.language)
      ? stripCLikeComments(text)
      : file.language === 'xml'
        ? stripXmlComments(text)
        : text;
    const lines = scanText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (commentPrefix && line.trimStart().startsWith(commentPrefix)) continue;
      if (pattern.test(line)) {
        hits.push({
          filePath: file.path,
          line: i + 1,
          matchedPattern: patternLabel,
          looksLikeTestPath: looksLikeTestPath(file.path) || undefined,
        });
      }
    }
  }
  return hits;
}
