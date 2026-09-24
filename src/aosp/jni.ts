/**
 * AOSP extension — JNI bridge discovery (Java/Kotlin native declaration ->
 * native C/C++ implementation).
 *
 * Unlike find_aidl_impl, this does NOT lean on `unresolved_refs`: that signal
 * fires for a broken extends/implements clause (a cross-language type that
 * never resolved), which is the AIDL Stub/Proxy shape. A `native`/`external`
 * method declaration is a leaf, not an extends clause — there's nothing for
 * the resolver to fail to resolve. Codex's review (2026-09-02) called this
 * out explicitly: JNI needs its own primary signal — the native declaration
 * paired with the `JNIEXPORT Java_*` naming convention or an explicit
 * `RegisterNatives` table entry — not a reuse of the AIDL signal.
 *
 * CodeGraph's Kotlin/Java extractors don't record the `external`/`native`
 * modifier on a method node (verified against src/extraction/languages/
 * kotlin.ts's getSignature/getVisibility — neither captures it), so the
 * declaration itself is found by reading the class's own source lines, the
 * same "read the domain-specific syntax CodeGraph doesn't model" approach
 * find_aidl_impl uses for `.aidl` files.
 *
 * Each hop (Java/Kotlin declaration -> JNI-convention name match -> explicit
 * RegisterNatives registration) is reported as INDEPENDENT evidence, per
 * Codex's guidance — a name-convention match alone is a weaker claim than a
 * confirmed RegisterNatives registration, and the two must not be collapsed
 * into a single boolean.
 */
import * as fs from 'fs';
import * as path from 'path';
import type CodeGraph from '../index';
import { grepIndexedSources, escapeRegExp, indexingCaveat, testPathEvidence, stripCLikeComments, type PackageReachability } from './common';

export interface NativeMethodDeclaration {
  methodName: string;
  filePath: string;
  line: number;
  declarationStyle: 'kotlin_external' | 'java_native';
}

export type JniCandidateKind = 'native_impl_match' | 'register_natives';

export interface JniCandidate {
  kind: JniCandidateKind;
  name: string;
  filePath: string;
  line: number;
  matchedPattern: string;
  /**
   * Only set on `register_natives` candidates. `RegisterNatives.*ClassName`
   * matches on the bare class name alone, so a source file that handles two
   * different packages' same-named class (e.g. `com.a.Foo` and `com.b.Foo`
   * both touched in one .cpp file) would let a registration for the WRONG
   * package corroborate this bridge purely by sharing a file (Red Team
   * round-1 finding, 2026-09-04). `verifyRegisterNativesTarget` below checks
   * the `env->FindClass("com/a/Foo")` argument feeding the call, when one can
   * be found nearby, against this class's actual package.
   */
  packageVerified?: PackageReachability;
  /**
   * Only set on `register_natives` candidates. Whether any of `className`'s
   * declared native method NAMES appears as a string literal near this
   * registration hit (the shape of a `JNINativeMethod` table entry, e.g.
   * `{"nativeGreet", "()Ljava/lang/String;", (void*)nativeGreet}`). This is
   * NOT proof that a specific declared method is registered — text near a
   * registration call can mention a method name for unrelated reasons, and a
   * real table can sit far enough away (a different function, a `#include`d
   * generated file) that this scan misses it — so it never gates `status` on
   * its own. It exists because `found`/`correlatedRegistrations` otherwise
   * combine "a native impl with SOME method exists" and "a RegisterNatives
   * call for this class exists" purely as two independent counts, which can
   * both be true for methods that have nothing to do with each other (Codex
   * round-4 Blue Team + Black Hat findings, 2026-09-05) — this is a partial,
   * best-effort signal surfaced so a reader isn't left with zero visibility
   * into whether method-level correlation looks plausible.
   */
  methodMentioned?: boolean;
}

export type FindJniBridgeStatus =
  | 'found' // native impl name-matched AND a RegisterNatives registration confirmed it
  | 'convention_derived_candidate' // name-matched a native impl, but no explicit registration found
  | 'no_bridge_found' // native declaration(s) exist but nothing on the native side matched
  | 'class_not_found';

export interface FindJniBridgeResult {
  className: string;
  nativeDeclarations: NativeMethodDeclaration[];
  nativeImplementations: JniCandidate[];
  registerNativesHits: JniCandidate[];
  evidence: string[];
  status: FindJniBridgeStatus;
}

const KOTLIN_EXTERNAL_FUN_RE = /\bexternal\s+fun\s+(\w+)\s*\(/;
const JAVA_NATIVE_METHOD_RE = /\bnative\s+[\w<>[\],.\s]+?\b(\w+)\s*\(/;

/**
 * Reads `filePath` (relative to `repoRoot`) at most once per `findJniBridge`
 * call and caches the result — every caller within that call gets the SAME
 * snapshot instead of re-reading the file fresh each time. This doesn't make
 * the read atomic with CodeGraph's index (the index itself can still be
 * stale relative to disk), but it does close the narrower window where
 * `findNativeDeclarations` and `verifyRegisterNativesTarget` independently
 * re-read the same file and could observe two DIFFERENT states of it if an
 * edit landed in between (White Hat round-4 finding, 2026-09-05: a
 * TOCTOU-shaped integrity gap an attacker with write access and precise
 * timing could exploit to make one read see planted evidence the other
 * doesn't, or vice versa).
 */
function makeFileCache(repoRoot: string): (filePath: string) => string | null {
  const cache = new Map<string, string | null>();
  return (filePath: string): string | null => {
    if (cache.has(filePath)) return cache.get(filePath)!;
    let text: string | null;
    try {
      text = fs.readFileSync(path.join(repoRoot, filePath), 'utf-8');
    } catch {
      text = null;
    }
    cache.set(filePath, text);
    return text;
  };
}

/**
 * The class's own source lines don't carry the modifier in CodeGraph's node
 * data (see module docstring), so this reads the file directly, strips
 * comments, and scans the class's line range rather than querying the graph.
 */
function findNativeDeclarations(
  filePath: string,
  startLine: number,
  endLine: number,
  readFile: (filePath: string) => string | null
): NativeMethodDeclaration[] {
  const text = readFile(filePath);
  if (text === null) return [];
  const lines = stripCLikeComments(text).split('\n');
  const declarations: NativeMethodDeclaration[] = [];

  for (let i = startLine - 1; i < Math.min(endLine, lines.length); i++) {
    const line = lines[i] ?? '';
    const kotlinMatch = KOTLIN_EXTERNAL_FUN_RE.exec(line);
    if (kotlinMatch?.[1]) {
      declarations.push({ methodName: kotlinMatch[1], filePath, line: i + 1, declarationStyle: 'kotlin_external' });
      continue;
    }
    const javaMatch = JAVA_NATIVE_METHOD_RE.exec(line);
    if (javaMatch?.[1]) {
      declarations.push({ methodName: javaMatch[1], filePath, line: i + 1, declarationStyle: 'java_native' });
    }
  }
  return declarations;
}

/**
 * JNI name mangling per the JNI spec's "Resolving Native Method Names":
 * `.` (package/class separator) -> `_`; a LITERAL `_` in the original
 * identifier -> `_1` (so it isn't confused with a separator); `;` -> `_2`
 * and `[` -> `_3` (signature characters, kept for spec completeness even
 * though they won't appear in a class/package name); everything else
 * outside `[A-Za-z0-9]` (notably `$`, the inner-class separator) -> `_0`
 * followed by the 4-hex-digit UTF-16 code unit, e.g. `$` (U+0024) -> `_00024`.
 *
 * The previous version only replaced `.` and `$` with a bare `_`, which
 * silently mis-mangled any package/class containing a literal underscore
 * (a real, if less common, false negative — code review finding, 2026-09-04).
 */
function jniMangle(qualifiedDotted: string): string {
  let out = '';
  for (const ch of qualifiedDotted) {
    if (ch === '_') out += '_1';
    else if (ch === '.') out += '_';
    else if (ch === ';') out += '_2';
    else if (ch === '[') out += '_3';
    else if (/[A-Za-z0-9]/.test(ch)) out += ch;
    else out += '_0' + ch.charCodeAt(0).toString(16).padStart(4, '0');
  }
  return out;
}

const FIND_CLASS_RE = /FindClass\s*\(\s*"([^"]+)"\s*\)/g;

/**
 * A `RegisterNatives` call site names a class only via a `jclass` value —
 * the actual FQCN lives a `FindClass("com/a/Foo")` call away, sometimes on
 * the same line (`RegisterNatives(env, env->FindClass("com/a/Foo"), ...)`),
 * more often a few lines above, assigned to a local the registration call
 * then references. This looks at the hit line plus a preceding window for
 * that `FindClass` argument and compares it (JNI's slash-separated internal
 * name converted to dotted form) against the class this bridge search is
 * actually about — the only way to tell apart a real registration for THIS
 * class from a same-file, same-bare-name registration for an unrelated
 * package's class of the same name (Red Team round-1 finding, 2026-09-04).
 *
 * Takes the LAST `FindClass(...)` match in the window (closest to the
 * `RegisterNatives` line), not the first — `windowText` is built
 * oldest-line-first, so a non-global regex's `exec()` (the previous version)
 * always returned the OLDEST match in a window containing more than one
 * `FindClass` call, which is the wrong end when a single .cpp file registers
 * several classes a few lines apart (a common real shape, e.g.
 * `android_util_*.cpp`/`android_view_*.cpp` files with multiple
 * `register_android_xxx()` functions) — that misattributed a completely
 * correct registration as a `mismatch` (Blue Team round-3 finding,
 * 2026-09-05, reproduced live via a Node REPL).
 *
 * Returns `'unverifiable'`, not `'mismatch'`, when no `FindClass(...)` is
 * found nearby — plenty of real registration code builds the `jclass` a
 * different way (a helper function, a cached global ref) that this
 * lightweight text scan can't follow, and treating "couldn't tell" as a
 * mismatch would turn currently-passing real bridges into false negatives.
 */
function verifyRegisterNativesTarget(
  hit: { filePath: string; line: number },
  expectedDottedFqcn: string,
  readFile: (filePath: string) => string | null
): PackageReachability {
  const text = readFile(hit.filePath);
  if (text === null) return 'unverifiable';
  const lines = text.split('\n');
  const WINDOW = 10;
  const start = Math.max(0, hit.line - 1 - WINDOW);
  const windowText = lines.slice(start, hit.line).join('\n');
  FIND_CLASS_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let lastMatch: RegExpExecArray | null = null;
  while ((match = FIND_CLASS_RE.exec(windowText)) !== null) {
    lastMatch = match;
  }
  if (!lastMatch?.[1]) return 'unverifiable';
  const foundDotted = lastMatch[1].replace(/\//g, '.');
  return foundDotted === expectedDottedFqcn ? 'verified' : 'mismatch';
}

/**
 * Best-effort check for whether ANY of `methodNames` appears as a string
 * literal near a `RegisterNatives`-family hit — the shape of a
 * `JNINativeMethod` table entry. A wider window than
 * `verifyRegisterNativesTarget`'s: the table is often declared well above
 * the registration call that consumes it, sometimes in a different function
 * in the same file. See `JniCandidate.methodMentioned`'s docstring for why
 * this is advisory only, never a status-gating signal on its own.
 */
function registrationMentionsAnyMethod(
  hit: { filePath: string; line: number },
  methodNames: string[],
  readFile: (filePath: string) => string | null
): boolean {
  if (methodNames.length === 0) return false;
  const text = readFile(hit.filePath);
  if (text === null) return false;
  const lines = text.split('\n');
  const WINDOW = 25;
  const start = Math.max(0, hit.line - 1 - WINDOW);
  const windowText = lines.slice(start, hit.line).join('\n');
  return methodNames.some((name) => windowText.includes(`"${name}"`));
}

/**
 * A `JNINativeMethod` table entry: `{"javaMethodName", "sig",
 * (void*)nativeFnName}`. Real AOSP platform JNI overwhelmingly registers
 * this way: an explicit table passed to `RegisterMethodsOrDie`/
 * `RegisterNatives`/`jniRegisterNativeMethods` with arbitrary C++ function
 * names, not the `Java_pkg_Class_method` naming convention
 * `evaluateJniBridgeForClass`'s primary signal (above) searches for. A
 * sample of 119 registration call sites under a real `frameworks/base`
 * `core/jni/` found ZERO `Java_*`-named functions and 100% table-based
 * registration, so without this, `find_jni_bridge` structurally could never
 * reach `found` on genuine AOSP platform code (found via a real benchmark,
 * 2026-09-06).
 *
 * Deliberately scoped to `candidateFiles` (the files a RegisterNatives-family
 * call ALREADY named this exact class in, computed by the caller), and then to
 * the table argument named by that call, rather than scanning every C/C++ file
 * for the bare method name: a real
 * `frameworks/base` checkout has 402 Java native-method names and 298 C/C++
 * function names that collide across unrelated classes, so an unscoped scan
 * could pull in a same-named method's implementation from a completely
 * different bridge and, combined with a package-verified registration
 * elsewhere, produce a false `found` (Codex review finding, 2026-09-06).
 * Restricting to the class's registered table keeps this signal tied to the
 * actual class being queried.
 *
 * Comments are stripped before matching (the same `stripCLikeComments` every
 * other text-candidate search in this module uses) so a table entry left in
 * a `//` or `/* ... *\/` comment does not count as live code (Codex review
 * finding, 2026-09-06: the previous version only skipped a `//`-prefixed
 * line, not a block comment or a same-line trailing comment).
 *
 * Only matches a SINGLE-LINE entry (the overwhelmingly common real shape,
 * verified against android_util_Process.cpp): an entry whose
 * `(void*)fnName` is wrapped onto the next line (rarer, seen when the
 * signature string itself is long) is not matched. This is a documented
 * gap, not a silent one: `matchedPattern` says so.
 */
const JNI_NATIVE_METHOD_TABLE_ENTRY_RE =
  /\{\s*"([A-Za-z_$][\w$]*)"\s*,\s*"[^"]*"\s*,\s*(?:\(\s*void\s*\*\s*\)\s*)?([A-Za-z_]\w*)\s*\}/;

interface NativeMethodTableEntry {
  javaMethodName: string;
  nativeFnName: string;
  filePath: string;
  line: number;
}

function splitNativeRegistrationArguments(line: string, openParen: number): string[] {
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = openParen + 1; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      current += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      current += ch;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (ch === ')' && depth === 0) {
        args.push(current.trim());
        return args;
      }
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  return args;
}

function registeredTableNames(
  hit: { filePath: string; line: number },
  className: string,
  readFile: (filePath: string) => string | null
): string[] {
  const text = readFile(hit.filePath);
  if (text === null) return [];
  const line = stripCLikeComments(text).split('\n')[hit.line - 1] ?? '';
  const apiRe = /\b(?:RegisterNatives|RegisterMethodsOrDie|jniRegisterNativeMethods)\s*\(/g;
  const classRe = new RegExp(
    '(?:^|[^A-Za-z0-9_$])' + escapeRegExp(className) + '(?:$|[^A-Za-z0-9_$])',
  );
  const tables: string[] = [];
  let apiMatch: RegExpExecArray | null;
  while ((apiMatch = apiRe.exec(line)) !== null) {
    const openParen = line.indexOf('(', apiMatch.index);
    if (openParen < 0) continue;
    const args = splitNativeRegistrationArguments(line, openParen);
    if (args.length < 3 || !classRe.test(args[1] ?? '')) continue;
    const table = (args[2] ?? '').match(/^(?:&\s*)?([A-Za-z_]\w*)$/)?.[1];
    if (table) tables.push(table);
  }
  return tables;
}

function collectRegisteredTables(
  registerHits: ReadonlyArray<{ filePath: string; line: number }>,
  className: string,
  readFile: (filePath: string) => string | null
): Map<string, Set<string>> {
  const tablesByFile = new Map<string, Set<string>>();
  for (const hit of registerHits) {
    const tableNames = registeredTableNames(hit, className, readFile);
    if (tableNames.length === 0) continue;
    const tables = tablesByFile.get(hit.filePath) ?? new Set<string>();
    for (const tableName of tableNames) tables.add(tableName);
    tablesByFile.set(hit.filePath, tables);
  }
  return tablesByFile;
}

function findNativeMethodTableEntries(
  cg: CodeGraph,
  repoRoot: string,
  wantedMethodNames: string[],
  candidateFiles: ReadonlySet<string>,
  registeredTablesByFile: ReadonlyMap<string, ReadonlySet<string>>
): NativeMethodTableEntry[] {
  if (wantedMethodNames.length === 0 || candidateFiles.size === 0) return [];
  const wanted = new Set(wantedMethodNames);
  const resolvedRepoRoot = path.resolve(repoRoot);
  const entries: NativeMethodTableEntry[] = [];
  for (const file of cg.getFiles()) {
    if (file.language !== 'c' && file.language !== 'cpp') continue;
    if (!candidateFiles.has(file.path)) continue;
    const absolutePath = path.resolve(resolvedRepoRoot, file.path);
    let text: string;
    try {
      text = fs.readFileSync(absolutePath, 'utf-8');
    } catch {
      continue; // file removed/renamed since last index sync — skip, don't abort
    }
    const lines = stripCLikeComments(text).split('\n');
    const registeredTables = registeredTablesByFile.get(file.path);
    if (!registeredTables || registeredTables.size === 0) continue;
    let activeTable: string | null = null;
    let braceDepth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!activeTable) {
        const declaration = line.match(/\bJNINativeMethod\s+([A-Za-z_]\w*)\s*\[\s*\]\s*=\s*\{/);
        if (declaration?.[1] && registeredTables.has(declaration[1])) {
          activeTable = declaration[1];
          braceDepth = 0;
        }
      }
      if (!activeTable) continue;
      const match = JNI_NATIVE_METHOD_TABLE_ENTRY_RE.exec(line);
      if (match) {
        const [, javaMethodName, nativeFnName] = match;
        if (javaMethodName && nativeFnName && wanted.has(javaMethodName)) {
          entries.push({ javaMethodName, nativeFnName, filePath: file.path, line: i + 1 });
        }
      }
      braceDepth += (line.match(/\{/g) ?? []).length;
      braceDepth -= (line.match(/\}/g) ?? []).length;
      if (braceDepth <= 0) activeTable = null;
    }
  }
  return entries;
}

interface ClassNodeForJni {
  filePath: string;
  startLine: number;
  endLine: number;
  qualifiedName: string;
  name: string;
}

/**
 * Splits a CodeGraph `qualifiedName` (`pkg::Outer::Inner` for a nested
 * class, or a bare name with no `::` at all) into the dotted package and the
 * JVM binary class name (`Outer$Inner`) mangling actually operates on.
 *
 * The previous version took only `qualifiedName.split('::')[0]` as the
 * package and used the bare `className` the caller passed in for
 * everything else — for a nested class (`IFoo.Stub`, `Handler.Callback`,
 * routine Android idioms), that silently dropped the ENTIRE outer-class
 * chain a real JNI symbol must encode as `Outer_00024Inner`. A native
 * method declared inside a nested class was therefore structurally
 * unfindable — not degraded confidence, a hard miss with no signal that the
 * search itself was malformed (Red Team round-4 finding, 2026-09-05).
 */
function classBinaryNameAndPackage(classNode: ClassNodeForJni): { packageName?: string; classBinaryName: string } {
  const parts = classNode.qualifiedName.split('::');
  if (parts.length > 1) {
    return { packageName: parts[0], classBinaryName: parts.slice(1).join('$') };
  }
  return { classBinaryName: classNode.name };
}

interface JniBridgeEvaluation {
  nativeDeclarations: NativeMethodDeclaration[];
  nativeImplementations: JniCandidate[];
  registerNativesHits: JniCandidate[];
  evidence: string[];
  status: FindJniBridgeStatus;
}

/**
 * Evaluate one candidate class node for a JNI bridge. Split out of
 * `findJniBridge` so multiple same-named class nodes (see that function's
 * docstring) can each be tried independently and the strongest result kept,
 * rather than the first exact-name match winning unconditionally regardless
 * of whether it actually has anything to do with JNI (Black Hat round-4
 * finding, 2026-09-05).
 */
function evaluateJniBridgeForClass(
  cg: CodeGraph,
  repoRoot: string,
  className: string,
  classNode: ClassNodeForJni,
  readFile: (filePath: string) => string | null
): JniBridgeEvaluation {
  const evidence: string[] = [];
  const nativeDeclarations = findNativeDeclarations(
    classNode.filePath,
    classNode.startLine,
    classNode.endLine,
    readFile
  );
  evidence.push(
    `native/external declaration scan: ${classNode.filePath}:${classNode.startLine}-${classNode.endLine} ` +
      `(${nativeDeclarations.length} hit(s) — read directly, CodeGraph's Kotlin/Java nodes don't carry this modifier)`
  );

  const { packageName, classBinaryName } = classBinaryNameAndPackage(classNode);
  // jniMangle() handles BOTH the `.` package separator and the `$`
  // inner-class separator (mangled to `_00024` per the JNI spec, since `$`
  // is outside `[A-Za-z0-9]`) — mangling the fully-dotted form in one pass
  // keeps that single source of truth instead of mangling package and class
  // name separately and gluing the pieces back together by hand.
  const fullyQualifiedForMangling = packageName ? `${packageName}.${classBinaryName}` : classBinaryName;
  const mangledClass = jniMangle(fullyQualifiedForMangling);
  const expectedDottedFqcn = packageName ? `${packageName}.${classBinaryName}` : undefined;

  const nativeImplementations: JniCandidate[] = [];
  for (const decl of nativeDeclarations) {
    // The method name itself can carry a literal underscore just as a
    // package/class name can — mangle it too, not just the class portion
    // (Red Team round-4 finding, 2026-09-05: the previous version left
    // `decl.methodName` unmangled).
    const mangledMethod = jniMangle(decl.methodName);
    const jniSymbol = `Java_${mangledClass}_${mangledMethod}`;
    const matches = cg.searchNodes(jniSymbol, { kinds: ['function'], limit: 20 });
    if (matches.length === 20) evidence.push(`WARNING: searchNodes("${jniSymbol}") 결과가 20개 제한에 도달해 추가 매치가 있을 수 있습니다`);
    for (const { node } of matches) {
      if (node.name === jniSymbol) {
        // Non-overloaded short form: Java_pkg_Class_method.
        nativeImplementations.push({
          kind: 'native_impl_match',
          name: node.name,
          filePath: node.filePath,
          line: node.startLine,
          matchedPattern: `exact JNI symbol match: ${jniSymbol} (for ${decl.methodName})`,
        });
      } else if (node.name.startsWith(`${jniSymbol}__`)) {
        // Overloaded native method: JNI appends a mangled type-descriptor
        // suffix (`__<signature>`) to disambiguate overloads. The previous
        // version only checked the exact short name, so a legitimately
        // bridged overloaded method reported no_bridge_found (code review
        // finding, 2026-09-04). This doesn't verify the suffix matches the
        // DECLARED overload's actual parameter types — that needs a JVM
        // descriptor computed from the Kotlin/Java signature, which CodeGraph
        // doesn't expose here — so it's still a convention-derived match, not
        // a full proof for a specific overload.
        nativeImplementations.push({
          kind: 'native_impl_match',
          name: node.name,
          filePath: node.filePath,
          line: node.startLine,
          matchedPattern: `long-form (overloaded) JNI symbol match: ${node.name} (prefix ${jniSymbol}__, for ${decl.methodName})`,
        });
      }
    }
  }
  evidence.push(
    `JNI naming-convention search: Java_${mangledClass}_<method> (and long-form Java_..._<method>__<sig> ` +
      `for overloads) for each declared native method ` +
      `(${nativeImplementations.length} exact match(es) — secondary signal, name convention only, not confirmed registration)`
  );

  // The registration-table wrapper helpers AOSP platform code actually uses
  // are at least as common as a bare `RegisterNatives` call — a bare-call
  // scan alone missed every bridge wired through one of these, reporting a
  // real registration as `no confirmed registration` (Green Team round-4
  // finding, 2026-09-05). Computed BEFORE the JNINativeMethod table scan
  // below so that scan can be restricted to files and table arguments this
  // search already corroborated for THIS class (see findNativeMethodTableEntries's
  // docstring for why an unscoped table scan is unsafe).
  const declaredMethodNames = nativeDeclarations.map((d) => d.methodName);
  const registerHits = grepIndexedSources(
    cg,
    repoRoot,
    ['c', 'cpp'],
    new RegExp(`(RegisterNatives|RegisterMethodsOrDie|jniRegisterNativeMethods).*${escapeRegExp(className)}`),
    `(RegisterNatives|RegisterMethodsOrDie|jniRegisterNativeMethods).*${className}`
  );
  const registerNativesHits: JniCandidate[] = registerHits.map((hit) => ({
    kind: 'register_natives',
    name: className,
    filePath: hit.filePath,
    line: hit.line,
    matchedPattern: hit.matchedPattern,
    packageVerified: expectedDottedFqcn
      ? verifyRegisterNativesTarget(hit, expectedDottedFqcn, readFile)
      : 'unverifiable',
    methodMentioned: registrationMentionsAnyMethod(hit, declaredMethodNames, readFile),
  }));
  evidence.push(
    `RegisterNatives-family registration search: (RegisterNatives|RegisterMethodsOrDie|jniRegisterNativeMethods).*${className} ` +
      `over CodeGraph-indexed c/cpp sources (${registerNativesHits.length} hit(s) — highest-confidence native-side signal)`
  );
  const registrationTestPathNote = testPathEvidence(registerHits);
  if (registrationTestPathNote) evidence.push(registrationTestPathNote);

  // AOSP platform JNI overwhelmingly registers via an explicit
  // JNINativeMethod table rather than the Java_pkg_Class_method naming
  // convention above (see findNativeMethodTableEntries's docstring): search
  // for a table entry naming one of THIS class's declared native methods,
  // restricted to files the registration search just above already named
  // this class in, and resolve its function-pointer column to an indexed
  // function definition. A resolved entry is added to nativeImplementations
  // exactly like a naming-convention match, so it participates in the same
  // same-file/FindClass registration correlation below.
  const registrationFiles = new Set(registerHits.map((hit) => hit.filePath));
  const registeredTablesByFile = collectRegisteredTables(registerHits, className, readFile);
  const tableEntries = findNativeMethodTableEntries(
    cg,
    repoRoot,
    declaredMethodNames,
    registrationFiles,
    registeredTablesByFile,
  );
  let tableMatchCount = 0;
  for (const entry of tableEntries) {
    const fnMatches = cg.searchNodes(entry.nativeFnName, { kinds: ['function'], limit: 5 });
    const exactFnMatches = fnMatches
      .filter((m) => m.node.name === entry.nativeFnName)
      .map((m) => m.node);
    // A table points at a function symbol, not merely a spelling. If the
    // index contains duplicate definitions, choosing the first one would
    // fabricate a bridge; leave the entry as candidate evidence instead.
    if (exactFnMatches.length !== 1) continue;
    const fnNode = exactFnMatches[0]!;
    tableMatchCount++;
    nativeImplementations.push({
      kind: 'native_impl_match',
      name: fnNode.name,
      filePath: fnNode.filePath,
      line: fnNode.startLine,
      matchedPattern: `JNINativeMethod table entry: {"${entry.javaMethodName}", ..., (void*)${entry.nativeFnName}} ` +
        `at ${entry.filePath}:${entry.line} (for ${entry.javaMethodName})`,
    });
  }
  evidence.push(
    `JNINativeMethod table search (single-line entries correlated to the registration table argument, scoped to ${registrationFiles.size} file(s) already ` +
      `named by the registration search above): ${tableMatchCount} declared method(s) matched to a resolved ` +
      `native function (${tableEntries.length} raw table entry hit(s) before function-definition resolution)`
  );

  const mismatchedRegistrations = registerNativesHits.filter((c) => c.packageVerified === 'mismatch');
  if (mismatchedRegistrations.length > 0) {
    evidence.push(
      `${mismatchedRegistrations.length} of those registration hit(s) matched the bare class name "${className}" ` +
        `but the nearby FindClass(...) argument names a different package — excluded, this would otherwise let a ` +
        'same-file, same-named class from an unrelated package corroborate this bridge (Red Team round-1 finding, 2026-09-04)'
    );
  }
  const noMethodMentionCount = registerNativesHits.filter((c) => c.packageVerified !== 'mismatch' && !c.methodMentioned).length;
  if (noMethodMentionCount > 0) {
    evidence.push(
      `${noMethodMentionCount} of those registration hit(s) don't mention any of this class's declared native ` +
        `method name(s) as a nearby string literal — "found" below is still a CLASS-level correlation (a native ` +
        `impl exists for SOME declared method, and a registration call exists for this class), not proof that the ` +
        'SAME method is what got registered (Codex round-4 Blue Team + Black Hat findings, 2026-09-05)'
    );
  }

  // A registration hit corroborates THIS bridge either because it was
  // package-verified (its FindClass(...) argument names this exact class,
  // regardless of file — see verifyRegisterNativesTarget), or, failing that,
  // because it's in the SAME FILE as a native-impl name match — a
  // RegisterNatives line mentioning this class elsewhere in the repo (a
  // comment, an unrelated registration table, a different overload set) is
  // not evidence for THIS bridge on its own (code review finding,
  // 2026-09-04: the previous version combined any impl match with any
  // registration hit anywhere in the repo). Same-file correlation is still
  // not full method/signature-level proof; a package mismatch always
  // disqualifies a hit even if it happens to share a file.
  const implFiles = new Set(nativeImplementations.map((c) => c.filePath));
  const correlatedRegistrations = registerNativesHits.filter(
    (c) => c.packageVerified === 'verified' || (c.packageVerified !== 'mismatch' && implFiles.has(c.filePath))
  );
  if (correlatedRegistrations.length > 0) {
    evidence.push(
      `${correlatedRegistrations.length} of those registration hit(s) corroborate this bridge ` +
        '(package-verified via FindClass(...), or same-file correlation with a native-impl match — ' +
        'still not full method/signature proof)'
    );
  }

  let status: FindJniBridgeStatus;
  if (nativeDeclarations.length === 0) {
    status = 'no_bridge_found';
  } else if (nativeImplementations.length > 0 && correlatedRegistrations.length > 0) {
    status = 'found';
  } else if (nativeImplementations.length > 0 || registerNativesHits.length > 0) {
    status = 'convention_derived_candidate';
  } else {
    status = 'no_bridge_found';
  }

  return { nativeDeclarations, nativeImplementations, registerNativesHits, evidence, status };
}

const STATUS_RANK: Record<FindJniBridgeStatus, number> = {
  class_not_found: 0,
  found: 3,
  convention_derived_candidate: 2,
  no_bridge_found: 1,
};

/**
 * Find the Java/Kotlin native declarations in `className`, then search for a
 * matching native implementation by the `Java_<package>_<Class>_<method>`
 * naming convention and an explicit `RegisterNatives` registration —
 * independently, per Codex's review: a name match alone is not the same
 * claim as a confirmed registration.
 */
export function findJniBridge(cg: CodeGraph, repoRoot: string, className: string): FindJniBridgeResult {
  const evidence: string[] = [];
  const caveat = indexingCaveat(cg);
  if (caveat) evidence.push(caveat);
  const readFile = makeFileCache(repoRoot);

  const classMatches = cg.searchNodes(className, { kinds: ['class'], limit: 20 });
  if (classMatches.length === 20) evidence.push(`WARNING: searchNodes("${className}") 결과가 20개 제한에 도달해 추가 매치가 있을 수 있습니다`);
  // Exact match only — searchNodes is FTS/fuzzy, so falling back to its first
  // hit when no exact match exists (the previous behavior) silently swapped
  // in an unrelated class (e.g. "FooManager" for a "Foo" query) and reported
  // findings against it. Report class_not_found instead (code review
  // finding, 2026-09-04) — the same fail-closed discipline the native-impl
  // search below already applies.
  const exactMatches = classMatches.filter((m) => m.node.name === className).map((m) => m.node);

  if (exactMatches.length === 0) {
    evidence.push(`no class node named "${className}" found in the index`);
    return {
      className,
      nativeDeclarations: [],
      nativeImplementations: [],
      registerNativesHits: [],
      evidence,
      status: 'class_not_found',
    };
  }

  // `className` is a bare, unqualified name — a legitimate input given this
  // tool's contract, but with no package/FQCN there's no way to tell WHICH
  // same-named class across different packages the caller actually meant.
  // The previous version picked `classMatches.find(...)`'s first hit
  // unconditionally; a decoy class sharing the bare name but with no real
  // JNI bridge (or, worse, a DIFFERENT class's bridge) could silently be
  // reported as this one's result (Black Hat round-4 finding, 2026-09-05).
  // Evaluating every exact-name candidate and keeping the strongest result
  // doesn't recover the caller's true intent — it can't, from a bare name
  // alone — but it stops an arbitrary pick from masquerading as a specific
  // answer, and the evidence below names every candidate considered.
  if (exactMatches.length > 1) {
    evidence.push(
      `${exactMatches.length} class(es) named "${className}" found in the index ` +
        `(${exactMatches.map((n) => n.qualifiedName).join(', ')}) — no package/FQCN was given to disambiguate, ` +
        'so each is evaluated independently and the strongest result is used; see which one below'
    );
  }

  let best: JniBridgeEvaluation | null = null;
  let bestNode: ClassNodeForJni | null = null;
  for (const classNode of exactMatches) {
    const result = evaluateJniBridgeForClass(cg, repoRoot, className, classNode, readFile);
    if (!best || STATUS_RANK[result.status] > STATUS_RANK[best.status]) {
      best = result;
      bestNode = classNode;
    }
    if (best.status === 'found') break;
  }
  if (exactMatches.length > 1 && bestNode) {
    evidence.push(`selected candidate: ${bestNode.qualifiedName} (${bestNode.filePath}:${bestNode.startLine})`);
  }

  return {
    className,
    nativeDeclarations: best!.nativeDeclarations,
    nativeImplementations: best!.nativeImplementations,
    registerNativesHits: best!.registerNativesHits,
    evidence: [...evidence, ...best!.evidence],
    status: best!.status,
  };
}
