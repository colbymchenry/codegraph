/**
 * Name Matcher
 *
 * Handles symbol name matching for reference resolution.
 */

import * as path from 'path';
import { Language, Node } from '../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext, isSupertypeTarget, CPP_DEFINE_SIGNATURE, isInheritanceRef, isImportableKind } from './types';
import { blankStringContents, stripCommentsForRegex } from './strip-comments';
import { JS_BUILT_INS, JS_BUILTIN_METHODS, TS_PRIMITIVE_TYPES } from './js-builtins';
import { SWIFT_TYPE_PATH_CALL, resolveSwiftTypePathCall } from './swift-type-visibility';
/**
 * Ceiling on how many same-named definitions a FUZZY name-match strategy will
 * score. A name defined more times than this is "ubiquitous" — a method/symbol
 * re-declared across a vendored theme or SDK (e.g. `init`/`update`/`render` on
 * every widget of a committed Metronic theme — #999). No directory-proximity or
 * receiver-word-overlap score can reliably pick THE one true target among
 * thousands, so the fuzzy strategies (matchByExactName's findBestMatch, and
 * matchMethodCall Strategy 3) decline above the ceiling instead of emitting a
 * low-confidence, almost-certainly-wrong edge. This also caps their per-ref cost
 * at O(ceiling): without it, K same-named refs each scored K candidates — the
 * O(K²) blow-up that pinned a core for 15-28 min at "Resolving refs … 94%" on a
 * repo vendoring a large JS/TS theme (#999). The PRECISE strategies are
 * unaffected: qualified-name, import-based, and class-name (Strategy 1/2)
 * resolution all still run and resolve a ubiquitous name when the context names
 * its exact target. Real repos top out near ~40 same-named methods, so a normal
 * codebase never reaches this; only bulk-vendored code does. Tune via
 * `CODEGRAPH_AMBIGUOUS_NAME_CEILING`.
 */
const DEFAULT_AMBIGUOUS_NAME_CEILING = 500;
function resolveAmbiguousNameCeiling(): number {
  const raw = process.env.CODEGRAPH_AMBIGUOUS_NAME_CEILING;
  if (!raw) return DEFAULT_AMBIGUOUS_NAME_CEILING;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AMBIGUOUS_NAME_CEILING;
}
const AMBIGUOUS_NAME_CEILING = resolveAmbiguousNameCeiling();

/**
 * Try to resolve a path-like reference (e.g., "snippets/drawer-menu.liquid")
 * by matching the filename against file nodes.
 */
export function matchByFilePath(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Path-like (`a/b.liquid`) OR a bare filename ending in a short extension
  // (`Foo.h` — an Objective-C `#import "Foo.h"`, resolved to the header by
  // basename). A bare ref WITHOUT an extension is a symbol name, not a file, so
  // leave it to the symbol-matching strategies.
  if (!ref.referenceName.includes('/') && !/\.[A-Za-z][A-Za-z0-9]{0,3}$/.test(ref.referenceName)) {
    return null;
  }

  // Extract the filename from the path
  const fileName = ref.referenceName.split('/').pop();
  if (!fileName) return null;

  // Search for file nodes with this name
  const candidates = context.getNodesByName(fileName);
  const fileNodes = candidates.filter(n => n.kind === 'file');

  if (fileNodes.length === 0) return null;

  // Prefer exact path match on qualified_name
  const exactMatch = fileNodes.find(n => n.qualifiedName === ref.referenceName || n.filePath === ref.referenceName);
  if (exactMatch) {
    return {
      original: ref,
      targetNodeId: exactMatch.id,
      confidence: 0.95,
      resolvedBy: 'file-path',
    };
  }

  // Fall back to suffix match (e.g., ref="snippets/foo.liquid" matches
  // "src/snippets/foo.liquid"). When several files share the basename — a
  // `#include "RNCAsyncStorage.h"` with a same-named header on another platform
  // (windows/code/ vs apple/) — prefer the one in the includer's own directory,
  // then by directory proximity / same language family. A C/C++ include (and any
  // bare-filename import) resolves relative to the including file, not to an
  // arbitrary same-named header elsewhere in the tree.
  const suffixMatches = fileNodes.filter(
    n => n.qualifiedName.endsWith(ref.referenceName) || n.filePath.endsWith(ref.referenceName)
  );
  if (suffixMatches.length > 0) {
    return {
      original: ref,
      targetNodeId: pickClosestFileNode(suffixMatches, ref).id,
      confidence: 0.85,
      resolvedBy: 'file-path',
    };
  }

  // If only one file node with this name, use it with lower confidence
  if (fileNodes.length === 1) {
    return {
      original: ref,
      targetNodeId: fileNodes[0]!.id,
      confidence: 0.7,
      resolvedBy: 'file-path',
    };
  }

  return null;
}

/**
 * Among several file nodes that all match a bare include/import by basename,
 * pick the one closest to the referencing file: same directory first, then by
 * directory-tree proximity, with the same language family as a tiebreak. A
 * C/C++ `#include "X.h"` (and any bare-filename import) resolves relative to the
 * including file — not to an arbitrary same-named header on another platform.
 */
function pickClosestFileNode(candidates: Node[], ref: UnresolvedRef): Node {
  const dirOf = (p: string): string => {
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(0, i) : '';
  };
  const refDir = dirOf(ref.filePath);
  const sameDir = candidates.filter((c) => dirOf(c.filePath) === refDir);
  const pool = sameDir.length > 0 ? sameDir : candidates;
  let best = pool[0]!;
  let bestScore = -Infinity;
  for (const c of pool) {
    const score =
      computePathProximity(ref.filePath, c.filePath) +
      (sameLanguageFamily(c.language, ref.language) ? 5 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/**
 * Language families that share a type system / runtime, so a same-language-only
 * reference may still resolve across them (a Kotlin `Foo.BAR` can name a Java
 * `Foo`). Anything not listed forms its own singleton family.
 */
const LANGUAGE_FAMILY: Record<string, string> = {
  java: 'jvm', kotlin: 'jvm', scala: 'jvm',
  swift: 'native', objc: 'native',
  // ArkTS is a TS superset — every HarmonyOS project mixes `.ets` UI with
  // `.ts` logic modules, so refs must cross freely between them.
  typescript: 'web', tsx: 'web', javascript: 'web', jsx: 'web', arkts: 'web',
  c: 'native', cpp: 'native',
  // Razor/Blazor markup names C# types — same family so `@model Foo` /
  // `<MyComponent/>` resolve to their `.cs` class through the cross-family gate.
  csharp: 'dotnet', razor: 'dotnet', vbnet: 'dotnet',
  svelte: 'web', vue: 'web', astro: 'web',
  cfml: 'cfml', cfscript: 'cfml',
};
export function sameLanguageFamily(a: string, b: string): boolean {
  if (a === b) return true;
  const fa = LANGUAGE_FAMILY[a];
  return fa !== undefined && fa === LANGUAGE_FAMILY[b];
}
/** Config/markup transitions stay open; every other code language has a family. */
const CODE_FAMILY: Record<string, string> = {
  ...LANGUAGE_FAMILY,
  python: 'python', go: 'go', rust: 'rust', php: 'php', ruby: 'ruby', dart: 'dart',
  lua: 'lua', luau: 'lua', r: 'r', erlang: 'erlang', pascal: 'pascal', solidity: 'solidity',
  nix: 'nix', cobol: 'cobol',
};

export function crossesCodeBoundary(a: string, b: string): boolean {
  return CODE_FAMILY[a] !== undefined && CODE_FAMILY[b] !== undefined &&
    CODE_FAMILY[a] !== CODE_FAMILY[b];
}

/**
 * Cross-family name matches need a framework export or an actual ABI boundary,
 * not merely a native caller. ABI evidence is scoped to the named free function.
 */
function hasBridgeEvidence(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.referenceKind !== 'calls') return false;
  // Expo's extractor creates explicit JS exports, resolved by the ordinary
  // name matcher rather than a framework resolve() branch.
  if (CODE_FAMILY[ref.language] === 'web' && candidate.id.startsWith('expo-module:') &&
      candidate.isExported && (candidate.language === 'swift' || candidate.language === 'kotlin')) return true;
  if (candidate.kind !== 'function') return false;
  const name = candidate.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (CODE_FAMILY[ref.language] === 'native') {
    const source = context.readFile(candidate.filePath);
    if (!source) return false;
    if (candidate.language === 'go') {
      const declaration = source.split('\n').slice(Math.max(0, candidate.startLine - 2), candidate.endLine).join('\n');
      return /\bimport\s+(?:\(\s*)?"C"/.test(stripCommentsForRegex(source, 'go')) &&
        new RegExp('^//export ' + name + '\\r?\\nfunc ' + name + '\\s*\\(', 'm').test(declaration);
    }
    if (candidate.language === 'rust') {
      const declaration = source.split('\n').slice(candidate.startLine - 1, candidate.endLine).join('\n');
      return new RegExp('\\bpub\\s+extern\\s+"C"\\s+fn\\s+' + name + '\\b')
        .test(stripCommentsForRegex(declaration, 'rust'));
    }
  }
  if (candidate.language === 'c' || candidate.language === 'cpp') {
    const source = context.readFile(ref.filePath);
    if (!source) return false;
    if (ref.language === 'go') {
      return /\bimport\s+(?:\(\s*)?"C"/.test(stripCommentsForRegex(source, 'go')) &&
        ref.referenceName === 'C.' + candidate.name;
    }
    if (ref.language === 'rust') {
      return new RegExp('extern\\s+"C"\\s*\\{[^}]*\\bfn\\s+' + name + '\\s*\\(')
        .test(stripCommentsForRegex(source, 'rust'));
    }
  }
  return false;
}

/**
 * Per-context memo: node id → its language, for gateLanguageMatch. Matches
 * land on ~5 refs per target on vscode, and each check otherwise fetched the
 * whole node (a point read + row decode past the query layer's small cache)
 * only to read one field. Nodes are fixed within a resolution pass; the memo
 * drops with clearNameMatcherMemos.
 */
const TARGET_LANGUAGE = new WeakMap<ResolutionContext, Map<string, string>>();

/** Reject the chosen result without shrinking a pool or trying a replacement. */
export function gateLanguageMatch(
  result: ResolvedRef | null,
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (!result) return result;
  // No code family on the reference's side: no target can cross a boundary.
  if (CODE_FAMILY[ref.language] === undefined) return result;
  if (context.getNodeById) {
    let languages = TARGET_LANGUAGE.get(context);
    if (!languages) {
      languages = new Map();
      TARGET_LANGUAGE.set(context, languages);
    }
    let language = languages.get(result.targetNodeId);
    if (language === undefined) {
      const node = context.getNodeById(result.targetNodeId);
      if (node) {
        language = node.language as string;
        if (languages.size >= 400_000) languages.clear();
        languages.set(result.targetNodeId, language);
      }
    }
    if (language !== undefined) {
      if (!crossesCodeBoundary(ref.language, language)) return result;
      const target = context.getNodeById(result.targetNodeId);
      return target && !hasBridgeEvidence(target, ref, context) ? null : result;
    }
  }
  const target = context.getNodeById?.(result.targetNodeId) ??
    context.getNodesByName(ref.referenceName).find((n) => n.id === result.targetNodeId);
  if (target && crossesCodeBoundary(ref.language, target.language) &&
      !hasBridgeEvidence(target, ref, context)) return null;
  return result;
}

/** Member values retain their receiver; never break ties by file order (#1820). */
function matchMemberFunctionRef(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const dot = ref.referenceName.lastIndexOf('.');
  const receiver = ref.referenceName.slice(0, dot);
  const member = ref.referenceName.slice(dot + 1);
  const result = (nodes: Node[], confidence = 0.9): ResolvedRef | null => {
    const pool = nodes.filter(n => sameLanguageFamily(n.language, ref.language));
    const target = pool.length === 1 ? pool[0] : undefined;
    return target && (target.kind === 'function' || target.kind === 'method') &&
      target.id !== ref.fromNodeId && !isPythonProperty(target, context)
      ? { original: ref, targetNodeId: target.id, confidence, resolvedBy: 'function-ref' }
      : null;
  };
  const imports = context.getImportMappings(ref.filePath, ref.language);
  // An import is authoritative even when it points outside the project.
  if (imports.some(i => i.localName === receiver.split('.')[0])) {
    if (ref.language === 'python') {
      const cls = pythonRefClass(receiver, ref, context);
      if (cls) return result(pythonMembers(cls, member, ref, context));
    }
    const imported = context.resolveImport?.(ref);
    const node = imported && context.getNodeById?.(imported.targetNodeId);
    return node ? result(context.getNodesByQualifiedName(node.qualifiedName).filter(n => n.filePath === node.filePath)) : null;
  }
  if (ref.language === 'go') {
    if (receiver.includes('.')) return matchGoFieldChainCall(receiver, member, ref, context);
    const type = inferLocalReceiverType(receiver, ref, context);
    if (type) return resolveMethodOnType(type, member, ref, context, 0.9, 'function-ref');
    const types = context.getNodesByName(receiver).filter(n => n.language === 'go' && (n.kind === 'struct' || n.kind === 'interface'));
    if (types.length) return types.length === 1 ? resolveMethodOnType(receiver, member, ref, context, 0.9, 'function-ref') : null;
  } else {
    const owner = context.getNodesInFile(ref.filePath).filter(n =>
      n.kind === 'class' && n.startLine <= ref.line && n.endLine >= ref.line)
      .sort((a, b) => b.startLine - a.startLine)[0];
    let type: string | null = null;
    if (receiver === 'self' || receiver === 'cls') {
      return owner ? result(pythonMembers(owner, member, ref, context)) : null;
    }
    if (/^(self|cls)\.\w+$/.test(receiver)) {
      if (!owner) return null;
      type = pythonFieldType(receiver, owner, ref, context);
    } else {
      type = pythonLocalType(receiver, ref, context);
    }
    // A type name used directly (`Store.fetch`) is scoped just like an annotation.
    if (!type && /^[A-Z]\w*$/.test(receiver)) type = receiver;
    if (type && type !== 'object' && type !== 'Any') {
      const cls = pythonRefClass(type, ref, context);
      if (!cls) return null;
      const members = pythonMembers(cls, member, ref, context);
      if (members.length) return result(members);
      // A base-typed field can hold a subclass-only method (the reported case).
      // Keep only descendants of THAT base; unrelated same-name methods cannot win.
      const candidates = context.getNodesByName(member).filter(n => n.kind === 'method' && n.language === 'python');
      const descendants = candidates.filter(n => {
        const parent = context.getNodesInFile(n.filePath).find(c =>
          c.kind === 'class' && n.qualifiedName === `${c.qualifiedName}::${member}`);
        return parent && pythonDerivesFrom(parent, cls, ref, context);
      });
      return result(descendants, 0.8);
    }
  }
  // Unknown receivers retain the old unique-or-drop discipline, across ALL
  // files. Tests and abstract-looking bodies are candidates too.
  return result(context.getNodesByName(member), 0.8);
}

function pythonRefClass(name: string, ref: UnresolvedRef, context: ResolutionContext): Node | null {
  const imports = context.getImportMappings(ref.filePath, 'python');
  if (imports.some(i => i.localName === name.split('.')[0])) {
    const hit = context.resolveImport?.({ ...ref, referenceName: name, referenceKind: 'references' });
    const node = hit && context.getNodeById?.(hit.targetNodeId);
    return node?.kind === 'class' && context.getNodesByQualifiedName(node.qualifiedName)
      .filter(n => n.kind === 'class' && n.filePath === node.filePath).length === 1 ? node : null;
  }
  const classes = context.getNodesByName(name).filter(n => n.kind === 'class' && n.filePath === ref.filePath);
  return classes.length === 1 ? classes[0]! : null;
}

function pythonBases(cls: Node, ref: UnresolvedRef, context: ResolutionContext): Node[] {
  const line = context.getFileLines?.(cls.filePath)?.[cls.startLine - 1]
    ?? context.readFile(cls.filePath)?.split('\n')[cls.startLine - 1] ?? '';
  const bases = line.match(/^\s*class\s+\w+\s*\(([^)]*)\)/)?.[1];
  return (bases?.split(',') ?? []).flatMap(name => {
    const base = pythonRefClass(name.trim(), { ...ref, filePath: cls.filePath }, context);
    return base ? [base] : [];
  });
}

function pythonDerivesFrom(cls: Node, base: Node, ref: UnresolvedRef, context: ResolutionContext, seen = new Set<string>()): boolean {
  if (seen.has(cls.id) || seen.size >= 16) return false;
  seen.add(cls.id);
  return pythonBases(cls, ref, context).some(p => p.id === base.id || pythonDerivesFrom(p, base, ref, context, seen));
}

function pythonMembers(cls: Node, member: string, ref: UnresolvedRef, context: ResolutionContext, seen = new Set<string>()): Node[] {
  if (seen.has(cls.id) || seen.size >= 16) return [];
  seen.add(cls.id);
  // Instance assignments also shadow methods, even though they are not nodes.
  const body = pythonMemberLines(cls.filePath, context).slice(cls.startLine - 1, cls.endLine).join('\n');
  if (new RegExp(`^\\s*(?:(?:self|cls)\\.)?${member}\\s*(?:=|:)`, 'm').test(body)) return [cls];
  const own = context.getNodesByQualifiedName(`${cls.qualifiedName}::${member}`).filter(n => n.filePath === cls.filePath);
  if (own.length) return own;
  return [...new Map(pythonBases(cls, ref, context).flatMap(p => pythonMembers(p, member, ref, context, seen)).map(n => [n.id, n])).values()];
}

function isPythonProperty(node: Node, context: ResolutionContext): boolean {
  if (node.language !== 'python' || node.kind !== 'method') return false;
  const lines = context.getFileLines?.(node.filePath) ?? context.readFile(node.filePath)?.split('\n') ?? [];
  for (let i = node.startLine - 2; i >= 0 && lines[i]!.trim().startsWith('@'); i--) {
    if (/^\s*@(?:property|(?:functools\.)?cached_property)\s*$/.test(lines[i]!)) return true;
  }
  return false;
}

const PYTHON_MEMBER_LINES = new WeakMap<ResolutionContext, Map<string, string[]>>();
function pythonMemberLines(filePath: string, context: ResolutionContext): string[] {
  let files = PYTHON_MEMBER_LINES.get(context);
  if (!files) { files = new Map(); PYTHON_MEMBER_LINES.set(context, files); }
  let lines = files.get(filePath);
  if (!lines) {
    lines = stripCommentsForRegex(context.readFile(filePath) ?? '', 'python').split('\n');
    files.set(filePath, lines);
  }
  return lines;
}

function pythonLocalType(receiver: string, ref: UnresolvedRef, context: ResolutionContext): string | null {
  if (!/^\w+$/.test(receiver)) return null;
  const caller = context.getNodeById?.(ref.fromNodeId);
  const lines = pythonMemberLines(ref.filePath, context);
  const declaration = new RegExp(`^\\s*${receiver}\\s*(?::\\s*["']?([\\w.]+)["']?)?\\s*=\\s*(.*)$`);
  const annotation = new RegExp(`^\\s*${receiver}\\s*:\\s*["']?([\\w.]+)`);
  for (let i = ref.line - 1; i >= (caller?.startLine ?? 1) - 1; i--) {
    const line = lines[i] ?? '';
    const assigned = line.match(declaration);
    if (assigned) return assigned[1] ?? assigned[2]!.match(/^([A-Z][\w.]*)\s*\(/)?.[1] ?? '<unknown>';
    const declared = line.match(annotation)?.[1];
    if (declared) return declared;
  }
  return caller?.signature?.match(new RegExp(`\\b${receiver}\\s*:\\s*["']?([\\w.]+)`))?.[1] ?? null;
}

/** Read a field's own annotation/initializer, or a constructor parameter assigned to it. */
function pythonFieldType(receiver: string, owner: Node, ref: UnresolvedRef, context: ResolutionContext): string | null {
  const lines = pythonMemberLines(ref.filePath, context);
  const field = receiver.split('.')[1]!;
  const assignment = new RegExp(`^\\s*(?:self|cls)\\.${field}\\s*(?::\\s*["']?([\\w.]+)["']?)?\\s*=\\s*(.*)$`);
  const annotation = new RegExp(`^\\s*(?:(?:self|cls)\\.)?${field}\\s*:\\s*["']?([\\w.]+)`);
  const methods = context.getNodesInFile(ref.filePath).filter(n => n.kind === 'method' &&
    n.qualifiedName.startsWith(`${owner.qualifiedName}::`));
  const types = new Set<string>();
  for (let i = owner.startLine; i < owner.endLine; i++) {
    const method = methods.find(n => n.startLine <= i + 1 && n.endLine >= i + 1);
    if (method && method.name !== '__init__' && method.id !== ref.fromNodeId) continue;
    if (method?.id === ref.fromNodeId && i + 1 > ref.line) continue;
    const line = lines[i] ?? '';
    const declared = !method || /^\s*(?:self|cls)\./.test(line) ? line.match(annotation)?.[1] : undefined;
    if (declared) types.add(declared);
    const assigned = line.match(assignment);
    if (!assigned) continue;
    if (assigned[1]) { types.add(assigned[1]); continue; }
    const constructor = assigned[2]!.match(/^([A-Z][\w.]*)\s*\(/)?.[1];
    if (constructor) { types.add(constructor); continue; }
    const param = assigned[2]!.trim();
    if (method && /^\w+$/.test(param)) {
      const signature = method.signature ?? '';
      const type = signature.match(new RegExp(`\\b${param}\\s*:\\s*["']?([\\w.]+)`))?.[1];
      if (type) types.add(type);
    } else {
      types.add('<unknown>');
    }
  }
  // Conflicting assignments are known-but-ambiguous, never a name-only fallback.
  return types.size === 1 ? [...types][0]! : types.size > 1 ? '<ambiguous>' : null;
}

/**
 * Resolve a function-as-value reference (#756) — a function name used as a
 * callback/function-pointer value (`register(handler)`, `o->cb = handler`,
 * `{ .cb = handler }`, `signal(SIGINT, handler)`). The ONLY strategy allowed
 * for `function_ref` refs: exact name, function/method targets only, same
 * language family, same-file first for bare names, and unique-only cross-file.
 * Member values use receiver/type/import scope before a unique-name fallback.
 * A wrong callback edge is worse than none.
 */
export function matchFunctionRef(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // `this.<member>` refs are resolved ONLY by the class-scoped resolver in
  // resolveOne (resolveThisMemberFnRef) — never by name matching here.
  if (ref.referenceName.startsWith('this.')) return null;

  if ((ref.language === 'python' || ref.language === 'go') && ref.referenceName.includes('.')) {
    return matchMemberFunctionRef(ref, context);
  }

  // In JS/TS/Python a bare identifier can never be a method value (methods
  // are only reachable through a receiver — `this.m` / `self.m` /
  // `Cls.m`), so bare fn-refs match FUNCTIONS only. This also sidesteps the
  // pre-existing TS quirk of class fields extracting as method-kind nodes,
  // which otherwise soaked up local names passed as arguments (excalidraw
  // A/B finding; same pattern in vendored docopt.py). Python's `self.m`
  // form keeps method targets via its own capture shape. C++ likewise: a
  // bare identifier can only be a FREE function (member values need
  // `&Cls::method`). PHP string callables name global FUNCTIONS (methods
  // need the `[$obj, 'm']` array form, which carries its own shape). Other
  // languages keep method targets: C# method groups, Swift/Dart
  // implicit-self, Java/Kotlin method references.
  const bareFnOnly =
    ref.language === 'typescript' || ref.language === 'tsx' ||
    ref.language === 'javascript' || ref.language === 'jsx' ||
    ref.language === 'arkts' ||
    ref.language === 'cpp' || ref.language === 'python' ||
    ref.language === 'php';

  // Python additionally accepts CLASS targets for bare identifiers (#1478):
  // class-as-value is a core Python idiom (`return SomeSerializer`,
  // `Meta.model = Org`, registry dicts, `admin.site.register(Model, Admin)`)
  // and, unlike TS, Python has no type-annotation recovery path. The
  // false-positive mechanism behind the function-only rule was lowercase
  // locals colliding with same-named METHODS (docopt.py) — a candidate must
  // be an exact-name CLASS node here, and the extraction gate (same-file
  // class ∪ imports) plus unique-or-drop still apply. Methods stay excluded.
  const bareClassOk = ref.language === 'python';

  // Qualified member-pointer (`&Widget::on_click` → "Widget::on_click"):
  // resolve the member ON THAT SCOPE — exempt from bareFnOnly (the `&Cls::m`
  // shape is an explicit member reference). Unique-or-drop like everything else.
  if (ref.referenceName.includes('::')) {
    const memberName = ref.referenceName.slice(ref.referenceName.lastIndexOf('::') + 2);
    const scoped = context
      .getNodesByName(memberName)
      .filter(
        (n) =>
          (n.kind === 'function' || n.kind === 'method') &&
          sameLanguageFamily(n.language, ref.language) &&
          n.id !== ref.fromNodeId &&
          (n.qualifiedName === ref.referenceName ||
            n.qualifiedName.endsWith(`::${ref.referenceName}`))
      );
    if (scoped.length === 0) return null;
    const sameFileScoped = scoped.filter((n) => n.filePath === ref.filePath);
    const pool = sameFileScoped.length > 0 ? sameFileScoped : scoped;
    if (sameFileScoped.length === 0 && scoped.length > 1) return null;
    const target = pool.reduce((a, b) => (a.startLine <= b.startLine ? a : b));
    return {
      original: ref,
      targetNodeId: target.id,
      confidence: 0.9,
      resolvedBy: 'function-ref',
    };
  }

  let candidates = context
    .getNodesByName(ref.referenceName)
    .filter(
      (n) =>
        (n.kind === 'function' ||
          (!bareFnOnly && n.kind === 'method') ||
          (bareClassOk && n.kind === 'class')) &&
        sameLanguageFamily(n.language, ref.language) &&
        n.id !== ref.fromNodeId // a function registering itself is not a dependency edge
    );
  if (candidates.length === 0) return null;

  // Swift implicit-self: a bare identifier can name a METHOD only of the
  // ENCLOSING type (`Button(action: handleTap)` written inside that type) —
  // a same-named method on any OTHER class is a parameter collision
  // (Alamofire: a `request` parameter resolving to EventMonitor::request).
  // Scope method candidates to the from-symbol's type; top-level code has no
  // implicit self, so method targets are excluded there entirely. Free
  // functions are unaffected.
  if (ref.language === 'swift' && candidates.some((n) => n.kind === 'method')) {
    const fromNode = context.getNodeById?.(ref.fromNodeId);
    const sep = fromNode ? fromNode.qualifiedName.lastIndexOf('::') : -1;
    const classPrefix = fromNode && sep > 0 ? fromNode.qualifiedName.slice(0, sep) : null;
    candidates = candidates.filter((n) => {
      if (n.kind !== 'method') return true;
      if (!classPrefix) return false;
      const mSep = n.qualifiedName.lastIndexOf('::');
      if (mSep <= 0) return false;
      const methodPrefix = n.qualifiedName.slice(0, mSep);
      // Accept exact-scope matches plus suffix relationships either way, so
      // extension-declared members (`Holder::m`) still match a nested
      // from-scope (`Module::Holder::wire`) and vice versa.
      return (
        methodPrefix === classPrefix ||
        methodPrefix.endsWith(`::${classPrefix}`) ||
        classPrefix.endsWith(`::${methodPrefix}`)
      );
    });
    if (candidates.length === 0) return null;
  }

  // Same-file definition wins — the extraction gate guarantees most survivors
  // have one, and it's the dominant C pattern (static callback registered in
  // a same-file ops struct).
  const sameFile = candidates.filter((n) => n.filePath === ref.filePath);
  if (sameFile.length > 0) {
    // Swift: several same-named METHODS in one file is an API overload family
    // (`Session.request(...)` × N), and a bare identifier hitting it is almost
    // always a same-named parameter, not a method value (Alamofire A/B
    // finding) — refuse rather than guess. A single method (SwiftUI's
    // `action: handleTap`) still resolves.
    if (
      ref.language === 'swift' &&
      sameFile.length > 1 &&
      sameFile.every((n) => n.kind === 'method')
    ) {
      return null;
    }
    // Same-name overloads in one file are the same conceptual symbol; pick
    // the first by position for determinism.
    const target = sameFile.reduce((a, b) => (a.startLine <= b.startLine ? a : b));
    return {
      original: ref,
      targetNodeId: target.id,
      confidence: sameFile.length === 1 ? 0.95 : 0.9,
      resolvedBy: 'function-ref',
    };
  }

  // Cross-file (imported names the import resolver didn't already claim):
  // only an unambiguous match resolves.
  if (candidates.length === 1) {
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 0.8,
      resolvedBy: 'function-ref',
    };
  }
  return null;
}

/** Languages with no nested named functions: nesting in the graph is never a scope. */
const NO_NESTED_FUNCTIONS = new Set<string>(['c', 'cpp']);
/** Types a function body can declare for itself. */
const LOCAL_TYPE_KINDS = new Set<string>(['class', 'struct', 'enum', 'interface', 'trait', 'type_alias']);

/**
 * A function nested inside another FUNCTION is only callable from within its
 * container — Python, JS/TS, and every closure language scope it lexically.
 * Resolving a bare name from elsewhere to a nested local fabricates an edge
 * scope already rules out: `join(...)` in one function must never bind to a
 * `join` defined inside a DIFFERENT function (#1230). A candidate whose
 * qualifiedName parent is a same-file function/method is kept only when the
 * ref originates inside that parent's line range. Class members are
 * unaffected (their parent resolves to a class-like node), as are top-level
 * symbols and C++ namespace-prefixed names (the prefix has no node).
 */
function isLexicallyReachable(
  candidate: Node,
  ref: UnresolvedRef,
  context: ResolutionContext
): boolean {
  // A function — or a type (`case class B()` in a test method), or a method
  // of such a type — declared inside a function is only in scope in there.
  if (candidate.kind !== 'function' && candidate.kind !== 'method' && !LOCAL_TYPE_KINDS.has(candidate.kind)) return true;
  // C and C++ have no nested named functions, so a function the graph shows
  // inside another is an extraction artifact, not a scope: tree-sitter-c
  // cannot parse a macro call whose arguments are designated initializers
  // (betaflight's `RESET_CONFIG(pidProfile_t, pidProfile, .pid = {…})`), and
  // its error recovery runs the enclosing function_definition to the end of
  // the file, nesting every function after it. Trusting that nesting rejected
  // 117 real calls into pid.c on that tree; the functions are reachable.
  if (NO_NESTED_FUNCTIONS.has(candidate.language)) return true;
  const scope = lexicalScopeOf(candidate, context);
  return scope === null || (ref.filePath === candidate.filePath && ref.line >= scope.start && ref.line <= scope.end);
}

/** Per context: a candidate's scoping function body, or null when nothing scopes it. */
const LEXICAL_SCOPE_MEMO = new WeakMap<ResolutionContext, Map<string, { start: number; end: number } | null>>();

/**
 * The innermost function or method BODY that scopes a declaration, walking out
 * through its qualified name (`test_x::Request::User::has_perm` → `test_x`).
 * A method directly on a class is reachable through its instances, and an
 * object-literal method a function returns through the object — neither is
 * scoped by the function it sits in.
 */
function lexicalScopeOf(candidate: Node, context: ResolutionContext): { start: number; end: number } | null {
  let memo = LEXICAL_SCOPE_MEMO.get(context);
  if (!memo) {
    memo = new Map();
    LEXICAL_SCOPE_MEMO.set(context, memo);
  }
  const hit = memo.get(candidate.id);
  if (hit !== undefined) return hit;
  let scope: { start: number; end: number } | null = null;
  const own = candidate.qualifiedName ?? '';
  const parentQn = own.includes('::') ? own.slice(0, own.lastIndexOf('::')) : '';
  let qn = own;
  while (qn.includes('::')) {
    qn = qn.slice(0, qn.lastIndexOf('::'));
    const container = context
      .getNodesByQualifiedName(qn)
      .find(
        (p) =>
          p.filePath === candidate.filePath &&
          (p.kind === 'function' || p.kind === 'method') &&
          p.startLine <= candidate.startLine &&
          p.endLine >= candidate.endLine
      );
    if (!container) continue;
    if (candidate.kind === 'method' && qn === parentQn) break;
    scope = { start: container.startLine, end: container.endLine };
    break;
  }
  memo.set(candidate.id, scope);
  return scope;
}

/** Languages whose module boundary is `import`/`export` (or CommonJS). */
const ESM_FAMILY = new Set<string>(['typescript', 'tsx', 'javascript', 'jsx', 'arkts']);

/**
 * A line-initial `import` statement — the marker that a JS/TS file is a MODULE
 * rather than a classic script. Line-anchored and followed by a name, brace,
 * star or quote, so a dynamic `import(` and the word inside a comment or string
 * do not match.
 */
const HAS_IMPORT_STATEMENT = /^[ \t]*import[\s{*'"]/m;

/**
 * Anything the file could offer another file, in every form the extractor's own
 * `isExported` flag misses. `^export` covers the declaration and later forms
 * (`export const`, `export { x }`, `export default x`, `export *`); the
 * CommonJS shapes cover files that never use ESM syntax at all, in both the dot
 * and the bracket form; and `declare global` contributes names to every file
 * whether or not the module exports anything of its own. Kept as a source test
 * rather than a node scan precisely because `isExported` is set only from an
 * `export_statement` ancestor, so `const x = …; export { x }` and
 * `module.exports = { x }` both read as unexported on the node.
 */
const HAS_ESM_EXPORT = /^[ \t]*export[\s{*]|^[ \t]*declare\s+global\b/m;
const HAS_CJS_EXPORT = /\bmodule\.exports\b|\bexports\s*[.[]/;

/**
 * Per-context memo of "this file is a module that exports nothing", asked once
 * per candidate FILE rather than once per reference. Derived from file source,
 * so it drops with the context's file caches — clearNameMatcherMemos deletes it
 * alongside INFER_SCAN_STATES.
 */
const SEALED_MODULES = new WeakMap<ResolutionContext, Map<string, boolean>>();

/**
 * Whether `filePath` is a JS/TS module that exports NOTHING — an import
 * statement present, no export of any form. No reference from another file can
 * reach any binding in such a file, so every one of its symbols is a false
 * candidate for a cross-file name match.
 *
 * This is the general case behind a package name capturing a same-named local:
 * on `vitejs/vite`, 157 cross-file `imports` refs — every `import { defineConfig
 * } from 'vite'` in the playground and the create-vite templates — resolved onto
 * `playground/ssr-html/test-stacktrace.js::vite`, which is `const vite = await
 * createServer(…)` at module scope in a file with zero exports. The existing
 * guards cannot see it: `isLexicallyReachable` returns early for any candidate
 * that is not a `function`, and the bare-import guard correctly declines because
 * `vite` IS a workspace member, so the specifier really is project-local. What
 * is wrong is only which node the name lands on.
 *
 * Deliberately narrow on three axes, because each is a class this would
 * otherwise resolve wrongly in the opposite direction:
 *
 * - **A classic script is exempt.** Requiring an `import` statement means a
 *   non-module `.js` file — concatenated globals, a browser `<script>` — keeps
 *   its cross-file matches, where a top-level binding genuinely is reachable.
 * - **CommonJS is exempt.** `module.exports` and `exports.x` are matched as
 *   exports, so a CJS file is never sealed.
 * - **Other languages are exempt.** Go, Python, Java and the rest have no
 *   equivalent boundary, and several extractors hardcode `isExported`.
 */
function isSealedModule(filePath: string, context: ResolutionContext): boolean {
  let memo = SEALED_MODULES.get(context);
  if (!memo) {
    memo = new Map();
    SEALED_MODULES.set(context, memo);
  }
  const hit = memo.get(filePath);
  if (hit !== undefined) return hit;
  // CommonJS assignments can execute inside template interpolations, which the
  // masker blanks. Keep the conservative raw-source exemption for those forms.
  // Cheapest disqualifiers first: nearly every module exports a node (asked
  // without reading or decoding the file), and masking the source is only
  // needed to rule out the ones that don't. (The masker only blanks text, so
  // no `import` in the source means none in code.)
  const exportsNode = context.fileHasExportedNode
    ? context.fileHasExportedNode(filePath)
    : context.getNodesInFile(filePath).some((n) => n.isExported);
  const source = exportsNode ? null : context.readFile(filePath);
  const sealed =
    !exportsNode && source !== null && source.includes('import') &&
    !HAS_CJS_EXPORT.test(source) &&
    (() => {
      const code = blankStringContents(stripCommentsForRegex(source, 'typescript'));
      return HAS_IMPORT_STATEMENT.test(code) && !HAS_ESM_EXPORT.test(code);
    })();
  memo.set(filePath, sealed);
  return sealed;
}

/**
 * Whether `candidate` can be named by a reference in `ref`'s file at all.
 * Both name-based strategies validate their chosen candidate. Removing an
 * unreachable candidate before ranking can promote an unrelated runner-up;
 * rejecting the chosen target must leave the reference unresolved instead.
 */
function isCrossFileReachable(
  candidate: Node,
  ref: UnresolvedRef,
  context: ResolutionContext
): boolean {
  if ((ref.language as string) !== 'markdown' && (candidate.language as string) === 'markdown') return false;
  if (ref.referenceKind === 'calls' && ESM_FAMILY.has(candidate.language) &&
    (candidate.kind === 'constant' || candidate.kind === 'variable') &&
    /^=\s*require\s*\(\s*(['"])[^'"]+\.json\1\s*\)\s*;?\s*$/.test(candidate.signature ?? '')) return false;
  return (
    candidate.filePath === ref.filePath ||
    !ESM_FAMILY.has(candidate.language) ||
    !isSealedModule(candidate.filePath, context)
  );
}

/**
 * Languages in which `visibility: 'private'` on a definition means no other
 * FILE can name it: a Kotlin `private fun` is file- or class-local, and the
 * same holds for Java, C#, Swift, Scala, Dart and PHP members.
 */
const PRIVATE_IS_FILE_LOCAL = new Set<string>(['kotlin', 'java', 'csharp', 'swift', 'scala', 'dart', 'php']);

/** Per-context memo: node id → "this C/C++ function is declared `static`". */
const C_STATIC_MEMO = new WeakMap<ResolutionContext, Map<string, boolean>>();

/**
 * A C/C++ file that IS a translation unit. A `static` defined here is local
 * to it. A `static` (typically `static inline`) in a header is a different
 * thing: the header is textually included, so the function exists in every
 * unit that includes it and is callable from each — MAVLink's generated
 * `mavlink_msg_*.h` are nothing but such functions, 4,306 real calls on one
 * betaflight tree.
 */
const C_SOURCE_EXT = /\.(c|cc|cpp|cxx|c\+\+|m|mm)$/i;

/**
 * Whether a C/C++ function definition carries the `static` storage class —
 * read from its first source line(s), since the extractor records no storage
 * class and the kernel arm would need the same field. `static` on the line
 * above the name (`static void\nfoo(void)`) is the common alternative layout.
 */
function isStaticCFunction(candidate: Node, context: ResolutionContext): boolean {
  let memo = C_STATIC_MEMO.get(context);
  if (!memo) {
    memo = new Map();
    C_STATIC_MEMO.set(context, memo);
  }
  const hit = memo.get(candidate.id);
  if (hit !== undefined) return hit;
  const lines = context.getFileLines?.(candidate.filePath) ?? context.readFile(candidate.filePath)?.split('\n') ?? [];
  const head = [lines[candidate.startLine - 2] ?? '', lines[candidate.startLine - 1] ?? ''].join('\n');
  const isStatic = /(^|[\s;}])static\s/.test(head);
  memo.set(candidate.id, isStatic);
  return isStatic;
}

/** Per-context memo: node id → "this Rust method implements a trait". */
const RUST_TRAIT_IMPL_MEMO = new WeakMap<ResolutionContext, Map<string, boolean>>();

/**
 * Whether a Rust method sits in an `impl Trait for Type` block. Such a method
 * carries no `pub` — the trait decides its visibility — so the extractor
 * records it as private; it is reachable wherever the trait is. Read from the
 * nearest enclosing `impl` header above the method, memoised per node.
 */
function isRustTraitImplMethod(candidate: Node, context: ResolutionContext): boolean {
  if (candidate.kind !== 'method') return false;
  let memo = RUST_TRAIT_IMPL_MEMO.get(context);
  if (!memo) {
    memo = new Map();
    RUST_TRAIT_IMPL_MEMO.set(context, memo);
  }
  const hit = memo.get(candidate.id);
  if (hit !== undefined) return hit;
  const lines = context.getFileLines?.(candidate.filePath) ?? context.readFile(candidate.filePath)?.split('\n') ?? [];
  let isTrait = false;
  for (let i = candidate.startLine - 2; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (/^\s*(pub(\([^)]*\))?\s+)?(unsafe\s+)?impl\b/.test(line)) {
      isTrait = /\sfor\s/.test(line.replace(/\/\/.*$/, ''));
      break;
    }
    // A top-level item above the method means it was not inside an impl.
    if (/^(pub(\([^)]*\))?\s+)?(fn|struct|enum|mod|trait|const|static|type)\b/.test(line)) break;
  }
  memo.set(candidate.id, isTrait);
  return isTrait;
}

/**
 * The directory a Rust file's private items are visible from: the file's own
 * module subtree. `src/net.rs` and `src/net/mod.rs` own `src/net/`; a crate
 * root (`lib.rs` / `main.rs`) owns its directory. A child module reaches its
 * ancestors' private items (`super::`), a sibling or another crate never does.
 */
function rustModuleDir(filePath: string): string {
  const base = path.posix.basename(filePath);
  const dir = path.posix.dirname(filePath);
  if (base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs') return dir;
  return path.posix.join(dir, base.replace(/\.rs$/, ''));
}

/**
 * Whether `candidate` can be NAMED from a reference in `ref`'s file at all,
 * given what its language says about the definition's visibility. A
 * definition the language makes file-local is not a candidate for a
 * cross-file name match, however well the names agree:
 *
 * - **C / C++**: a `static` function defined in a SOURCE file is local to
 *   that translation unit; one in a header is part of every unit that
 *   includes it and stays visible. On a 2,109-file betaflight tree 145
 *   cross-file calls resolved onto a `static` in another `.c` (#1730) —
 *   `usbd_get_descriptor` onto the `static get_device_descriptor` of
 *   whichever USB class file ranked first.
 * - **Kotlin, Java, C#, Swift, Scala, Dart, PHP**: `private` is class- or
 *   file-local. An Android `editor.apply()` resolved onto an unrelated class's
 *   `private fun apply`.
 * - **Go**: an unexported (lowercase) identifier is package-local, and a
 *   package is a directory. Judged by the name's case: the extractor's
 *   `isExported` is unset for every Go method.
 * - **Rust**: a non-`pub` item is visible to its module and that module's
 *   descendants, never to a sibling module or another crate — `.count()` on
 *   an iterator resolved onto a `fn count` in a different crate. A method in
 *   an `impl Trait for Type` block has the trait's visibility, not `private`.
 * - **JS / TS / ArkTS**: a binding in a module that exports nothing (an
 *   `import` present, no `export` / CommonJS / `declare global`) is sealed —
 *   the vite playground's `const vite = await createServer(…)` took 157
 *   `import { defineConfig } from 'vite'` edges (#1719). Classic scripts,
 *   CommonJS, later `export { … }`, and ambient globals stay visible.
 *
 * Same-file candidates are always visible. Applied by ReferenceResolver to
 * the target the whole name-matching pipeline settled on, so a rejection ends
 * the reference unresolved: declining inside matchByExactName instead let the
 * ref fall through to matchFuzzy, which then committed to a same-language
 * namesake the ranking had passed over — eight such edges on one tree, all
 * onto a local `const fail = …` arrow the graph does not hold. matchFuzzy
 * checks its own survivor as well, since nothing runs after it.
 */
export function isVisibleAcrossFiles(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (candidate.filePath === ref.filePath) return true;
  const lang = candidate.language as string;
  if (lang === 'c' || lang === 'cpp') {
    return (
      candidate.kind !== 'function' ||
      !C_SOURCE_EXT.test(candidate.filePath) ||
      !isStaticCFunction(candidate, context)
    );
  }
  if (lang === 'go') {
    // By the name's first letter, not the extractor's flag: the flag is unset
    // for every Go method, exported or not.
    return /^[A-Z]/.test(candidate.name) || path.posix.dirname(candidate.filePath) === path.posix.dirname(ref.filePath);
  }
  if (lang === 'rust') {
    if (candidate.visibility !== 'private') return true;
    if (isRustTraitImplMethod(candidate, context)) return true;
    const owner = rustModuleDir(candidate.filePath);
    return ref.filePath.startsWith(owner + '/');
  }
  if (PRIVATE_IS_FILE_LOCAL.has(lang)) return candidate.visibility !== 'private';
  // JS/TS/ArkTS sealed modules + markdown/JSON call-target guards (#1719).
  // Same predicate matchByExactName / matchFuzzy apply to their survivors so a
  // rejection here cannot fall through to a promoted runner-up.
  return isCrossFileReachable(candidate, ref, context);
}

const JS_FAMILY = new Set<string>(['typescript', 'tsx', 'javascript', 'jsx']);

/**
 * Whether a JS/TS `calls` ref is a RECEIVER-LESS call — `serialize(x)`, not
 * `this.serialize(x)` / `obj.serialize(x)`. The extractor emits `this.m()`
 * and `super.m()` under the bare method name, so the receiver is read back
 * from the call site's own line: the text at the ref's column is the call
 * expression, and it starts with the name itself only when nothing precedes
 * it. In JS/TS a bare call can never bind to a class method (methods need a
 * receiver), so a `method` node is not a candidate for it (#1714) — the
 * enclosing method itself least of all, which the same-file proximity term
 * used to pick over the module-scope function the call actually means.
 */
function isBareJsCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  return JS_FAMILY.has(ref.language) && isReceiverLessCall(ref, context);
}

/**
 * Whether a Go `calls` ref is receiver-less — `relogin(ctx)`, not
 * `l.relogin(ctx)`. A Go method is only reachable through a value or a method
 * expression, so a bare call (a func parameter, a local func value, a
 * package-level function) is never a method, in its own package or in one the
 * file does not import (#1857). Read from the source line like the JS/TS
 * check, because `pkg.Factory().Method()` reaches the resolver as a bare
 * `Method` ref too.
 */
function isBareGoCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  return ref.language === 'go' && isReceiverLessCall(ref, context);
}

/**
 * Whether a PHP `calls` ref is a bare function call — `redirect($url)`,
 * `view('books.show')` — rather than `$this->redirect()` / `$obj->view()` /
 * `Foo::view()`. PHP has no implicit `$this`: a call written without a
 * receiver can only be a function, so a method, field or property that shares
 * the name is never what it calls. Name-matching used to bind BookStack's
 * every `return redirect(…)` to ApiDocsController::redirect and every
 * `return view(…)` to a `$view` field.
 *
 * PHP refs record the column of the call EXPRESSION — `$this->setPageTitle(`
 * sits at `$this` — so a bare call is the one whose text at its column is the
 * name itself (a leading `\` for a fully qualified function is allowed).
 */
function isBarePhpCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.language !== 'php' || ref.referenceKind !== 'calls') return false;
  if (!/^\w+$/.test(ref.referenceName)) return false;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1]
    ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return false;
  const at = line[ref.column] === '\\' ? ref.column + 1 : ref.column;
  if (!line.startsWith(ref.referenceName, at)) return false;
  CALL_OPENER.lastIndex = at + ref.referenceName.length;
  if (!CALL_OPENER.test(line)) return false;
  let end = at;
  while (end > 0 && WHITESPACE.test(line[end - 1]!)) end--;
  // `$obj->name(` / `Foo::name(` / `$obj?->name(`, should a column ever land on the name.
  return !(end > 0 && (line[end - 1] === '>' || line[end - 1] === ':'));
}

function isReceiverLessCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.referenceKind !== 'calls') return false;
  if (ref.referenceName.includes('.')) return false;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1]
    ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return false;
  // `^<name>\s*[(<]` at the call's column, without compiling a pattern per call.
  if (!line.startsWith(ref.referenceName, ref.column)) return false;
  CALL_OPENER.lastIndex = ref.column + ref.referenceName.length;
  if (!CALL_OPENER.test(line)) return false;
  // Nothing but whitespace, an operator or an opener may precede a bare call:
  // read the text before the column backwards, past trailing whitespace,
  // instead of end-anchoring a pattern that scans the prefix from its start.
  let end = Math.min(ref.column, line.length);
  while (end > 0 && WHITESPACE.test(line[end - 1]!)) end--;
  if (end === 0 || !RECEIVER_TAIL_CHAR.test(line[end - 1]!)) return true;
  let start = end;
  while (start > 0 && WORD_CHAR.test(line[start - 1]!)) start--;
  return BARE_CALL_KEYWORDS.has(line.slice(start, end));
}

/** `\s*[(<]` from a given index (sticky). */
const CALL_OPENER = /\s*[(<]/y;
const WHITESPACE = /\s/;
const WORD_CHAR = /\w/;
/** A character that ends a receiver: `.`, a word character, `$`, `]` or `)`. */
const RECEIVER_TAIL_CHAR = /[.\w$\])]/;
/** Keywords after which a name starts an expression, so the call has no receiver. */
const BARE_CALL_KEYWORDS: ReadonlySet<string> = new Set([
  'return', 'await', 'yield', 'typeof', 'void', 'new', 'else', 'case', 'throw', 'in', 'of', 'instanceof', 'go', 'defer',
]);

/**
 * A C# / VB.NET reference whose site is a TYPE position: `Type sourceType`,
 * `List<int>`, `new TypeMap()`, `Exception? e`, `Dictionary<string, Type>`,
 * VB's `As Type` / `New List(Of T)`. Read from the source at the reference's
 * column; anything else — a member read (`Builder.Services`), a method group
 * (`MapGet("/x", GetItems)`), a route's handler — keeps every candidate.
 */
function isDotNetTypeRef(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.language !== 'csharp' && ref.language !== 'vbnet') return false;
  if (ref.referenceKind !== 'references' && ref.referenceKind !== 'instantiates' &&
    ref.referenceKind !== 'type_of' && ref.referenceKind !== 'returns') return false;
  const name = ref.referenceName;
  if (!/^[A-Za-z_]\w*$/.test(name)) return false;
  // `new TypeMap()` constructs a type; the reference's column is the `new`.
  if (ref.referenceKind === 'instantiates') return true;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1]
    ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined || !line.startsWith(name, ref.column)) return false;
  const before = line.slice(0, ref.column);
  const after = line.slice(ref.column + name.length);
  if (ref.language === 'vbnet') return /\b(?:As|New|Of)\s+$/i.test(before);
  if (/\bnew\s+$/.test(before)) return true;
  // `Type name` — a declaration names its type first.
  if (/^\s+@?[A-Za-z_]/.test(after)) return !/^\s+(?:is|as|and|or|not|when|in|switch|with)\b/.test(after);
  // `List<int>`, `Type?`, `Type[]`, and the arguments of a generic.
  if (/^<|^\?(?![.?\[])|^\[\s*[,\]]/.test(after)) return true;
  return /^\s*[,>]/.test(after) && /<[^<>()]*$/.test(before);
}

/**
 * Whether a candidate can be what a .NET type position names. A property, a
 * method (a constructor is one) or an enum case shares the type's name, not
 * its meaning: AutoMapper's `Type sourceType` bound to an attribute's `Type`
 * property and `TypeMap typeMap` to a `TypeMap` property beside the `TypeMap`
 * class. A field never names a type either.
 */
function canNameInTypePosition(n: Node): boolean {
  return !(n.kind === 'property' || n.kind === 'method' || n.kind === 'enum_member' || n.kind === 'field');
}

/**
 * The shape of a Python call that reaches the resolver as a bare name — the
 * column is the call's start. `bare`: `get(1)`, which cannot mean a method
 * (Python has no implicit self). `chained`: a receiver the extractor could not
 * keep — `User.objects.get(…)`, `self.client.login(…)`, `request.POST.get(…)`
 * arrive as `get` / `login`, and can only mean a member of what the chain
 * names last (`POST`, `client`, `objects`). netbox bound 3,610 `.all()` calls
 * to one `UserConfig.all`, healthchecks 880 `objects.get` to a test case's
 * `get`. `self.x()` / `cls.x()`, and a chain split across lines, are null:
 * today's behavior.
 */
type PythonCallShape = { kind: 'bare' } | { kind: 'chained'; owner: string };

function pythonCallShape(ref: UnresolvedRef, context: ResolutionContext): PythonCallShape | null {
  if (ref.language !== 'python' || ref.referenceKind !== 'calls') return null;
  const name = ref.referenceName;
  if (!/^[A-Za-z_]\w*$/.test(name)) return null;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return null;
  const text = line.slice(ref.column);
  if (text.startsWith(name) && /^\s*\(/.test(text.slice(name.length))) return { kind: 'bare' };
  if (new RegExp(String.raw`^(?:self|cls)\s*\.\s*${name}\s*\(`).test(text)) return null;
  // The call starts at its receiver, so everything up to `.name(` is the receiver chain.
  const chain = new RegExp(String.raw`^(.*?)\.\s*${name}\s*\(`).exec(text);
  if (!chain) return null;
  const owner = /(\w+)\s*(?:\([^()]*\)|\[[^\[\]]*\])?\s*$/.exec(chain[1]!)?.[1];
  return owner ? { kind: 'chained', owner } : null;
}

/** Can a Python call of this shape mean the candidate? */
function fitsPythonCallShape(n: Node, shape: PythonCallShape, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (shape.kind === 'bare') {
    if (n.kind === 'method') return false;
    // `from django.shortcuts import render`: the call is the package's.
    return !(n.filePath !== ref.filePath && isPythonNameImportedFromOutside(ref.referenceName, ref, context));
  }
  // A member of what the chain names: a method of a class of that name, or a
  // function / class in a module of that name (`helpers.slugify()`).
  if (n.kind === 'method') {
    // `self.store.fetch()` on a `Store`, `self.user_service.find()` on a `UserService`.
    const cut = n.qualifiedName.lastIndexOf('::');
    const owner = cut >= 0 ? n.qualifiedName.slice(0, cut).split('::').pop()! : '';
    const plain = (s: string): string => s.replace(/_/g, '').toLowerCase();
    return owner !== '' && plain(owner) === plain(shape.owner);
  }
  const parts = n.filePath.split('/');
  const stem = parts[parts.length - 1]!.replace(/\.pyi?$/, '');
  return stem === shape.owner || (stem === '__init__' && parts[parts.length - 2] === shape.owner);
}

const PY_IMPORTS = new WeakMap<ResolutionContext, Map<string, Map<string, string>>>();
const PY_MODULE_LOCAL = new WeakMap<ResolutionContext, Map<string, boolean>>();

/** `name` → the module a `from <module> import name` line takes it from, per file. */
function pythonFromImports(filePath: string, context: ResolutionContext): Map<string, string> {
  let memo = PY_IMPORTS.get(context);
  if (!memo) {
    memo = new Map();
    PY_IMPORTS.set(context, memo);
  }
  const hit = memo.get(filePath);
  if (hit) return hit;
  const names = new Map<string, string>();
  const text = context.readFile(filePath) ?? '';
  for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+(\([^)]*\)|[^\n#]+)/gm)) {
    const module = m[1]!;
    for (const item of m[2]!.replace(/[()]/g, '').split(',')) {
      const bound = /(\w+)\s*$/.exec(item.trim())?.[1];
      if (bound && bound !== '*') names.set(bound, module);
    }
  }
  memo.set(filePath, names);
  return names;
}

function isPythonNameImportedFromOutside(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const module = pythonFromImports(ref.filePath, context).get(name);
  if (!module || module.startsWith('.')) return false;
  let memo = PY_MODULE_LOCAL.get(context);
  if (!memo) {
    memo = new Map();
    PY_MODULE_LOCAL.set(context, memo);
  }
  let local = memo.get(module);
  if (local === undefined) {
    const rel = module.replace(/\./g, '/');
    local = context.getAllFiles().some((f) =>
      f === `${rel}.py` || f.endsWith(`/${rel}.py`) || f === `${rel}/__init__.py` || f.endsWith(`/${rel}/__init__.py`));
    memo.set(module, local);
  }
  return !local;
}

/** Names the Rust prelude puts in every module; a project item of the same name needs a `use` to shadow one. */
const RUST_PRELUDE = new Set([
  'Ok', 'Err', 'Some', 'None', 'Result', 'Option', 'Box', 'Vec', 'String', 'Default', 'Drop', 'Iterator',
  'IntoIterator', 'From', 'Into', 'Clone', 'Copy', 'Send', 'Sync', 'Sized', 'ToString', 'ToOwned', 'PartialEq',
  'Eq', 'PartialOrd', 'Ord', 'AsRef', 'AsMut', 'Fn', 'FnMut', 'FnOnce', 'Extend', 'drop',
]);

interface RustUses {
  /** Every identifier in the file's project `use` trees — not `std::` / `core::` / `alloc::` ones. */
  names: Set<string>;
  /** `X` of each `use …::X::*` (`super` for `use super::*`). */
  globs: Set<string>;
}
const RUST_USES = new WeakMap<ResolutionContext, Map<string, RustUses>>();

function rustUsesOf(filePath: string, context: ResolutionContext): RustUses {
  let memo = RUST_USES.get(context);
  if (!memo) {
    memo = new Map();
    RUST_USES.set(context, memo);
  }
  const hit = memo.get(filePath);
  if (hit) return hit;
  const uses: RustUses = { names: new Set(), globs: new Set() };
  // Comments first: a doc comment's prose ("…use the Option…") is not a `use`.
  const text = stripCommentsForRegex(context.readFile(filePath) ?? '', 'rust');
  for (const m of text.matchAll(/(?:^|[;{}\s])use\s+([^;]{1,2000});/g)) {
    const tree = m[1]!;
    if (/^\s*(?:::)?(?:std|core|alloc)\b/.test(tree)) continue;
    for (const id of tree.matchAll(/[A-Za-z_]\w*/g)) uses.names.add(id[0]);
    for (const g of tree.matchAll(/(\w+)\s*::\s*(?:\{[^}]*)?\*/g)) uses.globs.add(g[1]!);
  }
  memo.set(filePath, uses);
  return uses;
}

/** The module a Rust file is: `src/glob.rs` → `glob`, `src/walk/mod.rs` → `walk`. */
function rustModuleName(filePath: string): string {
  const parts = filePath.split('/');
  const base = parts[parts.length - 1]!.replace(/\.rs$/, '');
  return base === 'mod' || base === 'lib' || base === 'main' ? parts[parts.length - 2] ?? base : base;
}

/** Does one of the file's globs bring in this candidate's module (or, for `use super::*`, its parent's)? */
function rustGlobCovers(uses: RustUses, candidate: Node, ref: UnresolvedRef): boolean {
  if (uses.globs.has(rustModuleName(candidate.filePath))) return true;
  if (!uses.globs.has('super')) return false;
  const dir = (p: string): string => p.slice(0, p.lastIndexOf('/'));
  // `use super::*` in a child module: the parent's file, or a sibling in the parent's directory.
  return dir(candidate.filePath) === dir(ref.filePath) || dir(candidate.filePath) === dir(dir(ref.filePath));
}

/**
 * Whether a bare Rust name can mean this candidate. An enum's variant is in
 * scope bare only through a `use` of it or of its enum's `*`, and never
 * names a TYPE — ripgrep's every `Some(x)` bound to its `EncodingMode::Some`
 * variant, every `Ok(x)` to `ParseResult::Ok`. A prelude name (`Ok`,
 * `Result`, `Box`) is the prelude's unless the file defines it or imports a
 * project item of that name — serde's macro-hygiene tests declare `struct
 * Ok`, `struct Result`, and serde bound its own `Ok(…)` and `Result<…>` to them.
 */
export function isRustNameInScope(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const name = ref.referenceName;
  // Bare in the SOURCE: the index keeps `crate::error::Result` by its last
  // segment, and a path is not a prelude lookup.
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line !== undefined && line.startsWith(name, ref.column) && /::\s*$/.test(line.slice(0, ref.column))) return true;
  if (candidate.kind === 'enum_member') {
    if (ref.referenceKind === 'references') return false;
    const uses = rustUsesOf(ref.filePath, context);
    const cut = candidate.qualifiedName.lastIndexOf('::');
    const owner = cut >= 0 ? candidate.qualifiedName.slice(0, cut).split('::').pop()! : '';
    return (owner !== '' && uses.globs.has(owner)) || (uses.names.has(name) && uses.names.has(owner));
  }
  if (!RUST_PRELUDE.has(name) || candidate.filePath === ref.filePath) return true;
  const uses = rustUsesOf(ref.filePath, context);
  return uses.names.has(name) || rustGlobCovers(uses, candidate, ref);
}

/** What only exists inside a type, reachable through a receiver alone. */
const TYPE_MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'property', 'field', 'enum_member']);

/** Per-context memo: `file\0name` → "the file binds this name locally". */
const LOCAL_BINDING_MEMO = new WeakMap<ResolutionContext, Map<string, boolean>>();

/**
 * Where a file's local bindings can start, for isLocallyBoundJsName: every
 * `const`/`let`/`var` and `function`/`class` keyword and every `=>`. Each
 * binding pattern can only match from one of these (or, for a parameter,
 * from the `(` before an occurrence of the name), so a lookup tries its
 * patterns at those offsets instead of searching the file once per pattern
 * per name. Kept for the last few files — calls arrive file by file.
 */
interface LocalBindingSites {
  varDecls: number[];
  fnDecls: number[];
  arrows: number[];
}
const LOCAL_BINDING_SITES = new WeakMap<ResolutionContext, Map<string, LocalBindingSites>>();
const LOCAL_BINDING_SITES_KEEP = 16;
const VAR_DECL_SITE = /\b(?:const|let|var)\s/g;
const FN_DECL_SITE = /\b(?:function|class)\s/g;

function localBindingSites(filePath: string, source: string, context: ResolutionContext): LocalBindingSites {
  let cache = LOCAL_BINDING_SITES.get(context);
  if (!cache) {
    cache = new Map();
    LOCAL_BINDING_SITES.set(context, cache);
  }
  let sites = cache.get(filePath);
  if (!sites) {
    const offsets = (re: RegExp): number[] => Array.from(source.matchAll(re), (m) => m.index!);
    const arrows: number[] = [];
    for (let a = source.indexOf('=>'); a !== -1; a = source.indexOf('=>', a + 2)) arrows.push(a);
    sites = { varDecls: offsets(VAR_DECL_SITE), fnDecls: offsets(FN_DECL_SITE), arrows };
    if (cache.size >= LOCAL_BINDING_SITES_KEEP) cache.delete(cache.keys().next().value!);
    cache.set(filePath, sites);
  }
  return sites;
}

type LocalBindingPatterns = { decl: RegExp; fn: RegExp; param: RegExp };
/** Sticky binding patterns by name — the same names recur file after file. */
const LOCAL_BINDING_PATTERNS = new Map<string, LocalBindingPatterns>();
const LOCAL_BINDING_PATTERNS_CAP = 4096;
const JS_BINDING_NAME = /^[\w$]+$/;
const ARROW_HEAD_CHAR = /[\w$.]/;
const IMPORT_BINDING_VALUE = /^\s*(?:await\s+)?(?:require|import)\s*\(/;

function localBindingPatterns(name: string, flags: string): LocalBindingPatterns {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    // `const { name } = require('./m')` / `= await import('./m')` binds an IMPORT,
    // not a shadow: the symbol lives in the other file and the call means it.
    decl: new RegExp(
      '\\b(?:const|let|var)\\s+(?:' + n + '\\b|[{\\[][^;=]*?\\b' + n + '\\b[^;=]*?[}\\]])\\s*(?:=\\s*([^;\\n]*))?',
      flags
    ),
    fn: new RegExp('\\b(?:function|class)\\s+' + n + '\\b', flags),
    // a parameter: every token before the name in the list is itself a
    // parameter (identifier, optional type, optional default) — so a string
    // argument containing the word cannot match.
    // Each earlier parameter has exactly one parse: its first non-space
    // character after the identifier picks the type (`?`/`:`), default (`=`)
    // or bare alternative. Written as `(type)?(default)?\s*`, the same
    // strings split several ways per parameter, and a failing search
    // backtracked through every combination — 30-40s per name on a vscode
    // test file whose helper takes nine `name: T = value` parameters.
    param: new RegExp(
      '\\(\\s*(?:(?:\\.\\.\\.)?[\\w$]+(?:\\s*(?:\\?\\s*)?:[^,()]+|\\s*=[^,()]+|\\s*),\\s*)*' +
        n + '\\b(?:\\s*\\??\\s*:[^,()]*)?(?:\\s*=[^,()]*)?(?:\\s*,\\s*[^()]*)?\\)\\s*(?::[^=;{]*)?(?:=>|\\{)',
      flags
    ),
  };
}

/**
 * Whether a JS/TS file binds `name` itself — as a `const`/`let`/`var`/
 * `function`/`class` declaration (destructuring included) or as a parameter
 * of a function or arrow. Such a binding shadows every same-named symbol in
 * other files, so a bare call to it has no cross-file candidate: the
 * `resolve` of `new Promise((resolve, reject) => …)`, a spec's
 * `const transform = await makeTransform()`, a factory's `const now =
 * options.now || (() => new Date())`. None of these is a node the graph
 * holds (a parameter, a const bound to a call result), so without this the
 * matcher hands the call to whichever other file defines the name — and
 * once methods stop being candidates for a bare call (#1714), the function
 * that was out-ranked steps in. Read from source, memoised per file+name.
 */
function isLocallyBoundJsName(name: string, filePath: string, context: ResolutionContext): boolean {
  let memo = LOCAL_BINDING_MEMO.get(context);
  if (!memo) {
    memo = new Map();
    LOCAL_BINDING_MEMO.set(context, memo);
  }
  const key = filePath + '\0' + name;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const source = context.readFile(filePath) ?? '';
  const bound = JS_BINDING_NAME.test(name)
    ? bindsAtSites(source, name, localBindingSites(filePath, source, context))
    : bindsAnywhere(source, name);
  memo.set(key, bound);
  return bound;
}

/** isLocallyBoundJsName's patterns, searched through the whole source. */
function bindsAnywhere(source: string, name: string): boolean {
  const { decl, fn, param } = localBindingPatterns(name, 'g');
  for (const m of source.matchAll(decl)) {
    if (!IMPORT_BINDING_VALUE.test(m[1] ?? '')) return true;
  }
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return fn.test(source) || param.test(source) || new RegExp('(?:^|[^\\w$.])' + n + '\\s*=>').test(source);
}

/**
 * bindsAnywhere for a plain identifier, tried only where a match can start:
 * a declaration at its keyword (in order, resuming past each match exactly as
 * the global search does), a parameter at the `(` its list opens with — the
 * last `(` before an occurrence of the name, with no `)` between, since no
 * earlier parameter can hold a parenthesis — and `name =>` at each arrow.
 */
function bindsAtSites(source: string, name: string, sites: LocalBindingSites): boolean {
  let patterns = LOCAL_BINDING_PATTERNS.get(name);
  if (!patterns) {
    patterns = localBindingPatterns(name, 'y');
    if (LOCAL_BINDING_PATTERNS.size >= LOCAL_BINDING_PATTERNS_CAP) {
      LOCAL_BINDING_PATTERNS.delete(LOCAL_BINDING_PATTERNS.keys().next().value!);
    }
    LOCAL_BINDING_PATTERNS.set(name, patterns);
  }
  const { decl, fn, param } = patterns;
  let from = 0;
  for (const at of sites.varDecls) {
    if (at < from) continue;
    decl.lastIndex = at;
    const m = decl.exec(source);
    if (!m) continue;
    from = at + m[0].length;
    if (!IMPORT_BINDING_VALUE.test(m[1] ?? '')) return true;
  }
  for (const at of sites.fnDecls) {
    fn.lastIndex = at;
    if (fn.test(source)) return true;
  }
  let tried = -1;
  for (let at = source.indexOf(name); at !== -1; at = source.indexOf(name, at + 1)) {
    const open = at > 0 ? source.lastIndexOf('(', at - 1) : -1;
    if (open < 0 || open === tried || source.lastIndexOf(')', at - 1) > open) continue;
    tried = open;
    param.lastIndex = open;
    if (param.test(source)) return true;
  }
  // `name =>`: the name ends where the whitespace before the arrow starts.
  for (const arrow of sites.arrows) {
    let end = arrow;
    while (end > 0 && WHITESPACE.test(source[end - 1]!)) end--;
    const start = end - name.length;
    if (start >= 0 && source.startsWith(name, start) && (start === 0 || !ARROW_HEAD_CHAR.test(source[start - 1]!))) {
      return true;
    }
  }
  return false;
}

/**
 * Try to resolve a reference by exact name match
 */
export function matchByExactName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // `import`-kind nodes are import STATEMENTS, not definitions, so a reference
  // resolving to a sibling file's `import` is a meaningless edge — the real
  // import→definition resolution is the import resolver's job (resolveViaImport),
  // never name-matching here. Excluding them also removes a quadratic blow-up:
  // a ubiquitous package (`react`, `@superset-ui/core`, Python `logging`/`typing`)
  // is re-declared as an `import` node in every file that imports it, so K
  // unresolved import refs each scored K same-named import candidates through
  // findBestMatch — O(K²) per package, the dominant cost of "Resolving refs" on
  // large import-heavy (front-end + back-end) repos (#915).
  const bareJs = isBareJsCall(ref, context);
  const bareGo = isBareGoCall(ref, context);
  const barePhp = isBarePhpCall(ref, context);
  if (bareJs) {
    const storeAction = matchJsStoreBindingCall(ref, context);
    if (storeAction) return storeAction;
    // `import { useQuery } from '@tanstack/react-query'`: the call means the
    // package's, and no same-named project symbol.
    if (isOutOfRepoBinding(ref.referenceName, ref, context)) return null;
  }
  // Every rule below judges one candidate on its own, so they run as ONE pass,
  // the kind/language checks before the ones that read source: a common name
  // has thousands of same-named nodes, and a chain of filters copied that
  // list once per rule for every reference.
  const valueRef = ref.referenceKind === 'references' || ref.referenceKind === 'function_ref';
  const importRef = ref.referenceKind === 'imports';
  const inheritanceRef = isInheritanceRef(ref);
  const sameName = context.getNodesByName(ref.referenceName);
  // `NAME(...)` where NAME is a function-like macro somewhere in the project is
  // an expansion or a call to a same-named function — never the macro itself
  // (#1839), and never a type that happens to share the name (#2070: expat's
  // `PREFIX(scanRef)(…)` bound to an unrelated `struct PREFIX`). Keep
  // upstream's language gate on the chosen result.
  const cMacroCall = ref.referenceKind === 'calls' && (ref.language === 'c' || ref.language === 'cpp') &&
    sameName.some((n) => n.kind === 'constant' && CPP_DEFINE_SIGNATURE.test(n.signature ?? ''));
  const typeRef = isDotNetTypeRef(ref, context);
  const rustBare = ref.language === 'rust' && /^[A-Za-z_]\w*$/.test(ref.referenceName);
  const pythonShape = pythonCallShape(ref, context);
  const candidates = sameName.filter((n) =>
    !(pythonShape && !fitsPythonCallShape(n, pythonShape, ref, context)) &&
    !(rustBare && !isRustNameInScope(n, ref, context)) &&
    !(cMacroCall && n.kind !== 'function' && n.kind !== 'method') &&
    !(typeRef && !canNameInTypePosition(n)) &&
    // A Scala type position (`Arbitrary[B]`) never names a method: an
    // `implicit def A: Order[A]` shares its name with half of cats' type
    // parameters. Scala's value references only read a file's own vals.
    !(ref.language === 'scala' && ref.referenceKind === 'references' && /^[A-Z]/.test(ref.referenceName) &&
      (n.kind === 'method' || n.kind === 'function')) &&
    // Type/value references retain same-family eligibility: a native namesake
    // must not hide the actual web type. Calls still gate only the winner.
    (!valueRef || sameLanguageFamily(n.language, ref.language)) &&
    n.kind !== 'import' &&
    // A receiver-less JS/TS or Go call cannot reach a member of a type — a
    // method (#1714, #1857), nor a property, field or case: mocha's global
    // `it(…)` bound to an interface's `it` property, `describe(…)` to a
    // command class's `describe` string.
    !((bareJs || bareGo) && TYPE_MEMBER_KINDS.has(n.kind)) &&
    // A bare PHP call is a function call: nothing else is callable without a receiver.
    !(barePhp && n.kind !== 'function') &&
    // An `extends`/`implements` ref names a supertype, so anything that can't
    // BE one is not a candidate at all. This is eligibility, not
    // ranking: kind is only a scoring bonus below (and none is awarded for
    // inheritance refs), so without this a same-named `enum_member` outranked
    // the real `trait`, and as the sole candidate was adopted outright by the
    // single-match shortcut. Restricting the pool BEFORE ranking lets the
    // legitimate supertype win instead of merely dropping the false edge.
    (!inheritanceRef || isSupertypeTarget(n)) &&
    // Likewise for `imports`: a member that only exists inside a type is not
    // importable, so it is not a candidate. Without this a `path`/`id`/`url`
    // import resolved to some interface's same-named property.
    (!importRef || isImportableKind(n.kind)) &&
    // Nested locals are only reachable from inside their container (#1230).
    isLexicallyReachable(n, ref, context) &&
    // Preserve import ranking; calls reject the winner without promoting another.
    (!importRef || n.filePath === ref.filePath ||
      !ESM_FAMILY.has(n.language) || !isSealedModule(n.filePath, context)) &&
    // A name the file binds itself (a parameter, a const) shadows every other
    // file's symbol of that name, so a bare call has no cross-file candidate.
    !(bareJs && n.filePath !== ref.filePath && isLocallyBoundJsName(ref.referenceName, ref.filePath, context))
  );

  if (candidates.length === 0) {
    return null;
  }

  // If only one match, use it — but penalize cross-language matches
  if (candidates.length === 1) {
    if (!isCrossFileReachable(candidates[0]!, ref, context)) return null;
    const isCrossLanguage = candidates[0]!.language !== ref.language;
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: isCrossLanguage ? 0.5 : 0.9,
      resolvedBy: 'exact-match',
    };
  }

  // Ubiquitous-name ceiling (#999): above it, picking one target among K
  // same-named defs by directory proximity is unreliable AND O(K) per ref — the
  // quadratic behind the "Resolving refs" wedge on theme/SDK-vendoring repos.
  // Decline; the precise strategies (qualified-name, import, class-name) already
  // ran. Falls through to fuzzy, which itself only resolves a UNIQUE candidate.
  if (candidates.length > AMBIGUOUS_NAME_CEILING) {
    return null;
  }

  // Multiple matches - try to narrow down
  const bestMatch = findBestMatch(ref, candidates, context);
  if (bestMatch && isCrossFileReachable(bestMatch, ref, context)) {
    // Lower confidence when the match is from a distant/unrelated module
    const proximity = computePathProximity(ref.filePath, bestMatch.filePath);
    const confidence = proximity >= 30 ? 0.7 : 0.4;
    return {
      original: ref,
      targetNodeId: bestMatch.id,
      confidence,
      resolvedBy: 'exact-match',
    };
  }

  return null;
}

/**
 * Try to resolve by qualified name
 */
export function matchByQualifiedName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Check if the reference name looks qualified (contains :: or .)
  if (!ref.referenceName.includes('::') && !ref.referenceName.includes('.')) {
    return null;
  }

  // A method call `receiver.method()` can share an exact qualified name with a
  // config-file key: `service.process()` (a `calls` ref named `service.process`)
  // vs the yaml key `service.process`. Config keys are bound to their code refs
  // upstream by the framework resolvers (`@Value` → `references`); a `calls` ref
  // must never resolve to a yaml/properties config node — that's a wrong edge
  // AND it hides the real callee. Drop those from both the exact and the partial
  // candidate sets so resolution falls through to method resolution below (#1180).
  const keepForRef = (nodes: Node[]): Node[] =>
    ref.referenceKind === 'calls'
      ? nodes.filter(
          (n) => !(n.kind === 'constant' && (n.language === 'yaml' || n.language === 'properties')),
        )
      : nodes;

  const candidates = keepForRef(context.getNodesByQualifiedName(ref.referenceName));

  if (candidates.length === 1) {
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 0.95,
      resolvedBy: 'qualified-name',
    };
  }

  // Several symbols share this exact qualified name (e.g. `Logger::log` declared
  // in two files — an ODR clash or separate translation units): prefer the one
  // in the call site's own file before the partial-match fallback below, else
  // the first-indexed def wins and a call in `b/svc` targets `a/svc` (#1079).
  if (candidates.length > 1) {
    const ordered = preferCallSiteFile(candidates, ref.filePath);
    if (ordered[0]!.filePath === ref.filePath) {
      return {
        original: ref,
        targetNodeId: ordered[0]!.id,
        confidence: 0.95,
        resolvedBy: 'qualified-name',
      };
    }
  }

  // Erlang qualified refs (#1610): every erlang function's qualifiedName
  // carries its arity (`mod::f/2`), and refs carry the call-site arity when it
  // is statically known.
  if (ref.language === 'erlang' && ref.referenceName.includes('::')) {
    // A ref WITH arity that missed the exact lookup names an arity that isn't
    // defined (or a module out of repo). Never fall through to the partial
    // match — its "last segment" would be the arity digits — and never settle
    // for a sibling arity: silent beats wrong.
    if (/\/\d{1,3}$/.test(ref.referenceName)) return null;
    // An arity-LESS qualified ref (dynamic MFA whose args list wasn't a
    // static literal): resolve only when the module defines exactly ONE arity
    // of that function; several arities with no signal is a guess.
    const base = ref.referenceName.slice(ref.referenceName.lastIndexOf('::') + 2);
    const prefix = `${ref.referenceName}/`;
    const arityCands = keepForRef(context.getNodesByName(base)).filter(
      (n) =>
        n.qualifiedName.startsWith(prefix) && /^\d{1,3}$/.test(n.qualifiedName.slice(prefix.length)),
    );
    if (arityCands.length === 1) {
      return {
        original: ref,
        targetNodeId: arityCands[0]!.id,
        confidence: 0.85,
        resolvedBy: 'qualified-name',
      };
    }
    return null;
  }

  // Try partial qualified name match — again preferring the call site's own
  // file when more than one symbol's qualifiedName ends with the reference.
  const parts = ref.referenceName.split(/[:.]/);
  const lastName = parts[parts.length - 1];
  if (lastName) {
    const partialCandidates = keepForRef(context.getNodesByName(lastName))
      .filter((candidate) => candidate.qualifiedName.endsWith(ref.referenceName));
    const chosen = preferCallSiteFile(partialCandidates, ref.filePath)[0];
    if (chosen) {
      return {
        original: ref,
        targetNodeId: chosen.id,
        confidence: 0.85,
        resolvedBy: 'qualified-name',
      };
    }
  }

  return null;
}

/** A node a `Receiver.method()` call can name as the method's owning type. */
function isMethodOwnerKind(n: Node): boolean {
  return n.kind === 'class' || n.kind === 'struct' || n.kind === 'union' || n.kind === 'interface' ||
    (n.language === 'scala' && n.kind === 'module');
}

/**
 * When a symbol name is ambiguous across files, prefer the candidate(s) declared
 * in the call site's own file, keeping the rest in their original order (#1079).
 * A same-file definition is the strongest language-agnostic signal for which of
 * several same-named symbols a call means; without it, resolution collapses onto
 * whichever was indexed first, so a call in `b/svc` wrongly targets `a/svc`.
 * No-op when there are <2 candidates or none share the call site's file.
 */
export function preferCallSiteFile(nodes: Node[], callSiteFile: string): Node[] {
  if (nodes.length < 2) return nodes;
  const same: Node[] = [];
  const other: Node[] = [];
  for (const n of nodes) {
    if (n.filePath === callSiteFile) same.push(n);
    else other.push(n);
  }
  return same.length ? [...same, ...other] : nodes;
}

/**
 * Languages whose object literals declare callable members — `export const
 * api = { call() {…}, get: () => {…} }` used as a namespace (#1573).
 */
const OBJECT_LITERAL_LANGUAGES = new Set<string>(['typescript', 'tsx', 'javascript', 'jsx', 'arkts']);

/** True when `inner`'s source range lies within `outer`'s (lines, then columns on a shared line). */
function rangeWithin(inner: Node, outer: Node): boolean {
  const innerEnd = inner.endLine ?? inner.startLine;
  const outerEnd = outer.endLine ?? outer.startLine;
  if (inner.startLine < outer.startLine || innerEnd > outerEnd) return false;
  if (inner.startLine === outer.startLine && inner.startColumn < outer.startColumn) return false;
  if (innerEnd === outerEnd && inner.endColumn > outer.endColumn) return false;
  return true;
}

function sameRange(a: Node, b: Node): boolean {
  return (
    a.startLine === b.startLine &&
    a.startColumn === b.startColumn &&
    (a.endLine ?? a.startLine) === (b.endLine ?? b.startLine) &&
    a.endColumn === b.endColumn
  );
}

/**
 * Resolve `container.member` where `container` is a VALUE holding an object
 * literal — `export const api = { call() {…}, get: () => {…} }` used as the
 * module's namespace (#1573). The members are extracted as plain functions
 * with BARE qualified names inside the constant's source extent (there is no
 * `api::call`), so neither the `Container::member` lookup the class-shaped
 * kinds use (#825) nor the declared-type inference for singleton instances
 * (#1292) can reach them, and every such call resolved to nothing — or, via
 * an import, to the constant itself. This looks the member up by CONTAINMENT:
 * a node named `member` whose range lies inside the container's, in the
 * container's own file. A helper declared inside a member's body is not a
 * member and is skipped; nothing else in the file can donate a match. Calls
 * take callable kinds only; other references accept value members too.
 */
export function resolveObjectLiteralMember(
  container: Node,
  member: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  confidence: number,
  resolvedBy: ResolvedRef['resolvedBy'],
): ResolvedRef | null {
  if (container.kind !== 'constant' && container.kind !== 'variable') return null;
  if (!OBJECT_LITERAL_LANGUAGES.has(container.language)) return null;
  if (!sameLanguageFamily(container.language, ref.language)) return null;

  const inFile = context.getNodesInFile(container.filePath);
  const callable = (n: Node) => n.kind === 'function' || n.kind === 'method';
  const valueMember = (n: Node) =>
    callable(n) || n.kind === 'property' || n.kind === 'variable' || n.kind === 'constant';
  const accepts = ref.referenceKind === 'calls' ? callable : valueMember;

  const inside = inFile.filter((n) => n.id !== container.id && rangeWithin(n, container));
  const property = objectLiteralProperty(container, member, context);
  if (property === null || property?.binding) return null;
  let candidates = inside.filter((n) => n.name === member && accepts(n) && (!property || property.contains(n)));
  if (candidates.length === 0) return null;

  // Drop a candidate nested inside ANOTHER callable's body within the literal
  // (`{ run() { const call = () => {}; } }` — `call` is `run`'s local, not a
  // member). Strict containment: an identically-ranged sibling node for the
  // same member (a property node over an arrow function) is not a body.
  const bodies = inside.filter(callable);
  candidates = candidates.filter(
    (c) => !bodies.some((b) => b.id !== c.id && !sameRange(b, c) && rangeWithin(c, b))
  );
  if (candidates.length === 0) return null;

  // Several survivors (a property AND a function for one arrow member, say):
  // a callable first, then the earliest in source order.
  candidates.sort((a, b) => {
    const ca = callable(a) ? 0 : 1;
    const cb = callable(b) ? 0 : 1;
    if (ca !== cb) return ca - cb;
    return a.startLine - b.startLine || a.startColumn - b.startColumn;
  });
  return {
    original: ref,
    targetNodeId: candidates[0]!.id,
    confidence,
    resolvedBy,
  };
}

/**
 * The binding an object-literal member names when it is a shorthand property
 * (`{ getUser }`) or a pair whose value is a bare identifier (`{ getUser:
 * fetchUser }`) — the usual way an API module assembles its namespace from
 * standalone functions (#1932). Only the literal's own members count: a member
 * of a nested object, a word inside a member's body, a comment or a string
 * never donates one. Null when the member is absent, or when its value is not
 * a bare identifier (`{ fn: 1 }` names nothing).
 */
export function objectLiteralMemberBinding(
  container: Node,
  member: string,
  context: ResolutionContext,
): string | null {
  return objectLiteralProperty(container, member, context)?.binding ?? null;
}

/** The last own property wins; an unknown spread/computed key invalidates earlier evidence. */
function objectLiteralProperty(
  container: Node,
  member: string,
  context: ResolutionContext,
): { binding: string | null; contains: (node: Node) => boolean } | null | undefined {
  const lines = context.getFileLines?.(container.filePath) ?? context.readFile(container.filePath)?.split('\n');
  if (!lines) return undefined;
  const extentLines = lines.slice(container.startLine - 1, container.endLine);
  if (!extentLines.length) return undefined;
  extentLines[extentLines.length - 1] = extentLines[extentLines.length - 1]!.slice(0, container.endColumn);
  extentLines[0] = extentLines[0]!.slice(container.startColumn);
  const extent = stripCommentsForRegex(extentLines.join('\n'), 'typescript');
  const code = blankStringContents(extent);
  // Start at THIS declarator, including its columns, never a sibling on the same line.
  const open = /^[^=]*=\s*(?:(?:Object\.(?:freeze|seal)\s*)?\(\s*)*\{/.exec(code);
  if (!open) return undefined;

  const members: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = open[0].length;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === '}') {
      if (depth === 0) {
        members.push({ start, end: i });
        break;
      }
      depth--;
    } else if (ch === ',' && depth === 0) {
      members.push({ start, end: i });
      start = i + 1;
    }
  }

  let selected: { start: number; end: number; binding: string | null } | null = null;
  for (const part of members) {
    const text = extent.slice(part.start, part.end).trim();
    if (/^(?:\.\.\.|\[)/.test(text)) { selected = null; continue; }
    const key = /^(?:(?:async|get|set)\s+)?\*?\s*(?:([A-Za-z_$][\w$]*)|['"]([^'"\\]*)['"])(?=\s*(?:[:(<,=]|$))/.exec(text);
    if ((key?.[1] ?? key?.[2]) !== member) continue;
    const value = text.slice(key![0].length).trim();
    const binding = value === '' ? member : /^:\s*([A-Za-z_$][\w$]*)$/.exec(value)?.[1] ?? null;
    selected = { ...part, binding };
  }
  if (!selected) return null;
  const offset = (node: Node): number => {
    let result = node.startColumn - container.startColumn;
    for (let line = container.startLine; line < node.startLine; line++) result += lines[line - 1]!.length + 1;
    return result;
  };
  const property = selected;
  return { binding: property.binding, contains: (node) => offset(node) >= property.start && offset(node) < property.end };
}

/**
 * Shared lexical lookup for namespace-object aliases (#1932): `api.getUser()` where
 * `api` is `const api = { getUser }` (or `{ getUser: fetchUser }`) in the
 * object's own file. The member's function is declared OUTSIDE the literal, so
 * containment (`resolveObjectLiteralMember`) finds nothing. Follow the binding
 * the member names — a symbol of this file, else one of its imports — unless a
 * parameter or nearer declaration shadows that name where the literal is
 * written (the edge would then name the wrong function).
 */
export function resolveObjectLiteralBinding(
  container: Node,
  member: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const binding = objectLiteralMemberBinding(container, member, context);
  if (!binding) return null;
  const at: UnresolvedRef = { ...ref, filePath: container.filePath, language: container.language,
    fromNodeId: container.id, line: container.startLine, column: container.startColumn };
  const inFile = context.getNodesInFile(container.filePath);
  if (inFile.some((n) => (n.kind === 'function' || n.kind === 'method') &&
      rangeWithin(container, n) && n.signature &&
      hasParameterBinding(`${n.signature} {`, binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))) return null;

  const lines = context.getFileLines?.(container.filePath) ?? context.readFile(container.filePath)?.split('\n');
  if (!lines) return null;
  const code = blankStringContents(stripCommentsForRegex(lines.join('\n'), 'typescript'));
  const offsets = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') offsets.push(i + 1);
  const scopeAt = (node: Node): number[] => {
    const end = (offsets[node.startLine - 1] ?? code.length) + node.startColumn;
    const scope: number[] = [];
    for (let i = 0; i < end; i++) {
      if (code[i] === '{') scope.push(i);
      else if (code[i] === '}') scope.pop();
    }
    return scope;
  };
  const scope = scopeAt(container);

  const callable = (n: Node) => n.kind === 'function' || n.kind === 'method' || n.kind === 'class';
  const accepts =
    ref.referenceKind === 'calls'
      ? callable
      : (n: Node) => callable(n) || n.kind === 'constant' || n.kind === 'variable' || n.kind === 'component';

  const locals = inFile
    .filter((n) => n.name === binding && n.id !== container.id &&
      ['function', 'class', 'constant', 'variable', 'component'].includes(n.kind))
    .map((node) => ({ node, scope: scopeAt(node) }))
    .filter((entry) => entry.scope.every((position, i) => scope[i] === position))
    .sort((a, b) => b.scope.length - a.scope.length);
  // Select the lexical binding BEFORE checking callability: a nearer value
  // shadows an outer function even if that value cannot be called.
  const local = locals[0]?.node;
  if (local) return accepts(local)
    ? { original: ref, targetNodeId: local.id, confidence: 0.85, resolvedBy: 'instance-method' }
    : null;

  const imported = context.resolveImport?.({ ...at, referenceName: binding });
  const target = imported ? context.getNodeById?.(imported.targetNodeId) : null;
  if (target && accepts(target)) {
    return { original: ref, targetNodeId: target.id, confidence: 0.85, resolvedBy: 'instance-method' };
  }
  return null;
}

// Exported for the precedence unit tests (#1079): they assert the
// preferredFqn → same-file → matches[0] ordering directly.
export function resolveMethodOnType(
  typeName: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  confidence: number,
  resolvedBy: ResolvedRef['resolvedBy'],
  /**
   * Optional FQN that identifies WHICH class declaration `typeName`
   * refers to in the caller's file. When multiple candidates share
   * the same qualifiedName (`FooConverter::convert` in both
   * `dao/converter/` and `service/converter/`), the FQN's
   * file-path-suffix picks the right one — the disambiguation
   * signal Java imports carry but the call site doesn't (#314).
   */
  preferredFqn?: string,
  /** Recursion guard for the supertype/conformance walk. */
  depth = 0,
): ResolvedRef | null {
  // Look up methods by name and match by qualifiedName ending in
  // `<typeName>::<methodName>`. This works whether the method is defined
  // in-class (`class Foo { int bar() { ... } }`) or out-of-line in a separate
  // file (`int Foo::bar() { ... }` in foo.cpp while class Foo is in foo.hpp).
  // The previous same-file approach missed the latter — the typical C++ layout.
  // Prefer the context's per-(type, method) memo: the raw name lookup fetches
  // EVERY node sharing the method name — tens of thousands of rows for a
  // collision-heavy Java name like `execute` — and re-filtering that per ref
  // was a dominant term in the #1122 watchdog kill on large repos. Only the
  // ref-independent filter is memoized; per-ref disambiguation stays below.
  let matches: Node[];
  if (context.getMethodMatches) {
    matches = context.getMethodMatches(typeName, methodName, ref.language);
  } else {
    const methodCandidates = context.getNodesByName(methodName);
    const want = `${typeName}::${methodName}`;
    matches = [];
    for (const m of methodCandidates) {
      if (m.kind !== 'method') continue;
      if (!sameLanguageFamily(m.language, ref.language)) continue;
      const qn = m.qualifiedName;
      if (qn === want || qn.endsWith(`::${want}`)) {
        matches.push(m);
      }
    }
  }
  if (matches.length === 0) {
    // Conformance fallback: the method may be defined on a supertype `typeName`
    // extends, or on a protocol / trait it conforms to (e.g. a Swift protocol-
    // extension method, a C# default-interface or extension method, a Kotlin
    // extension on a supertype). Walk supertypes transitively (depth-capped) via
    // the resolved implements/extends edges — empty in the first resolution pass,
    // populated in the conformance pass. Still VALIDATED (the method must exist on
    // a supertype), so a wrong inference produces no edge.
    if (depth < 4 && context.getSupertypes) {
      const viaSupers = nmTimedT('rmot-supers', ref, (): ResolvedRef | null => {
        for (const supertype of context.getSupertypes!(typeName, ref.language)) {
          const via = resolveMethodOnType(
            supertype, methodName, ref, context, confidence, resolvedBy, preferredFqn, depth + 1,
          );
          if (via) return via;
        }
        return null;
      });
      if (viaSupers) return viaSupers;
    }
    return null;
  }

  if (matches.length > 1 && preferredFqn) {
    const ext = ref.language === 'kotlin' ? '.kt' : '.java';
    const fqnPath = preferredFqn.replace(/\./g, '/') + ext;
    const chosen = matches.find((m) => {
      const fp = m.filePath.replace(/\\/g, '/');
      return fp.endsWith(fqnPath) || fp.endsWith('/' + fqnPath);
    });
    if (chosen) {
      return {
        original: ref,
        targetNodeId: chosen.id,
        confidence,
        resolvedBy,
      };
    }
  }

  // Language-agnostic disambiguation: when several same-named methods survive
  // (e.g. two files each declaring `class Logger { void log(); }` — an ODR
  // clash, an anonymous-namespace type, or separate translation units), prefer
  // the definition in the CALL SITE's own file. Without this, every ambiguous
  // call collapses onto the first-indexed definition, so a call in `b/svc.cpp`
  // wrongly points at `a/svc.cpp` (#1079). This runs AFTER the `preferredFqn`
  // block, so Java/Kotlin import disambiguation — whose target is intentionally
  // in ANOTHER file (#314) — is unaffected: that block returns early whenever
  // an import FQN pins the class.
  if (ref.referenceKind === 'function_ref' && matches.length !== 1) return null;
  const ordered = preferCallSiteFile(matches, ref.filePath);
  return {
    original: ref,
    targetNodeId: ordered[0]!.id,
    confidence,
    resolvedBy,
  };
}

// C++ keywords/control-flow tokens that can appear right before a receiver
// (e.g. `return ptr->m()`) and must NOT be treated as a type.
const CPP_NON_TYPE_TOKENS = new Set([
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'goto', 'throw', 'new', 'delete', 'co_await', 'co_yield',
  'co_return', 'static_cast', 'const_cast', 'dynamic_cast', 'reinterpret_cast',
  'sizeof', 'alignof', 'typeid', 'and', 'or', 'not', 'xor',
]);

function normalizeCppTypeName(typeName: string): string | null {
  const normalized = typeName
    .replace(/\b(const|volatile|mutable|typename|class|struct)\b/g, ' ')
    .replace(/[&*]+/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;
  const parts = normalized.split(/::/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return null;
  if (CPP_NON_TYPE_TOKENS.has(last)) return null;
  return last;
}

// Declarator regex: matches `Type receiver`, `Type* receiver`, `Type *receiver`,
// `Type*receiver`, `Type<X> receiver`, etc., REQUIRING a declarator terminator
// (`;`, `=`, `,`, `)`, `[`, `{`, `(`, or end-of-line) after the receiver. The
// terminator rules out uses like `return receiver->m()` where the preceding
// token is a keyword, not a type.
function buildDeclaratorRegex(escapedReceiver: string): RegExp {
  return new RegExp(
    `([A-Za-z_][\\w:]*(?:\\s*<[^;=(){}]+>)?(?:\\s*[*&]+)?)\\s*\\b${escapedReceiver}\\b\\s*(?=[;=,)\\[{(]|$)`,
  );
}

function inferCppReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth = 0,
): string | null {
  // Per-file lines cache when available — this runs per `receiver->method()`
  // ref and re-splitting the file each time is the same quadratic as the
  // shared inferrer's (#1122).
  const lines = context.getFileLines
    ? context.getFileLines(ref.filePath)
    : (context.readFile(ref.filePath)?.split(/\r?\n/) ?? null);
  if (!lines || lines.length === 0) return null;

  const callLineIndex = Math.max(0, Math.min(lines.length - 1, ref.line - 1));
  const escapedReceiver = receiverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const receiverPattern = new RegExp(`\\b${escapedReceiver}\\b`);
  const declaratorRegex = buildDeclaratorRegex(escapedReceiver);

  for (let i = callLineIndex; i >= 0; i--) {
    const line = lines[i];
    if (!line || !receiverPattern.test(line)) continue;

    const declaratorMatch = line.match(declaratorRegex);
    if (declaratorMatch) {
      const normalized = normalizeCppTypeName(declaratorMatch[1] ?? '');
      if (normalized === 'auto') {
        // `auto x = Foo::instance();` — the declared type is deduced; recover it
        // from the initializer (call return type / construction) (#645).
        const initType = inferCppAutoInitializerType(line, receiverName, ref, context, depth);
        if (initType) return initType;
        // No usable initializer on this line — keep scanning earlier ones.
      } else if (normalized) {
        return normalized;
      }
    }
  }

  const headerCandidates = [
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.h'),
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.hpp'),
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.hxx'),
  ].filter((candidate, index, arr) => arr.indexOf(candidate) === index && candidate !== ref.filePath);

  for (const headerPath of headerCandidates) {
    if (!context.fileExists(headerPath)) continue;
    const headerLines = context.getFileLines
      ? context.getFileLines(headerPath)
      : (context.readFile(headerPath)?.split(/\r?\n/) ?? null);
    if (!headerLines) continue;

    for (const line of headerLines) {
      if (!receiverPattern.test(line)) continue;
      const declaratorMatch = line.match(declaratorRegex);
      if (!declaratorMatch) continue;
      const normalized = normalizeCppTypeName(declaratorMatch[1] ?? '');
      if (normalized && normalized !== 'auto') return normalized;
    }
  }

  return null;
}

/**
 * Last `::`-separated segment of a (possibly namespace-qualified) C++ name.
 */
function cppLastSegment(name: string): string {
  const parts = name.split('::').filter(Boolean);
  return parts[parts.length - 1] ?? name;
}

/**
 * Return type captured at extraction for `Class::method` (or a free function),
 * read off the indexed node's `returnType` — used by the C++ (#645) and PHP
 * (#608) chained-call resolvers. Language-filtered. Null when not indexed or no
 * return type was recorded (a `void`/primitive return).
 */
function lookupCalleeReturnType(
  callee: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  let method = callee;
  let cls: string | null = null;
  if (callee.includes('::')) {
    const parts = callee.split('::').filter(Boolean);
    method = parts[parts.length - 1] ?? callee;
    cls = parts.slice(0, -1).join('::');
  }
  const candidates = context.getNodesByName(method).filter(
    (n) =>
      (n.kind === 'method' || n.kind === 'function') &&
      n.language === ref.language &&
      !!n.returnType,
  );
  if (cls) {
    const want = `${cls}::${method}`;
    // The call site may name the class with MORE namespace qualification than
    // the stored node (`details::registry::instance` at the call vs
    // `registry::instance` on the node — the receiver type only carries the
    // immediate class), or LESS. Accept an exact match or either being a
    // namespace-suffix of the other; the shared `::<class>::<method>` tail keeps
    // it specific.
    const m = candidates.find(
      (n) =>
        n.qualifiedName === want ||
        n.qualifiedName.endsWith(`::${want}`) ||
        want.endsWith(`::${n.qualifiedName}`),
    );
    return m?.returnType ?? null;
  }
  return candidates.find((n) => n.kind === 'function')?.returnType ?? null;
}

/** Does the graph contain an aggregate type named `name`'s last segment? */
function cppClassExists(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const last = cppLastSegment(name);
  return context
    .getNodesByName(last)
    .some((n) => (n.kind === 'class' || n.kind === 'struct' || n.kind === 'union') && n.language === ref.language);
}

/**
 * Infer the class produced by a C++ call/construction expression, using return
 * types captured at extraction (#645). Handles, in order:
 *   - `make_unique<T>()` / `make_shared<T>()`        → T
 *   - single-level member call `recv.method()`       → recv's type, then method's return
 *   - `Class::method()` / free `func()`              → the callee's recorded return type
 *   - direct construction `Type()` / `ns::Type()`    → Type
 * Returns null when undeterminable. Callers MUST still validate the outer method
 * exists on the result before creating an edge, so a wrong guess stays silent.
 */
function resolveCppCallResultType(
  inner: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth = 0,
): string | null {
  if (depth > 3) return null; // guard against pathological mutual recursion
  const expr = inner.trim();

  const make = expr.match(/(?:^|::)(?:make_unique|make_shared)\s*<\s*([A-Za-z_]\w*)/);
  if (make) return make[1] ?? null;

  // Single-level member call `recv.method` (the `manager.view().render()` shape).
  const dotIdx = expr.lastIndexOf('.');
  if (dotIdx > 0) {
    const recv = expr.slice(0, dotIdx);
    const method = expr.slice(dotIdx + 1);
    if (recv.includes('.') || recv.includes('(') || recv.includes('::')) return null; // single level only
    const recvType = inferCppReceiverType(recv, ref, context, depth + 1);
    if (!recvType) return null;
    return lookupCalleeReturnType(`${recvType}::${method}`, ref, context);
  }

  const ret = lookupCalleeReturnType(expr, ref, context);
  if (ret) return ret;

  // Direct construction — the callee itself names a class/struct.
  if (cppClassExists(expr, ref, context)) return cppLastSegment(expr);

  return null;
}

/**
 * Recover the type of an `auto`-declared local from its initializer on the
 * declaration line — `auto x = Foo::instance();`, `auto w = make_unique<W>();`,
 * `auto p = new W();`, `auto w = Widget();` (#645).
 */
function inferCppAutoInitializerType(
  line: string,
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth: number,
): string | null {
  const escaped = receiverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = line.match(new RegExp(`\\b${escaped}\\b\\s*=\\s*([^;]+)`));
  if (!m || !m[1]) return null;
  const init = m[1].trim();

  const neu = init.match(/^new\s+([A-Za-z_][\w:]*)/);
  if (neu && neu[1]) return cppLastSegment(neu[1]);

  // A call or construction: `Foo(...)`, `A::b(...)`, `make_unique<T>(...)`.
  const call = init.match(/^([A-Za-z_][\w:]*(?:\s*<[^>;]*>)?)\s*\(/);
  if (call && call[1]) return resolveCppCallResultType(call[1].replace(/\s+/g, ''), ref, context, depth + 1);

  return null;
}

/**
 * Resolve a C++ chained call whose receiver is itself a call — encoded by the
 * extractor as `<innerCallee>().<method>` (#645). The receiver's type is what
 * the inner call returns; the outer method is then resolved and VALIDATED on it
 * (resolveMethodOnType requires `cls::method` to exist), so a wrong inference
 * produces no edge rather than a wrong one.
 */
export function matchCppCallChain(
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const m = ref.referenceName.match(/^(.+)\(\)\.(\w+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const cls = resolveCppCallResultType(m[1], ref, context);
  if (!cls) return null;
  return resolveMethodOnType(cls, m[2], ref, context, 0.85, 'instance-method');
}

/**
 * Resolve a `::`-scoped factory chain whose receiver is a scoped/static call —
 * PHP `Cls::for($x)->method()` (#608, the per-credential Laravel client idiom) or
 * Rust `Foo::new().bar()` (an associated-function call) — both encoded by the
 * extractor as `Cls::factory().method`. The receiver's type is what `Cls::factory`
 * returns: a `self` marker (PHP `: self`/`: static`, Rust `-> Self`) resolves to
 * the factory's own type, a concrete return type to that type. The outer method is
 * then resolved and VALIDATED on it (resolveMethodOnType requires the method to
 * exist on the type or a supertype it conforms to), so a wrong inference yields no
 * edge rather than a wrong one. Shared by the `::`-receiver languages (PHP, Rust).
 */
export function matchScopedCallChain(
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const m = ref.referenceName.match(/^(.+)\(\)\.(\w+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const inner = m[1];
  const method = m[2];
  if (!inner.includes('::')) return null; // only static-factory (`Cls::method`) chains
  const factoryClass = inner.slice(0, inner.lastIndexOf('::'));
  const ret = lookupCalleeReturnType(inner, ref, context);
  if (!ret) return null;
  // `self` (the extractor's marker for self/static/$this) → the factory's class.
  const resolvedClass = ret === 'self' ? factoryClass : ret;
  return resolveMethodOnType(resolvedClass, method, ref, context, 0.85, 'instance-method');
}

/**
 * Languages where an unprefixed capitalized call `Foo(args)` constructs the
 * class (so a `Foo(args).method()` receiver's type is `Foo`). Java/C# need `new`,
 * so a bare `Foo()` there is a method call, not construction — excluded. Scala's
 * `Foo(args)` is a case-class / companion `apply`, which conventionally returns
 * `Foo` — and resolveMethodOnType validates, so a non-conventional `apply` that
 * returns another type simply yields no edge rather than a wrong one. Pascal/Delphi:
 * a `TFoo(x)` is a TYPECAST whose result is a `TFoo`, so `TFoo(x).method()` resolves
 * the method on `TFoo` — same shape, same validation.
 */
const CONSTRUCTS_VIA_BARE_CALL = new Set(['kotlin', 'swift', 'scala', 'dart', 'pascal']);

/**
 * Resolve a dotted chained call whose receiver is a static factory / fluent call —
 * `Foo.getInstance().bar()`, encoded by the extractor as `Foo.getInstance().bar`
 * (#645/#608 mechanism). The receiver's type is what `Foo.getInstance` returns
 * (its declared return type); the outer method is then resolved and VALIDATED on
 * it (resolveMethodOnType requires `Type::method` to exist), so a wrong inference
 * yields no edge rather than a wrong one (e.g. a same-named `bar()` on an
 * unrelated class is never matched). Shared by the dot-notation languages
 * (Java, Kotlin, C#, Swift) — same receiver shape, same `Class::method` qualified names.
 */
export function matchDottedCallChain(
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const m = ref.referenceName.match(/^(.+)\(\)\.(\w+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const inner = m[1]; // `Foo.getInstance`
  const method = m[2]; // `bar`
  const lastDot = inner.lastIndexOf('.');

  if (lastDot <= 0) {
    // Go: bare package-level factory FUNCTION `New().method()` — the receiver's
    // type is what `New` returns; resolve the method on that.
    if (ref.language === 'go') {
      const ret = lookupCalleeReturnType(inner, ref, context);
      if (ret) {
        return resolveMethodOnType(ret, method, ref, context, 0.85, 'instance-method', importedFqnOf(ret, ref, context));
      }
      // `inner` isn't a function with a captured return type — typically a
      // package-level VARIABLE holding a function value (e.g. gin's `engine()`),
      // whose type we can't recover. Fall back to bare-name resolution of the
      // method so we don't DROP an edge the un-re-encoded bare path would have
      // found. (When `inner` IS a real factory function but the method doesn't
      // exist on its return type, `ret` is truthy and we returned no edge above —
      // the absent-method safety guarantee is preserved.)
      //
      // CRITICAL: resolve the TARGET via a synthetic bare-name ref, but return the
      // match tied to the ORIGINAL `ref` (referenceName `inner().method`). The
      // batched resolver (resolveAndPersistBatched) reads unresolved rows from
      // offset 0 every pass and relies on the post-batch cleanup (row-id delete
      // for DB-loaded refs, referenceName-keyed delete otherwise, #1269) to
      // clear each resolved row so the batch empties. If we propagated the
      // synthetic ref's bare `method` as `.original`, a key-based delete
      // would never match the stored `inner().method` row, the batch would
      // never drain, and the loop would re-resolve + re-insert forever (a runaway
      // that grew gin's graph to 5M edges / 1.4 GB before this fix).
      const bareRef = { ...ref, referenceName: method };
      const bareMatch = matchByExactName(bareRef, context) ?? matchFuzzy(bareRef, context);
      return bareMatch ? { ...bareMatch, original: ref } : null;
    }
    // Constructor receiver `Foo(args).method()` (encoded `Foo().method`): a bare,
    // capitalized inner is a class construction, so the receiver's type is the
    // class itself — resolve the method on it. Only in languages where an
    // unprefixed capitalized call constructs the class (Kotlin, Swift); in Java/C#
    // a bare `Foo()` is a method call (constructors need `new`), so we must not
    // assume construction. A lowercase bare inner is a top-level `factory().method()`
    // whose type we can't recover — bail.
    if (!CONSTRUCTS_VIA_BARE_CALL.has(ref.language) || !/^[A-Z]/.test(inner)) return null;
    return resolveMethodOnType(inner, method, ref, context, 0.85, 'instance-method', importedFqnOf(inner, ref, context));
  }

  // Factory/fluent receiver `Receiver.factory(args).method()`: the receiver's
  // type is what `Receiver.factory` returns (its declared return type).
  const factoryClass = inner.slice(0, lastDot).split('.').pop(); // simple class name
  const factoryMethod = inner.slice(lastDot + 1);
  if (!factoryClass || !factoryMethod) return null;
  const ret = lookupCalleeReturnType(`${factoryClass}::${factoryMethod}`, ref, context);
  if (!ret) {
    // Objective-C: a class-message factory — `[X alloc]`, `[X new]`,
    // `[X sharedFoo]` — returns an instance of the RECEIVER class `X` by
    // convention (`instancetype`). So when the factory's own return type isn't
    // recoverable (its selector returns `instancetype`, or `alloc`/`new` aren't
    // user-defined nodes at all), the receiver's type is the class `X` itself.
    // This resolves the ubiquitous `[[X alloc] init]` and singleton chains.
    // resolveMethodOnType validates against X (and its supertypes), so a class
    // whose method actually lives elsewhere yields NO edge, not a wrong one — and
    // crucially this does NOT fire when a concrete return type WAS captured but
    // simply lacks the method (that already returned null above: absent-method
    // safety, so a same-named decoy is still never matched).
    if (ref.language === 'objc' && /^[A-Z]/.test(factoryClass)) {
      return resolveMethodOnType(factoryClass, method, ref, context, 0.8, 'instance-method', importedFqnOf(factoryClass, ref, context));
    }
    // Pascal/Delphi: the extractor only re-encodes a `TFoo`/`IFoo`-prefixed chain
    // (the type-naming convention), so `factoryClass` is always a real class here.
    // A factory whose return type wasn't captured is a CONSTRUCTOR
    // (`TFileMem.Create().SetCachePerformance` — `constructor Create` has no `:
    // TBar` annotation but returns its own class) or an unannotated function. In
    // both cases the receiver's type is the class itself, so resolve the method on
    // `factoryClass`. resolveMethodOnType validates against it (and its
    // supertypes), so a wrong inference yields no edge — and this never fires when
    // a return type WAS captured but lacks the method (absent-method safety above).
    if (ref.language === 'pascal' && /^[TI]/.test(factoryClass)) {
      return resolveMethodOnType(factoryClass, method, ref, context, 0.8, 'instance-method', importedFqnOf(factoryClass, ref, context));
    }
    return null;
  }
  return resolveMethodOnType(ret, method, ref, context, 0.85, 'instance-method', importedFqnOf(ret, ref, context));
}

/**
 * When several classes share a simple type name, the caller file's import of
 * that type is the only signal that names WHICH one (#314). Returns the imported
 * FQN for `typeName` in the ref's file, or undefined.
 */
function importedFqnOf(
  typeName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | undefined {
  const imports = context.getImportMappings(ref.filePath, ref.language);
  return imports.find((i) => i.localName === typeName)?.source;
}

/**
 * Java/Kotlin: infer a receiver's declared type by walking field declarations
 * in the class enclosing the call site. The field's `signature` is already in
 * the form "<TypeName> <fieldName>" (set by tree-sitter.ts extractField), so we
 * pull the type from there. Handles Spring `@Resource UserBO userbo;` /
 * `@Autowired private UserService userService;` where the receiver field name
 * doesn't match the class name by Java naming convention.
 *
 * Returns the bare type name (generics stripped, dotted package stripped) or
 * null when no matching field is in the enclosing class.
 */
function inferJavaFieldReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  const inFile = context.getNodesInFile(ref.filePath);
  if (inFile.length === 0) return null;

  // Find the class enclosing the call line (tightest match by latest start).
  let enclosing: Node | null = null;
  for (const n of inFile) {
    if (n.kind !== 'class' && n.kind !== 'interface') continue;
    if (n.language !== ref.language) continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine <= ref.line && end >= ref.line) {
      if (!enclosing || n.startLine >= enclosing.startLine) enclosing = n;
    }
  }
  if (!enclosing) return null;

  const enclosingEnd = enclosing.endLine ?? enclosing.startLine;
  const field = inFile.find(
    (n) =>
      n.kind === 'field' &&
      n.name === receiverName &&
      n.language === ref.language &&
      n.startLine >= enclosing.startLine &&
      (n.endLine ?? n.startLine) <= enclosingEnd,
  );
  if (!field || !field.signature) return null;

  // Signature shape: "<TypeName> <fieldName>" (extractField). Pull the type,
  // strip generics + dotted package, drop array/varargs markers.
  const beforeName = field.signature.slice(
    0,
    field.signature.lastIndexOf(field.name),
  );
  const typeRaw = beforeName.trim();
  if (!typeRaw) return null;

  const typeNoGenerics = typeRaw.replace(/<[^>]*>/g, '').trim();
  const typeNoArray = typeNoGenerics.replace(/\[\s*\]/g, '').replace(/\.\.\.$/, '').trim();
  const parts = typeNoArray.split(/[.\s]+/).filter(Boolean);
  const lastPart = parts[parts.length - 1];
  if (!lastPart) return null;
  if (!/^[A-Z]/.test(lastPart)) return null; // primitives / lowercase → skip
  return lastPart;
}

// ── Local-variable receiver-type inference (#1108) ──────────────────────────
//
// Instance calls through a local variable (`const lg = new Logger(); lg.log()`)
// only resolved in C++ before this — no other language could learn the
// receiver's type. Local variables are not indexed as nodes (node-explosion),
// so, like the C++ inferrer above, we read the enclosing function's source and
// match the receiver's declaration/initializer to recover its type. The type is
// then handed to resolveMethodOnType, which VALIDATES that the type actually
// declares the method, so a mis-inference produces NO edge — the safety net
// that lets the patterns below stay simple. C++ keeps its dedicated inferrer
// (header scan + `auto`); this covers every other language.

// Tokens a loose pattern might capture that are never a user-defined type.
const NON_TYPE_RECEIVER_TOKENS = new Set([
  'this', 'self', 'super', 'new', 'return', 'await', 'yield', 'typeof',
  'null', 'nil', 'None', 'true', 'false', 'True', 'False', 'undefined',
]);

/**
 * Normalize a captured type expression to a simple type name: drop generic
 * args and pointer/ref markers, take the last `.`/`::`-qualified segment, and
 * reject obvious non-types.
 */
export function normalizeInferredTypeName(raw: string): string | null {
  const cleaned = raw.replace(/<[^>]*>/g, '').replace(/[&*]/g, '').trim();
  const seg = cleaned.split(/[.:]+/).filter(Boolean).pop();
  if (!seg) return null;
  if (NON_TYPE_RECEIVER_TOKENS.has(seg)) return null;
  return seg;
}

/**
 * Per-language patterns that recover a local variable's (or typed parameter's)
 * type from its declaration/initializer. Each regex captures the type in group
 * 1; `r` is the already-escaped receiver name. Ordered most-specific first.
 * PascalCase is required in the capture where the language convention allows,
 * as a cheap false-positive guard on top of resolveMethodOnType's validation.
 */
/**
 * Compiled-pattern memo for the receiver-type pattern builders below. They
 * run for EVERY `receiver.method()` ref the matcher attempts, compiling 2–4
 * fresh RegExp objects per call — and receivers repeat massively (`self`
 * alone accounts for tens of thousands of refs on a Lua repo, measured 41µs
 * per methodCall miss on kong with compilation a large slice). The patterns
 * are a pure function of (language, receiver) and non-global (`.match()`
 * never touches lastIndex), so shared instances are behavior-identical.
 * FIFO-capped with no per-get mutation (the §7a.6 LRU-churn lesson): a hit
 * costs one Map lookup, overflow evicts oldest, and an evicted entry simply
 * recompiles exactly as every call did before this memo.
 */
const PATTERN_MEMO = new Map<string, RegExp[]>();
const PATTERN_MEMO_CAP = 8192;

/**
 * Per-context incremental receiver-scan states for inferLocalReceiverType
 * (see the memo comment there). Keyed (file, scopeStart, language, receiver);
 * entries are a few dozen bytes, count is bounded by distinct receiver uses
 * (same order as the context's other per-file caches). MUST drop whenever the
 * context's file caches drop — the states are derived from file lines — so
 * ReferenceResolver.clearCaches calls clearNameMatcherMemos alongside
 * clearImportResolverMemos.
 */
type InferScanState = { hi: number; ansIdx: number; ansType: string | null };
const INFER_SCAN_STATES = new WeakMap<ResolutionContext, Map<string, InferScanState>>();

/** Awaited inference caches are scoped to the resolver's stable-source window.
 * Negative file eligibility avoids scanning ordinary receiver misses; call-site
 * keys distinguish shadowed bindings and sibling blocks. Both caches are bounded
 * and are invalidated with file/import caches on sync. */
type AwaitedType = { name: string | null; filePath: string };
type AwaitedFile = {
  code: string; ready: boolean; offsets: number[]; names: Set<string>;
  scopes: { start: number; end: number; parent: number }[];
  declarations: Map<string, { index: number; length: number }[]>;
};
const AWAITED_TYPE_MEMO = new WeakMap<ResolutionContext, Map<string, AwaitedType | null>>();
const AWAITED_FILES = new WeakMap<ResolutionContext, Map<string, AwaitedFile | null>>();

function getInferScanStates(context: ResolutionContext): Map<string, InferScanState> {
  let m = INFER_SCAN_STATES.get(context);
  if (!m) {
    m = new Map();
    INFER_SCAN_STATES.set(context, m);
  }
  return m;
}

/** Drop the per-context scan states (see ReferenceResolver.clearCaches). */
export function clearNameMatcherMemos(context: ResolutionContext): void {
  INFER_SCAN_STATES.delete(context);
  PYTHON_MEMBER_LINES.delete(context);
  AWAITED_TYPE_MEMO.delete(context);
  AWAITED_FILES.delete(context);
  C_STATIC_MEMO.delete(context);
  RUST_TRAIT_IMPL_MEMO.delete(context);
  RUST_USES.delete(context);
  LEXICAL_SCOPE_MEMO.delete(context);
  PY_IMPORTS.delete(context);
  PY_MODULE_LOCAL.delete(context);
  SEALED_MODULES.delete(context);
  LOCAL_BINDING_MEMO.delete(context);
  LOCAL_BINDING_SITES.delete(context);
  SELECTOR_NAMES.delete(context);
  GET_STATE_FILES.delete(context);
  TS_FIELD_DECL_MEMO.delete(context);
  TS_CLASS_LINES.delete(context);
  TARGET_LANGUAGE.delete(context);
}

function memoPatterns(key: string, build: () => RegExp[]): RegExp[] {
  const hit = PATTERN_MEMO.get(key);
  if (hit) return hit;
  const patterns = build();
  if (PATTERN_MEMO.size >= PATTERN_MEMO_CAP) {
    const oldest = PATTERN_MEMO.keys().next().value;
    if (oldest !== undefined) PATTERN_MEMO.delete(oldest);
  }
  PATTERN_MEMO.set(key, patterns);
  return patterns;
}

export function localReceiverTypePatterns(language: Language, r: string): RegExp[] {
  return memoPatterns(`${language}|${r}`, () => buildLocalReceiverTypePatterns(language, r));
}

function buildLocalReceiverTypePatterns(language: Language, r: string): RegExp[] {
  switch (language) {
    case 'typescript':
    case 'javascript':
    case 'tsx':
    case 'jsx':
    case 'arkts':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*new\\s+([A-Za-z_$][\\w.$]*)`), // = new Logger()
        // No keyword requirement, so this matches BOTH a local annotation
        // (`const lg: Logger`) and a typed parameter (`function use(lg: Logger)`
        // / `(lg: Logger) =>`) — the parameter case the old `const|let|var`
        // prefix excluded (#1125). Mirrors Kotlin/Swift/Scala; the capture stops
        // at `<` so a generic-typed param (`repo: Repository<User>`) still yields
        // `Repository`. resolveMethodOnType validates the type actually declares
        // the method, so the looser match produces no edge on a mis-inference.
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w.$]*)`), // lg: Logger  (annotation or typed param)
      ];
    case 'python':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z][\\w.]*)\\s*\\(`), // lg = Logger(...)
        // A quoted forward reference (`lg: "Logger"`, `lg: 'pkg.Logger'`) is the
        // same annotation — and what every file under `from __future__ import
        // annotations` or with a not-yet-defined class writes. The unquoted
        // pattern below stopped at the quote and read no type at all, so the
        // call produced no edge (#1684). Tried first: it is the stricter shape.
        new RegExp(`\\b${r}\\b\\s*:\\s*["']([A-Z][\\w.]*)["']`), // lg: "Logger"
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w.]*)`), // lg: Logger  (PEP 526)
      ];
    case 'java':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*new\\s+([A-Za-z_][\\w.]*)`), // = new Logger()
        new RegExp(`\\b([A-Z][\\w.]*)\\s+${r}\\b\\s*[=;,)]`), // Logger lg;  / param
      ];
    case 'kotlin':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z][\\w.]*)\\s*\\(`), // val lg = Logger(...)
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w.]*)`), // val lg: Logger  / param
      ];
    case 'csharp':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*new\\s+([A-Za-z_][\\w.]*)`), // = new Logger()
        new RegExp(`\\b([A-Z][\\w.]*)\\s+${r}\\b\\s*[=;,)]`), // Logger lg;  / param
      ];
    case 'swift':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z][\\w.]*)\\s*\\(`), // let lg = Logger(...)
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w.]*)`), // let lg: Logger  / param
      ];
    case 'rust':
      return [
        new RegExp(`\\blet\\s+(?:mut\\s+)?${r}\\b(?:\\s*:[^=]+)?=\\s*&?(?:mut\\s+)?([A-Z][\\w]*)`), // let lg = Logger::new()/Logger{}/Logger
        // No `let`, so this covers a `let lg: Logger` binding AND a typed
        // parameter (`fn use(lg: &Logger)`, a closure `|lg: Logger|`) — the
        // parameter case the old `let`-anchored pattern excluded (#1125).
        new RegExp(`\\b${r}\\s*:\\s*&?(?:mut\\s+)?([A-Z][\\w]*)`), // lg: Logger  (binding or typed param)
      ];
    case 'go':
      return [
        new RegExp(`\\b${r}\\b\\s*:=\\s*&?([A-Za-z_][\\w.]*)\\s*{`), // lg := Logger{} / &Logger{}
        new RegExp(`\\bvar\\s+${r}\\s+\\*?([A-Za-z_][\\w.]*)`), // var lg Logger / *Logger
        // A typed parameter / method receiver (`func use(lg Logger)`,
        // `func (l Logger) M()`) — name-before-type with no `var`/`:=` (#1125).
        // PascalCase-guarded (unlike the anchored patterns above) to keep the
        // keyword-free `ident Type` shape from matching unrelated pairs; the
        // enclosing-scope bound already excludes package-level struct fields.
        new RegExp(`\\b${r}\\s+\\*?([A-Z][\\w.]*)`), // func use(lg Logger) / (l Logger)
      ];
    case 'ruby':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z][\\w:]*)\\.new\\b`), // lg = Logger.new
      ];
    case 'scala':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*(?:new\\s+)?([A-Z][\\w.]*)`), // val lg = new Logger / Logger(...)
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w.]*)`), // val lg: Logger  / param
      ];
    case 'dart':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z][\\w.]*)\\s*\\(`), // var lg = Logger(...)
        // Trailing `[=;,)]` (not just `[=;]`) so a typed parameter — `Logger lg)`
        // / `Logger lg,` — matches too, not only `Logger lg = ...` / `Logger lg;`
        // (#1125). Mirrors Java/C#.
        new RegExp(`\\b([A-Z][\\w.]*)\\s+${r}\\b\\s*[=;,)]`), // Logger lg = ...  / param
      ];
    case 'php':
      return [
        new RegExp(`\\$?${r}\\b\\s*=\\s*new\\s+([A-Za-z_\\\\][\\w\\\\]*)`), // $lg = new Logger()
        // A typed parameter (`function use(Logger $lg)`, `?Logger $lg`,
        // `\\App\\Logger $lg`, `&$lg` by-ref) and a typed `catch (E $e)` — the
        // type sits before the `$`-variable (#1125). Namespace `\\` allowed.
        new RegExp(`\\b([A-Za-z_\\\\][\\w\\\\]*)\\s+&?\\$${r}\\b`), // Logger $lg  (typed param)
      ];
    case 'lua':
    case 'luau':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z][\\w]*)\\.new\\b`), // local lg = Logger.new()
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z][\\w]*)\\s*\\(`), // local lg = Logger(...)  (callable table)
        // Luau annotation (`local lg: Logger`) / typed param — but Lua's
        // method-call syntax is the IDENTICAL `receiver:Name` shape, and the
        // backward scan starts on the call's own line, so without a gate any
        // PascalCase method call (`lg:Log()`, the Roblox convention)
        // self-matches as "type = Log" before the scan reaches the real
        // declaration (#1124). The lookahead rejects a capture followed by
        // any of Lua's three call forms — `(args)`, `"s"`/`'s'`/`[[s]]`,
        // `{t}` — and its leading `[\w.]` alternative stops backtracking from
        // shrinking the capture to dodge the gate (`lg:Log()` would otherwise
        // still match, as `Lo`).
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w.]*)(?![\\w.]|\\s*[({"'\\[])`), // local lg: Logger  / typed param
      ];
    case 'r':
      return [
        new RegExp(`\\b${r}\\b\\s*(?:<-|<<-|=)\\s*([A-Z][\\w.]*)\\$new\\b`), // lg <- Logger$new()  (R6)
      ];
    case 'pascal':
      return [
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w]*)`), // var lg: TLogger  / param lg: TLogger
        new RegExp(`\\b${r}\\b\\s*:=\\s*([A-Z][\\w.]*)\\.Create\\b`), // lg := TLogger.Create
      ];
    case 'cfml':
    case 'cfscript':
      return [
        // svc = new UserService() / new path.to.UserService() — dotted component
        // paths reduce to their final segment via normalizeInferredTypeName.
        // Also matches inside tag markup (`<cfset svc = new UserService()>`)
        // since the scan reads raw source lines.
        new RegExp(`\\b${r}\\b\\s*=\\s*new\\s+([A-Za-z_][\\w.]*)`),
        // The classic form: svc = createObject("component", "path.to.UserService")
        // (casing of createObject varies in the wild), plus the modern
        // single-argument form createObject("path.to.UserService").
        new RegExp(`\\b${r}\\b\\s*=\\s*[Cc]reate[Oo]bject\\s*\\(\\s*["']component["']\\s*,\\s*["']([\\w.]+)["']`),
        new RegExp(`\\b${r}\\b\\s*=\\s*[Cc]reate[Oo]bject\\s*\\(\\s*["']([\\w.]+)["']\\s*\\)`),
        // Typed cfscript parameter: `function save(UserService svc)` /
        // `required UserService svc` — CFML's built-in types (string, numeric,
        // any, struct…) are lowercase by convention, so the PascalCase guard
        // excludes them.
        new RegExp(`\\b([A-Z][\\w.]*)\\s+${r}\\b\\s*[=;,)]`),
        // Tag-form typed argument, either attribute order:
        // <cfargument name="svc" type="path.to.UserService">
        new RegExp(`\\bcfargument[^>\\n]*\\bname\\s*=\\s*["']${r}["'][^>\\n]*\\btype\\s*=\\s*["']([\\w.]+)["']`, 'i'),
        new RegExp(`\\bcfargument[^>\\n]*\\btype\\s*=\\s*["']([\\w.]+)["'][^>\\n]*\\bname\\s*=\\s*["']${r}["']`, 'i'),
        // Component property (incl. WireBox DI): `property name="svc"
        // inject="UserService";` / `<cfproperty name="svc" type="UserService">`,
        // either attribute order. An inject DSL value with a namespace
        // (`inject="svc@core"`) captures only the leading name and simply
        // fails type-validation — no edge, never a wrong one.
        new RegExp(`\\b(?:cf)?property\\b[^;\\n]*\\bname\\s*=\\s*["']${r}["'][^;\\n]*\\b(?:type|inject)\\s*=\\s*["']([\\w.]+)["']`, 'i'),
        new RegExp(`\\b(?:cf)?property\\b[^;\\n]*\\b(?:type|inject)\\s*=\\s*["']([\\w.]+)["'][^;\\n]*\\bname\\s*=\\s*["']${r}["']`, 'i'),
      ];
    default:
      return [];
  }
}

/** 1-based start line of the tightest function/method enclosing the call. */
function enclosingScopeStartLine(ref: UnresolvedRef, context: ResolutionContext): number {
  let start = 1;
  for (const n of context.getNodesInFile(ref.filePath)) {
    if (n.kind !== 'function' && n.kind !== 'method') continue;
    if (n.language !== ref.language) continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine <= ref.line && end >= ref.line && n.startLine >= start) {
      start = n.startLine;
    }
  }
  return start;
}

/**
 * Infer a receiver's type from its local declaration/initializer in the
 * enclosing function body. Language-dispatched; returns null for languages
 * without patterns or when no declaration is found. Bounded to the enclosing
 * scope so a same-named variable in another function can't leak in.
 */
function inferLocalReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  // CFML scope prefixes: `variables.svc` / `this.svc` name a COMPONENT-scoped
  // field whose assignment or `property` declaration usually lives outside the
  // calling function (the init-pseudoconstructor / WireBox-injection pattern),
  // and `local.svc` is an explicit function-local. Strip the prefix so the
  // declaration patterns match (`variables.svc = new X()`, `property
  // name="svc" …`, `var svc = …` all bind the bare name), and widen the scan
  // to the whole file for the component-scoped forms — nearest-declaration-
  // backward still wins, so a function-local shadowing the field is preferred.
  let scanReceiver = receiverName;
  let componentScoped = false;
  if (ref.language === 'cfml' || ref.language === 'cfscript') {
    const scoped = receiverName.match(/^(variables|this|local|arguments)\.(.+)$/i);
    if (scoped) {
      scanReceiver = scoped[2]!;
      const scope = scoped[1]!.toLowerCase();
      componentScoped = scope === 'variables' || scope === 'this';
    }
  }
  // PHP `$this->prop` receiver — the property's declaration lives outside the
  // calling method (a promoted constructor parameter `private readonly Foo $prop`,
  // a typed property `private Foo $prop;`, or a classic constructor parameter
  // `Foo $prop` assigned in __construct). Strip the prefix and widen the scan to
  // the whole file (the constructor may sit below the calling method), but —
  // unlike CFML's scopes above — switch to PROPERTY-shaped patterns: a plain
  // `$prop` local or parameter lives in a different namespace than `$this->prop`
  // and can never shadow it, so the generic local patterns would type the
  // property from unrelated same-named variables in other methods (a wrong
  // 0.9-confidence edge, not a missing one).
  let phpProperty = false;
  if (ref.language === 'php') {
    const scoped = receiverName.match(/^this->(.+)$/);
    if (scoped) {
      scanReceiver = scoped[1]!;
      componentScoped = true;
      phpProperty = true;
    }
  }

  const escapedReceiver = scanReceiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = phpProperty
    ? phpPropertyTypePatterns(escapedReceiver)
    : localReceiverTypePatterns(ref.language, escapedReceiver);
  if (patterns.length === 0) return null;

  // Split through the context's per-file lines cache when available: this runs
  // for EVERY `receiver.method()` ref, and re-splitting the whole file per ref
  // was ~20% of total index CPU on Java-heavy repos (#1122).
  const lines = context.getFileLines
    ? context.getFileLines(ref.filePath)
    : (context.readFile(ref.filePath)?.split(/\r?\n/) ?? null);
  if (!lines || lines.length === 0) return null;

  const callIdx = Math.max(0, Math.min(lines.length - 1, ref.line - 1));
  const startIdx = componentScoped
    ? 0
    : Math.max(0, enclosingScopeStartLine(ref, context) - 1);

  const matchLine = (i: number): string | null => {
    const line = lines[i];
    if (!line) return null;
    // A generated/minified line (one multi-KB statement) is not something a
    // human-written local declaration lives on, and regexing it per ref is
    // pure waste — skip it rather than scan it.
    if (line.length > 10_000) return null;
    for (const re of patterns) {
      const m = line.match(re);
      if (m && m[1]) {
        const type = normalizeInferredTypeName(m[1]);
        if (type) return type;
      }
    }
    return null;
  };

  // Incremental-scan memo (INFER_SCAN_STATES): this scan runs for EVERY
  // `receiver.method()` ref and was measured at 61µs/ref on kong (2.4s of
  // worker time, 99% misses — `self:` calls hunting a declaration Lua never
  // writes). Refs for the same (file, scope, receiver) arrive in ~ascending
  // line order, and the scan is a pure function of the file's immutable
  // lines, so each line pays its regex matches ONCE per key instead of once
  // per ref: query(c) = highest matching line in [startIdx..c]; a monotonic
  // call extends the stored watermark by scanning only (hi..c] (the region
  // at-or-below the previous answer is already proven empty above it); a
  // non-monotonic call (rare — refs are rowid-ordered) falls back to the
  // plain bounded scan and leaves the state alone. componentScoped is keyed
  // out — its position-independent whole-file sweep below has different
  // semantics.
  if (!componentScoped) {
    const states = getInferScanStates(context);
    const key = `${ref.filePath}|${startIdx}|${ref.language}|${scanReceiver}`;
    const state = states.get(key);
    if (!state) {
      for (let i = callIdx; i >= startIdx; i--) {
        const type = matchLine(i);
        if (type) {
          states.set(key, { hi: callIdx, ansIdx: i, ansType: type });
          return type;
        }
      }
      states.set(key, { hi: callIdx, ansIdx: -1, ansType: null });
      return null;
    }
    if (callIdx >= state.hi) {
      for (let i = callIdx; i > state.hi; i--) {
        const type = matchLine(i);
        if (type) {
          state.ansIdx = i;
          state.ansType = type;
          break;
        }
      }
      state.hi = callIdx;
      return state.ansIdx >= startIdx ? state.ansType : null;
    }
    for (let i = callIdx; i >= startIdx; i--) {
      const type = matchLine(i);
      if (type) return type;
    }
    return null;
  }

  // Nearest declaration wins: scan backward from the call to the scope start.
  for (let i = callIdx; i >= startIdx; i--) {
    const type = matchLine(i);
    if (type) return type;
  }
  // A component-scoped field's declaration is position-independent — the
  // `variables.svc = new X()` pseudoconstructor assignment or `property`
  // declaration may sit BELOW the calling function in the file — so when the
  // backward pass finds nothing, sweep the remainder of the file too.
  if (componentScoped) {
    for (let i = callIdx + 1; i < lines.length; i++) {
      const type = matchLine(i);
      if (type) return type;
    }
  }
  // A PHP property with no statically-typed declaration (classic pre-7.4
  // style) may still be typed by what gets ASSIGNED to it — follow the
  // `$this->prop = $var` assignment to the assigned variable's own typed
  // declaration (a classic or multi-line constructor parameter, or a typed
  // setter's parameter).
  if (phpProperty) {
    return inferPhpAssignedPropertyType(escapedReceiver, lines, callIdx);
  }
  return null;
}

/** Infer only a visible awaited binding and its actual local/imported callee.
 * The signature already carries the return annotation in both extractors, so
 * multiline declarations and neighboring declarations cannot donate a type.
 * `null` means no awaited evidence; a null NAME means an awaited receiver whose
 * type is unknown, which must not fall back to an unrelated method name. */
function inferEsmAwaitedCallType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): AwaitedType | null {
  if (!/^[A-Za-z_$][\w$]*$/.test(receiverName)) return null;
  let files = AWAITED_FILES.get(context);
  if (!files) { files = new Map(); AWAITED_FILES.set(context, files); }
  let file = files.get(ref.filePath);
  if (file === undefined) {
    const source = context.readFile(ref.filePath) ?? '';
    file = null;
    // Raw eligibility is cheap; sanitize and index scopes only when a ref
    // actually uses one of these names. Comments cannot donate a binding:
    // the names are checked again after sanitizing on the first real lookup.
    const names = new Set([...source.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*await\s+[\w$]+\s*\(/g)].map(m => m[1]!));
    if (names.size) file = { code: source, ready: false, names, offsets: [], scopes: [], declarations: new Map() };
    if (files.size >= 256) files.delete(files.keys().next().value!);
    files.set(ref.filePath, file);
  }
  if (!file?.names.has(receiverName)) return null;
  if (!file.ready) {
    const code = blankStringContents(stripCommentsForRegex(file.code, 'typescript'));
    const names = new Set([...code.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*await\s+[\w$]+\s*\(/g)].map(m => m[1]!));
    const offsets = [0];
    const scopes = [{ start: -1, end: code.length, parent: -1 }];
    const stack = [0];
    for (let i = 0; i < code.length; i++) {
      if (code[i] === '\n') offsets.push(i + 1);
      if (code[i] === '{') {
        scopes.push({ start: i, end: code.length, parent: stack[stack.length - 1]! });
        stack.push(scopes.length - 1);
      } else if (code[i] === '}' && stack.length > 1) scopes[stack.pop()!]!.end = i;
    }
    const declarations = new Map<string, { index: number; length: number }[]>();
    for (const m of code.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*/g)) {
      if (!names.has(m[1]!)) continue;
      const entries = declarations.get(m[1]!) ?? [];
      entries.push({ index: m.index!, length: m[0].length });
      declarations.set(m[1]!, entries);
    }
    Object.assign(file, { code, ready: true, names, offsets, scopes, declarations });
    if (!names.has(receiverName)) return null;
  }
  let memo = AWAITED_TYPE_MEMO.get(context);
  if (!memo) { memo = new Map(); AWAITED_TYPE_MEMO.set(context, memo); }
  const key = `${ref.filePath}|${ref.line}|${ref.column}|${receiverName}`;
  if (memo.has(key)) return memo.get(key)!;
  const result = resolveAwaitedCallType(receiverName, file, ref, context);
  if (memo.size >= PATTERN_MEMO_CAP) memo.delete(memo.keys().next().value!);
  memo.set(key, result);
  return result;
}

function resolveAwaitedCallType(
  receiverName: string,
  file: AwaitedFile,
  ref: UnresolvedRef,
  context: ResolutionContext,
): AwaitedType | null {
  const unknown: AwaitedType = { name: null, filePath: ref.filePath };
  const end = (file.offsets[ref.line - 1] ?? file.code.length) + ref.column;
  const code = file.code.slice(0, end);
  const escaped = receiverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Locate scopes in the precomputed brace tree. Rescanning the entire file
  // for every candidate binding made large test files quadratic in refs.
  const scopeAt = (offset: number): number => {
    let lo = 0, hi = file.scopes.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (file.scopes[mid]!.start < offset) lo = mid; else hi = mid;
    }
    while (lo > 0 && file.scopes[lo]!.end < offset) lo = file.scopes[lo]!.parent;
    return lo;
  };
  const visibleAt = (declaration: number, use: number): boolean => {
    const ancestor = scopeAt(declaration);
    for (let scope = scopeAt(use); scope >= 0; scope = file.scopes[scope]!.parent) if (scope === ancestor) return true;
    return false;
  };
  const binding = [...(file.declarations.get(receiverName) ?? [])].reverse()
    .find(m => m.index < end && visibleAt(m.index, end));
  if (!binding) return null;
  const init = code.slice(binding.index + binding.length);
  if (!/^await\b/.test(init)) return null;
  // Only a bare call result, not a following member/index/conditional expression.
  const call = /^await\s+([A-Za-z_$][\w$]*)\s*\(/.exec(init);
  if (!call) return null;
  let depth = 1, callEnd = call[0].length;
  for (; callEnd < init.length && depth; callEnd++) {
    if (init[callEnd] === '(') depth++;
    else if (init[callEnd] === ')') depth--;
  }
  if (depth) return unknown;
  const tail = init.slice(callEnd);
  // A following property/index/call is not the callee's annotated value.
  if (!/^[ \t]*(?:;|\r?\n(?![ \t]*[.(\[?]))/.test(tail)) return unknown;
  const rest = tail;
  if (new RegExp(`\\b(?:const|let|var|function|class)\\s+(?:${escaped}\\b|\\{[^}]*\\b${escaped}\\b)`).test(rest) ||
      new RegExp(`\\b${escaped}\\s*=(?!=)`).test(rest) || hasParameterBinding(rest, escaped)) return unknown;

  const bindingLine = file.code.slice(0, binding.index!).split('\n').length;
  const bindingRef = { ...ref, line: bindingLine, column: binding.index! - file.offsets[bindingLine - 1]! };
  const callee = call[1]!;
  const calleeEscaped = callee.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (context.getNodesInFile(ref.filePath).some(n =>
    (n.kind === 'function' || n.kind === 'method') && n.startLine <= bindingLine && n.endLine >= bindingLine &&
    n.signature && hasParameterBinding(`${n.signature} {`, calleeEscaped))) return unknown;

  const imported = context.getImportMappings(ref.filePath, ref.language).some(m => m.localName === callee);
  let declaring: Node | undefined;
  if (imported) {
    if (importShadowedAt(callee, bindingRef, context)) return unknown;
    const resolved = context.resolveImport?.({ ...bindingRef, referenceName: callee, referenceKind: 'calls' });
    declaring = resolved ? context.getNodeById?.(resolved.targetNodeId) ?? undefined : undefined;
  } else {
    const local = context.getNodesByName(callee).filter(n => n.kind === 'function' &&
      n.filePath === ref.filePath && ESM_FAMILY.has(n.language) && isLexicallyReachable(n, bindingRef, context));
    if (local.length === 1) declaring = local[0];
  }
  if (!declaring || declaring.kind !== 'function' || !declaring.signature) return unknown;
  if (!imported) {
    const beforeBinding = code.slice(0, binding.index!);
    const shadows = new RegExp(`\\b(?:const|let|var)\\s+${calleeEscaped}\\b`, 'g');
    for (const shadow of beforeBinding.matchAll(shadows)) {
      if (!visibleAt(shadow.index!, binding.index)) continue;
      // A typed arrow function may itself be the declared local factory.
      const line = file.code.slice(0, shadow.index!).split('\n').length;
      if (line !== declaring.startLine || shadow.index! - file.offsets[line - 1]! > declaring.startColumn) return unknown;
    }
  }
  const signature = declaring.signature;
  const annotation = signature.slice(signature.lastIndexOf(')') + 1).match(/^\s*:\s*([\s\S]+)$/)?.[1]?.trim();
  if (!annotation) return unknown;
  // Do not turn unions, arrays, object/function types, or conditional types into
  // a project class. Await recursively unwraps promises, but this narrow path
  // accepts a single named Promise<T> layer only.
  const returned = annotation.match(/^Promise\s*<\s*([\w$]+)\s*>$/)?.[1] ?? annotation;
  if (!/^[A-Za-z_$][\w$]*$/.test(returned)) return unknown;
  if (TS_PRIMITIVE_TYPES.has(returned)) return { name: returned, filePath: declaring.filePath };

  const typeRef = { ...bindingRef, fromNodeId: declaring.id, filePath: declaring.filePath,
    language: declaring.language, line: declaring.startLine, column: declaring.startColumn,
    referenceName: returned, referenceKind: 'references' as const };
  const typeImport = context.getImportMappings(declaring.filePath, declaring.language).some(m => m.localName === returned);
  const resolved = typeImport ? context.resolveImport?.(typeRef) : null;
  const typeNode = resolved ? context.getNodeById?.(resolved.targetNodeId) :
    context.getNodesByName(returned).find(n => n.filePath === declaring.filePath &&
      ESM_FAMILY.has(n.language) && (n.kind === 'class' || n.kind === 'interface'));
  if (!typeNode || (typeNode.kind !== 'class' && typeNode.kind !== 'interface')) return unknown;
  return { name: typeNode.name, filePath: typeNode.filePath };
}

/**
 * Patterns that recover a PHP class property's declared type for a
 * `$this->prop` receiver. Deliberately NOT localReceiverTypePatterns: only
 * property-shaped declarations qualify —
 *   1. a modifier-prefixed typed declaration, which covers both a typed
 *      property (`private ?Foo $prop;`) and a promoted constructor parameter
 *      (`private readonly Foo $prop`), and
 *   2. the pseudoconstructor assignment (`$this->prop = new Foo(...)`).
 * A bare `X $prop` parameter or `$prop = new X()` local elsewhere in the
 * file must NOT match: those variables can never alias `$this->prop`.
 * Union-typed properties (`Foo|Bar $prop`) yield no match and thus no edge —
 * silent beats wrong. The classic untyped-property-assigned-in-constructor
 * shape is handled by inferPhpAssignedPropertyType instead.
 */
function phpPropertyTypePatterns(r: string): RegExp[] {
  return memoPatterns(`php-prop|${r}`, () => buildPhpPropertyTypePatterns(r));
}

function buildPhpPropertyTypePatterns(r: string): RegExp[] {
  return [
    new RegExp(
      `\\b(?:(?:private|protected|public|readonly|static|final)(?:\\(set\\))?\\s+)+\\??([A-Za-z_\\\\][\\w\\\\]*)\\s+&?\\$${r}\\b`,
    ), // private readonly ?Foo $prop  (typed property / promoted param)
    new RegExp(`\\$this->${r}\\b\\s*=\\s*new\\s+([A-Za-z_\\\\][\\w\\\\]*)`), // $this->prop = new Foo()
  ];
}

/**
 * Second-chance typing for a PHP `$this->prop` receiver whose property
 * declaration carries no static type (classic pre-7.4 style): find the
 * `$this->prop = $var` assignment, then recover `$var`'s type from its own
 * declaration WITHIN the assignment's function — the constructor's (possibly
 * multi-line) parameter list, a typed setter's parameter, or a `= new X()`
 * local. The backward scan stops at the enclosing `function` line (checked
 * for a match first — a single-line `__construct(Foo $var) { ... }` carries
 * the typed parameter itself), so a same-named variable in another method
 * can never type the property.
 */
function inferPhpAssignedPropertyType(
  escapedProp: string,
  lines: string[],
  callIdx: number,
): string | null {
  const assignRe = new RegExp(`\\$this->${escapedProp}\\b\\s*=\\s*\\$(\\w+)\\b`);
  const assignAt = (i: number): RegExpMatchArray | null => {
    const line = lines[i];
    if (!line || line.length > 10_000) return null;
    return line.match(assignRe);
  };
  // The assignment is position-independent relative to the call — nearest-
  // backward first, then sweep forward, same order as the componentScoped scan.
  let assignIdx = -1;
  let varName: string | null = null;
  for (let i = callIdx; i >= 0; i--) {
    const m = assignAt(i);
    if (m) { assignIdx = i; varName = m[1]!; break; }
  }
  if (varName === null) {
    for (let i = callIdx + 1; i < lines.length; i++) {
      const m = assignAt(i);
      if (m) { assignIdx = i; varName = m[1]!; break; }
    }
  }
  if (varName === null) return null;

  const varPatterns = localReceiverTypePatterns(
    'php',
    varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  for (let i = assignIdx; i >= 0; i--) {
    const line = lines[i];
    if (line && line.length <= 10_000) {
      for (const re of varPatterns) {
        const m = line.match(re);
        if (m && m[1]) {
          const type = normalizeInferredTypeName(m[1]);
          if (type) return type;
        }
      }
    }
    if (line && /\bfunction\b/.test(line)) break;
  }
  return null;
}

/**
 * Try to resolve by method name on a class/object
 */
export function matchMethodCall(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Parse method call patterns like "obj.method" or "Class::method". The method
  // part allows trailing `:` keywords so Objective-C selectors resolve
  // (`SDImageCache.storeImage:`, `obj.setX:y:`); colons never appear in other
  // languages' method refs, so this is a no-op for them.
  // The receiver allows dots (`builder.Services.AddCoreServices`) so a CHAINED
  // call resolves by its last segment — Strategy 3 below name-matches the method
  // (with its existing single-candidate / receiver-overlap guards). Without this
  // a multi-dot extension-method call (C# DI `builder.Services.AddCoreServices()`,
  // `Guard.Against.X()`) matched no pattern and never resolved.
  // C++ explicit operator call `a.operator+(b)` reaches the resolver as
  // `a.operator+` (#1247) — the operator's symbol chars (`+`, `==`, `[]`, `()`)
  // fail the \w method part of the plain pattern, so admit them explicitly.
  // Names like `operatorTable` stay on the plain pattern (tried first); the
  // operator form requires at least one non-word char after `operator`, and
  // every downstream strategy compares the method part by exact string
  // equality, so a stray match can't invent an edge.
  const dotMatch =
    ref.referenceName.match(/^([\w.]+)\.(\w+:?(?:\w+:)*)$/) ??
    (ref.language === 'cpp'
      ? ref.referenceName.match(/^([\w.]+)\.(operator[^\w\s.]+)$/)
      : null);
  const colonMatch = ref.referenceName.match(/^(\w+)::(\w+)$/);
  // Lua/Luau method calls use a single colon (`lg:log`); R uses `$` (`lg$log`).
  // Recognize these receiver/method separators so local-variable receiver-type
  // inference (#1108) applies to them too — extraction already emits the ref in
  // this shape, but the resolver otherwise only understood `.` and `::`.
  const luaColonMatch = (ref.language === 'lua' || ref.language === 'luau')
    ? ref.referenceName.match(/^([\w.]+):(\w+)$/)
    : null;
  const rDollarMatch = ref.language === 'r'
    ? ref.referenceName.match(/^([\w.]+)\$(\w+)$/)
    : null;

  // PHP property receiver: `$this->prop->method()` reaches the resolver as
  // `this->prop.method` (the extractor records the receiver's raw text with the
  // leading `$` stripped). Resolve it EXCLUSIVELY through declared-type
  // inference + resolveMethodOnType validation — the name-similarity strategies
  // below must never see this shape, so a property whose type can't be
  // recovered stays unlinked rather than guessed (a wrong inference produces no
  // edge rather than a wrong one). Deeper chains (`this->a->b.method`) don't
  // match the single-property pattern and stay unlinked, same as before.
  const phpThisPropMatch = ref.language === 'php'
    ? ref.referenceName.match(/^(this->\w+)\.(\w+)$/)
    : null;
  if (phpThisPropMatch) {
    const [, receiver, phpMethodName] = phpThisPropMatch;
    const inferredType = inferLocalReceiverType(receiver!, ref, context);
    if (!inferredType) return null;
    return resolveMethodOnType(
      inferredType,
      phpMethodName!,
      ref,
      context,
      0.9,
      'instance-method',
      importedFqnOf(inferredType, ref, context),
    );
  }

  // A TS/JS call through an ES private field of the enclosing class —
  // `this.#items.add()`, emitted as `this.#items.add` (#1987) — resolves
  // exactly like `this.<field>` below (#1496). `#` is outside dotMatch's
  // receiver class, so the shape is matched here.
  if (ref.language === 'typescript' || ref.language === 'javascript' || ref.language === 'tsx' || ref.language === 'jsx') {
    const privateField = ref.referenceName.match(/^this\.(#[\w$]+)\.(\w+)$/);
    if (privateField) return matchTsThisFieldCall(privateField[1]!, privateField[2]!, ref, context);
  }

  const match = dotMatch || colonMatch || luaColonMatch || rDollarMatch;
  if (!match) {
    return null;
  }

  const [, objectOrClass, methodName] = match;
  // A simple `receiver.method` / `receiver:method` / `receiver$method` shape whose
  // receiver type we can try to infer from its local declaration.
  const inferableReceiver = dotMatch || luaColonMatch || rDollarMatch;

  // Infer the receiver's type from its local declaration/initializer in the
  // enclosing scope, then resolve the method on that type (#1108). C++ keeps its
  // dedicated inferrer (header scan + `auto`); every other language uses the
  // shared source-based inferrer. resolveMethodOnType validates the method
  // exists on the inferred type, so a mis-inference produces no edge.
  if (inferableReceiver) {
    let inferredType = nmTimedT('mc-infer', ref, () =>
      ref.language === 'cpp'
        ? inferCppReceiverType(objectOrClass!, ref, context)
        : inferLocalReceiverType(objectOrClass!, ref, context));
    const awaited = !inferredType && ESM_FAMILY.has(ref.language)
      ? inferEsmAwaitedCallType(objectOrClass!, ref, context) : null;
    if (awaited) {
      if (!awaited.name || TS_PRIMITIVE_TYPES.has(awaited.name)) return null;
      inferredType = awaited.name;
    }
    if (inferredType) {
      // Java/Kotlin: when two classes share the simple name, the file's import
      // pins WHICH one (#314). Other languages disambiguate by call-site file.
      const importedFqn =
        ref.language === 'java' || ref.language === 'kotlin'
          ? context
              .getImportMappings(ref.filePath, ref.language)
              .find((i) => i.localName === inferredType)?.source
          : undefined;
      const typedMatch = nmTimedT('mc-rmot', ref, () => resolveMethodOnType(
        inferredType,
        methodName!,
        awaited ? { ...ref, filePath: awaited.filePath } : ref,
        context,
        0.9,
        'instance-method',
        importedFqn,
      ));
      if (typedMatch) {
        if (awaited) {
          const target = context.getNodeById?.(typedMatch.targetNodeId);
          if (!target || (target.qualifiedName.startsWith(`${inferredType}::`) && target.filePath !== awaited.filePath)) return null;
          return { ...typedMatch, original: ref };
        }
        return typedMatch;
      }
      if (awaited) return null;
      // A known JS/TS builtin receiver is external when it has no project
      // method (#1566). Inference already strips generics (`Map<K, V>` →
      // `Map`); do not let Strategy 3 guess an unrelated `get`/`set`/`has`.
      // Keep the validated match above for a project type shadowing a builtin.
      // A primitive receiver joins the builtins here: `listed.split()` on a
      // `string` is the built-in method, and Strategy 3 would otherwise hand
      // it whichever project class happens to declare a lone `split` (#1840).
      if (
        ESM_FAMILY.has(ref.language) &&
        (JS_BUILT_INS.has(inferredType) || TS_PRIMITIVE_TYPES.has(inferredType))
      ) {
        return null;
      }
    }
  }

  // Go 2-hop field chain `base.field.Method` (#1276): the base's type comes
  // from the enclosing scope (typed parameter / method receiver / local var),
  // the field's declared type from that struct's own declaration lines, and
  // the method is VALIDATED on the field's type by resolveMethodOnType. This
  // branch is EXCLUSIVE for chained Go receivers: when the hop can't be
  // inferred or the field's type is external (`conn *sql.DB` — no project
  // node), the ref stays unresolved rather than falling through to the
  // bare-name strategies below, which is exactly how `target.conn.Exec(...)`
  // fabricated a dependency on an unrelated local interface's same-named
  // method. Chained Go receivers were never emitted before #1276, so there
  // is no prior recall to preserve on the fallback path.
  if (ref.language === 'go' && dotMatch && objectOrClass!.includes('.')) {
    return matchGoFieldChainCall(objectOrClass!, methodName!, ref, context);
  }

  // Rust call through a field of the enclosing type — `self.inner.run()`,
  // emitted as `self.inner.run` (#1585). Same discipline as the Go branch
  // above, and EXCLUSIVE for the same reason: validated field-type inference
  // or nothing. Letting this shape reach the bare-name strategies below is
  // how `self.inner.run()` resolved to a same-named method on an unrelated
  // type — or to the calling method itself, a self-edge the source doesn't
  // contain — whenever the field's type was external or merely shared a
  // method name with something nearby.
  if (ref.language === 'rust' && dotMatch && objectOrClass!.startsWith('self.')) {
    return matchRustSelfFieldCall(objectOrClass!.slice('self.'.length), methodName!, ref, context);
  }

  // Rust call on the enclosing type itself — `self.reset()`, emitted as
  // `self.reset` (#1861). Same discipline as the field branch above, and
  // EXCLUSIVE for the same reason: the owner is written on the `impl` line and
  // carried in the calling method's qualified name, so it is not a guess.
  // Letting this shape reach the bare-name strategies below is how
  // `self.reset()` resolved to a same-named method on an unrelated type
  // whenever that type's method happened to sit nearer the call site.
  if (ref.language === 'rust' && dotMatch && objectOrClass === 'self') {
    return matchRustSelfCall(methodName!, ref, context);
  }

  // TS/JS call through a field of the enclosing class — `this.mailer.send()`,
  // emitted as `this.mailer.send` (#1496). Same discipline as the Rust branch
  // above, and EXCLUSIVE for the same reason: the field's declared type off
  // the class's own declaration, validated by resolveMethodOnType, or nothing.
  // Letting the bare name through is how `this.mailer.send()` inside
  // `Notifier.send()` resolved to the calling method itself — a self-edge the
  // source does not contain — whenever the two shared a name.
  if (
    (ref.language === 'typescript' || ref.language === 'javascript' || ref.language === 'tsx' || ref.language === 'jsx') &&
    dotMatch &&
    objectOrClass!.startsWith('this.')
  ) {
    return matchTsThisFieldCall(objectOrClass!.slice('this.'.length), methodName!, ref, context);
  }

  // Java/Kotlin: receiver may be a field whose name doesn't match the type by
  // Java naming convention (`userbo` → class `UserBO`, abbreviated). Look up
  // the field in the enclosing class to get its declared type, then resolve
  // the method on that type. Covers Spring `@Resource`/`@Autowired` field
  // injection where the field type is the concrete bean class.
  if ((ref.language === 'java' || ref.language === 'kotlin') && dotMatch) {
    const inferredType = inferJavaFieldReceiverType(objectOrClass!, ref, context);
    if (inferredType) {
      // When two classes share the same simple name, the caller file's
      // import is the only signal that names WHICH one — pass the
      // imported FQN so resolveMethodOnType can disambiguate (#314).
      const imports = context.getImportMappings(ref.filePath, ref.language);
      const importedFqn = imports.find((i) => i.localName === inferredType)?.source;
      const typedMatch = nmTimedT('mc-rmot', ref, () => resolveMethodOnType(
        inferredType,
        methodName!,
        ref,
        context,
        0.9,
        'instance-method',
        importedFqn,
      ));
      if (typedMatch) {
        return typedMatch;
      }
    }
  }

  // Object-literal namespace receiver (#1573): `api.call()` where `api` is a
  // same-file `const api = { call() {…}, get: () => {…} }`. Its members are
  // plain functions with bare names inside the constant's extent — no
  // `Container::member` qualified name — so none of the class-shaped
  // strategies below can see them (Strategy 3 only considers `method`
  // kinds) and the call resolved to nothing at all. Same file only: a
  // cross-file use reaches the same helper through the import path.
  if (dotMatch && !objectOrClass!.includes('.') && OBJECT_LITERAL_LANGUAGES.has(ref.language)) {
    const literalMatch = nmTimedT('mc-literal', ref, (): ResolvedRef | null => {
      // Same-file holders only, so the call-site-first ordering is moot.
      const holders = context.getNodesByName(objectOrClass!).filter(
        (n) => (n.kind === 'constant' || n.kind === 'variable') && n.filePath === ref.filePath
      );
      for (const holder of holders) {
        const hit =
          resolveObjectLiteralMember(holder, methodName!, ref, context, 0.85, 'instance-method') ??
          resolveObjectLiteralBinding(holder, methodName!, ref, context);
        if (hit) return hit;
      }
      return null;
    });
    if (literalMatch) return literalMatch;
  }

  // Strategy 1: Direct class name match (existing logic). When the receiver
  // names a class that exists in several files (`Logger.log()` / `Logger::log()`
  // with a `Logger` in both `a/` and `b/`), try the class in the call site's
  // own file first — otherwise the first-indexed class wins and a call in `b/`
  // resolves to `a/`'s method (#1079).
  const strat1 = nmTimedT('mc-class', ref, (): ResolvedRef | null => {
    const classCandidates = preferCallSiteFile(
      context.getNodesByName(objectOrClass!).filter(isMethodOwnerKind),
      ref.filePath,
    );

    for (const classNode of classCandidates) {
      // Skip cross-language class matches
      if (classNode.language !== ref.language) continue;

      const nodesInFile = context.getNodesInFile(classNode.filePath);
      const methodNode = nodesInFile.find(
        (n) =>
          n.kind === 'method' &&
          n.name === methodName &&
          n.qualifiedName.includes(classNode.name)
      );

      if (methodNode) {
        return {
          original: ref,
          targetNodeId: methodNode.id,
          confidence: 0.85,
          resolvedBy: 'qualified-name',
        };
      }
    }
    return null;
  });
  if (strat1) return strat1;

  // Built-in method names need a validated receiver (#1987). Typed, imported,
  // object-literal and direct class receivers have had their chance above;
  // capitalization, word overlap or a unique method name are not evidence
  // that `list.map()` / `cache.get()` calls a project class.
  if (ref.referenceKind === 'calls' && JS_FAMILY.has(ref.language) &&
      objectOrClass !== 'this' && objectOrClass !== 'super' &&
      JS_BUILTIN_METHODS.has(methodName!)) return null;

  // A receiver the file imports is past guessing. A namespace import is the
  // module object, whose members are its exports, never some class's method;
  // a binding from a package outside the repository names nothing in it. The
  // import resolver placed what it could, and a method picked by name alone is
  // wrong: zod's `z.string()` (`import * as z from "zod/v4"`) bound 3,207 calls
  // to a test helper's `string` getter, trpc's `z.record()` another class's.
  if (ref.referenceKind === 'calls' && JS_FAMILY.has(ref.language) && isImportedModuleReceiver(objectOrClass!, ref, context)) {
    return null;
  }

  // Strategy 2: Instance variable receiver - try capitalized form to find class
  // e.g., "permissionEngine" → look for classes containing "PermissionEngine"
  const capitalizedReceiver = objectOrClass!.charAt(0).toUpperCase() + objectOrClass!.slice(1);
  if (capitalizedReceiver !== objectOrClass) {
    const strat2 = nmTimedT('mc-capital', ref, (): ResolvedRef | null => {
      const fuzzyClassCandidates = preferCallSiteFile(
        context.getNodesByName(capitalizedReceiver).filter(isMethodOwnerKind),
        ref.filePath,
      );
      for (const classNode of fuzzyClassCandidates) {
        // Skip cross-language class matches
        if (classNode.language !== ref.language) continue;

        const nodesInFile = context.getNodesInFile(classNode.filePath);
        const methodNode = nodesInFile.find(
          (n) =>
            n.kind === 'method' &&
            n.name === methodName &&
            n.qualifiedName.includes(classNode.name)
        );

        if (methodNode) {
          return {
            original: ref,
            targetNodeId: methodNode.id,
            confidence: 0.8,
            resolvedBy: 'instance-method',
          };
        }
      }
      return null;
    });
    if (strat2) return strat2;
  }

  // Strategy 3: Find methods by name across the codebase, match by receiver
  // name similarity with the containing class. Handles abbreviated variable
  // names like permissionEngine → PermissionRuleEngine.
  if (methodName) {
    const strat3 = nmTimedT('mc-byname', ref, (): ResolvedRef | null => {
    const methodCandidates = context.getNodesByName(methodName!);
    // Ubiquitous-method ceiling (#999): a method name re-declared across a
    // vendored theme/SDK (Metronic's `init`/`update`/… on every widget) yields
    // K candidates that receiver-word overlap can't reliably disambiguate —
    // and filtering + scoring all K per call is the O(K²) cost that wedged
    // "Resolving refs" for 15-28 min. Bail before the O(K) work; Strategy 1/2
    // (class-name match) already had their precise shot above.
    if (methodCandidates.length > AMBIGUOUS_NAME_CEILING) {
      return null;
    }
    const methods = methodCandidates.filter(
      (n) => n.kind === 'method' && n.name === methodName
    );

    // Filter to same-language candidates first
    const sameLanguageMethods = methods.filter(m => m.language === ref.language);
    const targetMethods = sameLanguageMethods.length > 0 ? sameLanguageMethods : methods;

    // If only one same-language method with this name exists, use it
    if (targetMethods.length === 1 && targetMethods[0]!.language === ref.language) {
      return {
        original: ref,
        targetNodeId: targetMethods[0]!.id,
        confidence: 0.7,
        resolvedBy: 'instance-method',
      };
    }

    // Multiple methods: score by receiver name word overlap with class name
    if (targetMethods.length > 1) {
      const receiverWords = splitCamelCase(objectOrClass!);
      let bestMatch: typeof targetMethods[0] | undefined;
      let bestScore = 0;

      // Same-file candidates first, so a score tie (`score > bestScore` keeps
      // the first seen) resolves to the call site's own file rather than the
      // first-indexed duplicate (#1079).
      for (const method of preferCallSiteFile(targetMethods, ref.filePath)) {
        const classWords = splitCamelCase(method.qualifiedName);
        let score = receiverWords.filter(w =>
          classWords.some(cw => cw.toLowerCase() === w.toLowerCase())
        ).length;
        // Bonus for same language
        if (method.language === ref.language) score += 1;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = method;
        }
      }

      if (bestMatch && bestScore >= 2) {
        return {
          original: ref,
          targetNodeId: bestMatch.id,
          confidence: 0.65,
          resolvedBy: 'instance-method',
        };
      }
    }
    return null;
    });
    if (strat3) return strat3;
  }

  return null;
}

/**
 * Is a member call's receiver (`z` in `z.string`, `ns` in `ns.util.fn`) an
 * import binding that is a module namespace, or one from outside the repo?
 */
function isImportedModuleReceiver(receiver: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const root = receiver.split('.')[0]!;
  const binding = context.getImportMappings?.(ref.filePath, ref.language)?.find((m) => m.localName === root);
  if (!binding) return false;
  return binding.isNamespace || context.isOutOfRepoImport?.(binding.source, ref.filePath, ref.language) === true;
}

/** Does the file bind `name` by importing it from outside the repository? */
function isOutOfRepoBinding(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const binding = context.getImportMappings?.(ref.filePath, ref.language)?.find((m) => m.localName === name);
  return !!binding && context.isOutOfRepoImport?.(binding.source, ref.filePath, ref.language) === true;
}

/** Go builtin/primitive field types that can never carry a project method. */
const GO_BUILTIN_FIELD_TYPES = new Set([
  'string', 'bool', 'byte', 'rune', 'error', 'any',
  'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'float32', 'float64', 'complex64', 'complex128',
  'chan', 'map', 'func', 'struct', 'interface',
]);

/**
 * Resolve a Go 2-hop field-chain call `base.field.Method(...)` (#1276):
 * `target.conn.Exec("insert")` where `func (target *Target) Write()` and
 * `type Target struct { conn *sql.DB }`. Two inference hops, both read from
 * source the same way #1108 does:
 *   1. `base`'s type from the enclosing scope (method receiver, typed
 *      parameter, or local declaration) via inferLocalReceiverType;
 *   2. `field`'s declared type from the struct's own declaration lines.
 * The method is then resolved AND VALIDATED on the field's type. A field
 * whose type has no project node (`sql.DB`, any external dependency) yields
 * null — the caller treats this branch as exclusive for chained Go
 * receivers, so the ref stays unresolved instead of name-guessing.
 */
function matchGoFieldChainCall(
  receiverChain: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const segs = receiverChain.split('.');
  if (segs.length !== 2 || !segs[0] || !segs[1]) return null;
  const [base, field] = segs;

  const baseType = inferLocalReceiverType(base!, ref, context);
  if (!baseType) return null;

  const fieldEsc = field!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fieldTypeRe = new RegExp(`\\b${fieldEsc}\\s+\\*?\\[?\\]?([A-Za-z_][\\w.]*)`);

  const structs = preferCallSiteFile(context.getNodesByName(baseType), ref.filePath).filter(
    (n) => (n.kind === 'struct' || n.kind === 'class') && n.language === 'go'
  );
  for (const s of structs) {
    const source = context.readFile(s.filePath);
    if (!source) continue;
    // Only the struct's own declaration lines — a same-named identifier
    // elsewhere in the file can't donate a type. Matched LINE BY LINE with
    // comments stripped: chi's `Mux` has a doc comment reading "the tree
    // router" right above `tree *node`, and a whole-block match captured
    // `router` from the prose instead of `node` from the field.
    const declLines = source.split('\n').slice(Math.max(0, s.startLine - 1), s.endLine);
    for (const rawLine of declLines) {
      const line = rawLine.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      const m = line.match(fieldTypeRe);
      if (!m || !m[1]) continue;
      const rawType = m[1];
      // A package-qualified field type (`http.Handler`, `sql.DB`) is only
      // followed when the package is IN-MODULE: stripping the qualifier and
      // matching the bare name would conflate a stdlib/third-party type with
      // any same-named project type — on chi, `handler http.Handler` bound
      // to an example app's unrelated local `Handler`. That is the exact
      // fabrication this matcher exists to prevent (#1276).
      if (rawType.includes('.')) {
        const pkg = rawType.split('.')[0]!;
        const mod = context.getGoModule?.();
        const imp = context
          .getImportMappings(s.filePath, 'go')
          .find((i) => i.localName === pkg);
        const inModule =
          !!mod &&
          !!imp &&
          (imp.source === mod.modulePath || imp.source.startsWith(mod.modulePath + '/'));
        if (!inModule) continue;
      }
      // Unexported (lowercase) types are idiomatic Go and stay eligible —
      // chi's `mx.tree.FindRoute()` chains through `tree *node`. A
      // mis-capture is harmless: resolveMethodOnType only returns a
      // validated `<type>::<method>` match.
      const fieldType = rawType.split('.').pop();
      if (!fieldType || !/^[A-Za-z_]/.test(fieldType) || GO_BUILTIN_FIELD_TYPES.has(fieldType)) continue;
      const resolved = resolveMethodOnType(fieldType, methodName, ref, context, 0.85, 'instance-method');
      if (resolved) return resolved;
    }
  }
  return null;
}

// Rust primitives and the prelude's own types: a field of one of these never
// names a project type, so a `self.<field>.<method>()` on it stays unresolved.
const RUST_NON_PROJECT_FIELD_TYPES = new Set([
  'bool', 'char', 'str', 'String',
  'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
  'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
  'f32', 'f64',
  'Self', 'self',
]);

/**
 * Reduce a Rust field's declared type text to the simple name of the type a
 * method call on that field auto-derefs to, or null when there is none we can
 * name. Only the layers Rust's method-call auto-deref looks through are
 * unwrapped: references (`&`, `&'a mut`) and the owning smart pointers
 * (`Box`, `Rc`, `Arc`) — `self.inner.run()` with `inner: Box<Inner>` calls
 * `Inner::run`. Containers that do NOT auto-deref to their parameter
 * (`Option<Inner>`, `Vec<Inner>`, `Mutex<Inner>`, `RefCell<Inner>`) keep their
 * own name and, having no project node, resolve to nothing — `self.items.push()`
 * must never become `Inner::push`. A trait object (`Box<dyn Source>`) yields
 * the trait, whose method node the interface-impl synthesizer fans out. A
 * generic parameter (`T`), a primitive, a tuple / array / raw pointer / fn
 * type, or a non-identifier yields null.
 */
export function rustFieldTypeName(raw: string): string | null {
  let t = raw.trim();
  for (;;) {
    const before = t;
    t = t.replace(/^&\s*(?:'\w+\s+)?(?:mut\s+)?/, '');
    t = t.replace(/^(?:Box|Rc|Arc)\s*<\s*/, '');
    t = t.replace(/^(?:dyn|impl)\s+/, '');
    if (t === before) break;
  }
  // Drop generic args, the closing `>`s of unwrapped pointers, and trait-object
  // bounds (`dyn Source + Send`); keep the last path segment.
  t = t.replace(/[<>+].*$/, '').trim();
  const seg = t.split('::').filter(Boolean).pop();
  if (!seg || !/^[A-Za-z_]\w*$/.test(seg)) return null;
  if (RUST_NON_PROJECT_FIELD_TYPES.has(seg)) return null;
  if (/^[A-Z]$/.test(seg)) return null; // bare single-letter generic parameter
  return seg;
}

/**
 * `self.method()` in Rust — the method on the type the call sits inside.
 *
 * The owner is the calling method's qualified-name prefix (`Target::run` →
 * `Target`), which is where the `impl` block's type ends up. A free function
 * has no `self`, so a caller whose qualified name carries no owner declines.
 * Exactly one candidate must belong to that owner: a project with two `impl`
 * blocks for the same type is normal, two same-named methods on it is not, and
 * guessing between them is the failure this replaces.
 */
function matchRustSelfCall(
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const caller = context.getNodeById?.(ref.fromNodeId);
  if (!caller?.qualifiedName) return null;
  const sep = caller.qualifiedName.lastIndexOf('::');
  if (sep <= 0) return null; // a free fn has no `self`
  const owner = caller.qualifiedName.slice(0, sep);

  let owned = context
    .getNodesByQualifiedName(`${owner}::${methodName}`)
    .filter(
      (n) =>
        n.kind === 'method' &&
        n.language === 'rust' &&
        n.qualifiedName === `${owner}::${methodName}`,
    );
  // Rust's extracted qualified names omit module paths. Two modules can
  // each declare `Target`; matching just `Target::reset` does not establish
  // ownership. In that case require a single owner declaration in the
  // caller's file and a method in that file. Otherwise leave it unresolved.
  // A unique owner still permits ordinary impl blocks split across files.
  const owners = context.getNodesByQualifiedName(owner).filter((n) =>
    n.language === 'rust' && ['struct', 'enum', 'union', 'trait', 'class'].includes(n.kind));
  if (owners.length > 1) {
    if (owners.filter((n) => n.filePath === caller.filePath).length !== 1) return null;
    owned = owned.filter((n) => n.filePath === caller.filePath);
  }
  if (owned.length !== 1) return null;

  return {
    original: ref,
    targetNodeId: owned[0]!.id,
    confidence: 0.9,
    resolvedBy: 'qualified-name',
  };
}

/**
 * Resolve a Rust call through a field of the enclosing type —
 * `self.inner.run()`, emitted by the extractor as `self.inner.run` (#1585).
 * Mirrors the Go 2-hop precedent above (#1276): the owner type is the calling
 * method's qualified-name prefix (`Outer::run` → `Outer`), the field's declared
 * type comes from the owner struct's OWN declaration lines, and the method is
 * resolved AND VALIDATED on that type by resolveMethodOnType. The caller
 * treats this branch as exclusive for `self.<field>` receivers: a field whose
 * type is external (`std::vec::IntoIter`, `regex::Regex`), a generic
 * parameter, or not declared where we can see it yields null and the ref stays
 * unresolved. Rust struct fields are not graph nodes, so the declaration text
 * is the only place the type lives.
 */
function matchRustSelfFieldCall(
  field: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  // The extractor only ever emits a single field hop; anything else is not ours.
  if (!field || field.includes('.')) return null;
  const caller = context.getNodeById?.(ref.fromNodeId);
  if (!caller) return null;
  const sep = caller.qualifiedName.lastIndexOf('::');
  if (sep <= 0) return null; // a free fn has no `self`
  const owner = caller.qualifiedName.slice(0, sep).split('::').pop();
  if (!owner) return null;

  const owners = preferCallSiteFile(context.getNodesByName(owner), ref.filePath).filter(
    (n) =>
      (n.kind === 'struct' || n.kind === 'union' || n.kind === 'class') &&
      n.language === 'rust'
  );
  const fieldEsc = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `pub inner: Inner,` / `inner: Box<dyn Source>,` / `pub(crate) inner: T }` —
  // the type text runs to the field separator. A comma inside generic args
  // (`HashMap<K, V>`) truncates the capture, which rustFieldTypeName then
  // reduces to the container's own name — exactly the non-deref case it
  // refuses anyway.
  const fieldRe = new RegExp(`\\b${fieldEsc}\\s*:\\s*([^,{}]+)`);
  for (const s of owners) {
    const source = context.readFile(s.filePath);
    if (!source) continue;
    // Only the struct's own declaration lines, comment-stripped line by line —
    // same discipline as the Go helper: prose or a same-named identifier
    // elsewhere in the file can never donate a type.
    const declLines = source.split('\n').slice(Math.max(0, s.startLine - 1), s.endLine);
    for (const rawLine of declLines) {
      const line = rawLine.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      const m = line.match(fieldRe);
      if (!m || !m[1]) continue;
      const fieldType = rustFieldTypeName(m[1]);
      // The field is declared here; whether or not its type names a project
      // symbol, this owner is the answer — no other same-named struct applies.
      if (!fieldType) return null;
      return resolveMethodOnType(fieldType, methodName, ref, context, 0.85, 'instance-method');
    }
  }
  return null;
}

/**
 * Per-context memo for matchTsThisFieldCall's declaration scan: `classId\0field`
 * → the first line of the class that declares the field (as `: typeof X`,
 * `: X`, or `= new X`, tried in that order per line) with its captured type,
 * or null. The scan depends only on the class and the field, but ran for every
 * `this.<field>.<method>()` call — re-splitting the file and compiling three
 * patterns each time, a third of all method-call matching on vscode. Derived
 * from file source: drops with clearNameMatcherMemos.
 */
const TS_FIELD_DECL_MEMO = new WeakMap<ResolutionContext, Map<string, { valueType: boolean; type: string } | null>>();
/** A class's comment-stripped lines, and which of them hold each `[\w$#]` token. */
interface TsClassDecl {
  lines: string[];
  /** Field lookups so far; the token index is built on the second. */
  lookups: number;
  linesByToken: Map<string, number[]> | null;
}
/** The last few classes' declarations — calls arrive file by file. */
const TS_CLASS_LINES = new WeakMap<ResolutionContext, Map<string, TsClassDecl | null>>();
const TS_CLASS_LINES_KEEP = 32;

function tsClassDecl(cls: Node, context: ResolutionContext): TsClassDecl | null {
  let cache = TS_CLASS_LINES.get(context);
  if (!cache) {
    cache = new Map();
    TS_CLASS_LINES.set(context, cache);
  }
  const hit = cache.get(cls.id);
  if (hit !== undefined) return hit;
  const source = context.readFile(cls.filePath);
  const decl = source
    ? {
        lines: source
          .split('\n')
          .slice(Math.max(0, cls.startLine - 1), cls.endLine)
          .map((rawLine) => rawLine.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')),
        lookups: 0,
        linesByToken: null,
      }
    : null;
  if (cache.size >= TS_CLASS_LINES_KEEP) cache.delete(cache.keys().next().value!);
  cache.set(cls.id, decl);
  return decl;
}

const TS_FIELD_TOKEN = /^[\w$#]+$/;
const TS_LINE_TOKEN = /[\w$#]+/g;
const TS_TOKEN_CHAR = /[\w$#]/;

/**
 * tsFieldPatterns with the field spelled `[\w$#]+`, tried sticky at a whole-
 * token occurrence of the field. There the run consumes exactly the field (a
 * shorter prefix cannot continue: every pattern needs `\s`, `?`, `!`, `:` or
 * `=` next), so each matches exactly where the field's own pattern would —
 * without compiling three patterns for every field of every class.
 */
const TS_FIELD_PATTERNS_AT: readonly TsFieldPattern[] = [
  { re: /(?<![\w$#])[\w$#]+\b\s*[?!]?\s*:\s*(?:readonly\s+)?typeof\s+([A-Za-z_$][\w.$]*)/y, valueType: true },
  { re: /(?<![\w$#])[\w$#]+\b\s*[?!]?\s*:\s*(?:readonly\s+)?([A-Za-z_$][\w.$]*)/y, valueType: false },
  { re: /(?<![\w$#])[\w$#]+\b\s*=\s*new\s+([A-Za-z_$][\w.$]*)/y, valueType: false },
];

/** The first declaration of `field` on one line, as `line.match` of its patterns in order would find it. */
function tsFieldOnLine(line: string, field: string): { valueType: boolean; type: string } | null {
  let at: number[] | null = null;
  for (let i = line.indexOf(field); i !== -1; i = line.indexOf(field, i + 1)) {
    const end = i + field.length;
    if ((i > 0 && TS_TOKEN_CHAR.test(line[i - 1]!)) || (end < line.length && TS_TOKEN_CHAR.test(line[end]!))) continue;
    (at ??= []).push(i);
  }
  if (!at) return null;
  for (const { re, valueType } of TS_FIELD_PATTERNS_AT) {
    for (const i of at) {
      re.lastIndex = i;
      const m = re.exec(line);
      if (m && m[1]) return { valueType, type: m[1] };
    }
  }
  return null;
}

/** Indices of the class lines holding `token` as a whole `[\w$#]` run, ascending. */
function tsClassLinesWithToken(decl: TsClassDecl, token: string): readonly number[] {
  if (!decl.linesByToken) {
    const index = new Map<string, number[]>();
    for (let i = 0; i < decl.lines.length; i++) {
      for (const m of decl.lines[i]!.matchAll(TS_LINE_TOKEN)) {
        const rows = index.get(m[0]);
        if (!rows) index.set(m[0], [i]);
        else if (rows[rows.length - 1] !== i) rows.push(i);
      }
    }
    decl.linesByToken = index;
  }
  return decl.linesByToken.get(token) ?? [];
}

type TsFieldPattern = { re: RegExp; valueType: boolean };
/** Compiled declaration patterns by field name — fields recur across classes. */
const TS_FIELD_PATTERNS = new Map<string, TsFieldPattern[]>();
const TS_FIELD_PATTERNS_CAP = 4096;

function tsFieldPatterns(field: string): TsFieldPattern[] {
  const hit = TS_FIELD_PATTERNS.get(field);
  if (hit) return hit;
  const fieldEsc = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A word boundary cannot open a private name; it also lets a public
  // `items` match `#items`. Keep the two field namespaces distinct (#1987).
  const fieldStart = '(?<![\\w$#])';
  const patterns: TsFieldPattern[] = [
    // `storage: typeof DraftHubStorage` — the type OF a value: an object
    // literal used as a namespace. Its members are bare-named functions inside
    // the constant's extent (#1573), so they are found by containment, not by
    // `Type::method`. Tried first: the declared-type pattern below would
    // otherwise capture the word `typeof`.
    {
      re: new RegExp(`${fieldStart}${fieldEsc}\\b\\s*[?!]?\\s*:\\s*(?:readonly\\s+)?typeof\\s+([A-Za-z_$][\\w.$]*)`),
      valueType: true,
    },
    // `private readonly mailer?: Mailer` — a class field or a constructor
    // parameter property; the capture stops at `<`, `[` or `|`, so a generic
    // or union type yields its head and resolveMethodOnType decides.
    {
      re: new RegExp(`${fieldStart}${fieldEsc}\\b\\s*[?!]?\\s*:\\s*(?:readonly\\s+)?([A-Za-z_$][\\w.$]*)`),
      valueType: false,
    },
    // `mailer = new Mailer()` / `this.mailer = new Mailer()`
    { re: new RegExp(`${fieldStart}${fieldEsc}\\b\\s*=\\s*new\\s+([A-Za-z_$][\\w.$]*)`), valueType: false },
  ];
  if (TS_FIELD_PATTERNS.size >= TS_FIELD_PATTERNS_CAP) TS_FIELD_PATTERNS.delete(TS_FIELD_PATTERNS.keys().next().value!);
  TS_FIELD_PATTERNS.set(field, patterns);
  return patterns;
}

function tsFieldDeclaration(
  cls: Node,
  field: string,
  context: ResolutionContext
): { valueType: boolean; type: string } | null {
  let memo = TS_FIELD_DECL_MEMO.get(context);
  if (!memo) {
    memo = new Map();
    TS_FIELD_DECL_MEMO.set(context, memo);
  }
  const key = cls.id + '\0' + field;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let found: { valueType: boolean; type: string } | null = null;
  const decl = tsClassDecl(cls, context);
  if (decl && TS_FIELD_TOKEN.test(field)) {
    // Every pattern needs the field as a whole `[\w$#]` run — the lookbehind
    // bars one before it, and nothing after it but `\s`, `?`, `!`, `:` or `=`
    // can continue a match — so only lines holding that token can match. A
    // class asked about several fields is indexed by token once.
    const rows = ++decl.lookups > 1 ? tsClassLinesWithToken(decl, field) : null;
    const count = rows ? rows.length : decl.lines.length;
    for (let k = 0; k < count && !found; k++) {
      const line = decl.lines[rows ? rows[k]! : k]!;
      // Every pattern spells the field literally, so only a line that contains
      // it can match — and most of a class's lines never mention a given field.
      if (line.includes(field)) found = tsFieldOnLine(line, field);
    }
  } else if (decl) {
    const patterns = tsFieldPatterns(field);
    scan: for (const line of decl.lines) {
      if (!line.includes(field)) continue;
      for (const { re, valueType } of patterns) {
        const m = line.match(re);
        if (!m || !m[1]) continue;
        found = { valueType, type: m[1] };
        break scan;
      }
    }
  }
  memo.set(key, found);
  return found;
}

/**
 * Resolve a TS/JS `this.<field>.<method>()` call (#1496) through the field's
 * declared type, read off the ENCLOSING class's own declaration lines:
 * a field or constructor-parameter property (`private mailer: Mailer`,
 * `mailer?: Mailer`, `readonly mailer: Mailer`) or an initializer
 * (`mailer = new Mailer()`, `this.mailer = new Mailer()`). The method is then
 * VALIDATED on that type by resolveMethodOnType. Null — never a bare-name
 * fallback — when the field is not declared there or its type is external,
 * a builtin (`this.items.push()`) or not spelled out.
 */
function matchTsThisFieldCall(
  field: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  if (!field || field.includes('.')) return null;
  const caller = context.getNodeById?.(ref.fromNodeId);
  if (!caller) return null;
  const sep = caller.qualifiedName.lastIndexOf('::');
  if (sep <= 0) return null; // not inside a class
  const owner = caller.qualifiedName.slice(0, sep).split('::').pop();
  if (!owner) return null;

  const owners = preferCallSiteFile(context.getNodesByName(owner), ref.filePath).filter(
    (n) => (n.kind === 'class' || n.kind === 'component') && sameLanguageFamily(n.language, ref.language)
  );
  for (const cls of owners) {
    const decl = tsFieldDeclaration(cls, field, context);
    if (!decl) continue;
    if (decl.valueType) {
      // The value's declaration may live in another file (it is imported);
      // the call site's file is preferred when several share the name.
      const holderName = decl.type.split('.').pop()!;
      const holders = preferCallSiteFile(context.getNodesByName(holderName), ref.filePath).filter(
        (n) => (n.kind === 'constant' || n.kind === 'variable') && sameLanguageFamily(n.language, ref.language)
      );
      for (const holder of holders) {
        const hit = resolveObjectLiteralMember(holder, methodName, ref, context, 0.85, 'instance-method');
        if (hit) return hit;
      }
      return null;
    }
    // `ns.Mailer` → `Mailer`; a primitive or builtin names no project type.
    const typeName = decl.type.split('.').pop()!;
    if (!/^[A-Z]/.test(typeName)) return null;
    // Two apps in one repo may each declare a `UserService`. The bare-name
    // path this replaces broke that tie by directory proximity, so keep the
    // same signal: among the type's declarations of the method, prefer the
    // one closest to the call site's directory (its own app), never index
    // order. resolveMethodOnType still answers the single-declaration and
    // supertype cases.
    const declared = context
      .getNodesByName(methodName)
      .filter(
        (n) =>
          n.kind === 'method' &&
          sameLanguageFamily(n.language, ref.language) &&
          (n.qualifiedName === `${typeName}::${methodName}` || n.qualifiedName.endsWith(`::${typeName}::${methodName}`))
      );
    if (declared.length > 1) {
      const callDirs = ref.filePath.split('/').slice(0, -1);
      const shared = (fp: string) => {
        const dirs = fp.split('/').slice(0, -1);
        let i = 0;
        while (i < dirs.length && i < callDirs.length && dirs[i] === callDirs[i]) i++;
        return i;
      };
      const nearest = [...declared].sort((a, b) => shared(b.filePath) - shared(a.filePath) || a.filePath.localeCompare(b.filePath))[0]!;
      return { original: ref, targetNodeId: nearest.id, confidence: 0.85, resolvedBy: 'instance-method' };
    }
    return resolveMethodOnType(typeName, methodName, ref, context, 0.85, 'instance-method');
  }
  return null;
}

/**
 * The one fallback a TS/JS/Python call-receiver chain keeps (#1683): a STORE
 * ACCESSOR. Zustand's `get()` inside the store factory and
 * `useStore.getState()` outside it hand back the store whose actions are
 * indexed as functions (#1573). JS/TS resolves the member within that store;
 * the existing Python fallback still requires a unique callable. Nothing else
 * qualifies: a chain rooted in a project value still says nothing about what
 * the inner call RETURNS — `db.prepare(sql).all()` would bind to any project
 * function named `all` — so it resolves to nothing, exactly like a chain
 * rooted in a parameter (`d.setdefault(k, []).append(v)`).
 */
function matchStoreAccessorChain(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const m = ref.referenceName.match(/^([\w$.]+)\(\)\.(\w+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const inner = m[1];
  const method = m[2];
  if (!(inner === 'get' || inner === 'getState' || inner.endsWith('.getState'))) return null;
  if (JS_FAMILY.has(ref.language)) {
    return resolveStoreAction(inner, method, ref, context);
  }
  const callables = context
    .getNodesByName(method)
    .filter((n) => (n.kind === 'function' || n.kind === 'method') && sameLanguageFamily(n.language, ref.language) && n.id !== ref.fromNodeId);
  if (callables.length !== 1) return null;
  return { original: ref, targetNodeId: callables[0]!.id, confidence: 0.6, resolvedBy: 'exact-match' };
}

/** Resolve the implementation inside the identified store, not a namesake or
 * an interface signature elsewhere in the project. Import resolution already
 * follows aliases/barrels; containment already excludes nested action locals. */
function resolveStoreAction(inner: string, member: string, ref: UnresolvedRef, context: ResolutionContext, selector = false): ResolvedRef | null {
  let holders: Node[];
  if (inner === 'get' || inner === 'getState') {
    const caller = context.getNodeById?.(ref.fromNodeId);
    if (!caller) return null;
    holders = context.getNodesInFile(ref.filePath).filter((n) => {
      if ((n.kind !== 'constant' && n.kind !== 'variable') || !rangeWithin(caller, n)) return false;
      const source = context.readFile(n.filePath)?.split('\n').slice(n.startLine - 1, caller.startLine).join('\n') ?? '';
      // The accessor must actually be a parameter of the enclosing factory.
      return new RegExp(`\\(\\s*[\\w$]+\\s*,\\s*${inner}\\s*(?:,\\s*[\\w$]+\\s*)?\\)\\s*=>`).test(source);
    });
  } else {
    const name = inner.slice(0, -'.getState'.length);
    if (!/^[\w$]+$/.test(name)) return null;
    const imported = context.resolveImport?.({ ...ref, referenceName: name, referenceKind: 'references' });
    const node = imported && context.getNodeById?.(imported.targetNodeId);
    if (node && importShadowedAt(name, ref, context)) return null;
    holders = node ? [node] : context.getNodesByName(name).filter((n) =>
      n.filePath === ref.filePath && isLexicallyReachable(n, ref, context));
  }
  if (holders.length !== 1) return null;
  const holder = holders[0]!;
  if (selector) {
    // Only a Zustand hook promises to return the selector's result. An
    // arbitrary function accepting that callback is not a store binding.
    const text = context.readFile(holder.filePath)?.split('\n').slice(holder.startLine - 1, holder.endLine).join('\n') ?? '';
    const escaped = holder.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const factory = new RegExp(`\\b(?:const|let)\\s+${escaped}\\s*=\\s*([\\w$]+)\\s*[<(]`).exec(text)?.[1];
    if (!factory || !context.getImportMappings(holder.filePath, holder.language).some(m =>
      m.localName === factory && m.source === 'zustand' && (m.exportedName === 'create' || m.isDefault))) return null;
  }
  return resolveObjectLiteralMember(holder, member, ref, context, 0.9, 'instance-method');
}

// Eligibility is a file property, not a call-site property. Cache both answers
// within the same stable-source window as the resolver's file cache; sync drops
// it via clearNameMatcherMemos. Keep only booleans, FIFO-capped like PATTERN_MEMO
// to avoid per-hit LRU churn. Eviction merely repeats the source scan.
const GET_STATE_FILES = new WeakMap<ResolutionContext, Map<string, boolean>>();
const GET_STATE_FILES_CAP = 8192;

/** A const destructuring is a bound reference, so it is eligible even though
 * arbitrary locally-bound bare calls must never guess a cross-file target. */
function matchDestructuredStoreCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  let files = GET_STATE_FILES.get(context);
  if (!files) { files = new Map(); GET_STATE_FILES.set(context, files); }
  let eligible = files.get(ref.filePath);
  let source: string | null | undefined;
  if (eligible === undefined) {
    source = context.readFile(ref.filePath);
    eligible = source?.includes('.getState') ?? false;
    if (files.size >= GET_STATE_FILES_CAP) {
      const oldest = files.keys().next().value;
      if (oldest !== undefined) files.delete(oldest);
    }
    files.set(ref.filePath, eligible);
  }
  if (!eligible) return null;
  source ??= context.readFile(ref.filePath);
  if (!source) return null;
  const lines = source.split('\n');
  const start = enclosingScopeStartLine(ref, context) - 1;
  const before = lines.slice(start, ref.line - 1).concat(lines[ref.line - 1]!.slice(0, ref.column)).join('\n');
  const code = blankStringContents(stripCommentsForRegex(before, 'typescript'));
  const name = ref.referenceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const binding = /\bconst\s*\{([^{}]*)\}\s*=\s*([\w$]+)\.getState\s*\(\s*\)/g;
  // Compare block identities, not just nesting depth: a binding in a sibling
  // or already-closed block is not in scope at this call.
  const stackAt = (end: number): number[] => {
    const stack: number[] = [];
    for (let i = 0; i < end; i++) {
      if (code[i] === '{') stack.push(i);
      else if (code[i] === '}') stack.pop();
    }
    return stack;
  };
  const callScope = stackAt(code.length);
  for (const m of [...code.matchAll(binding)].reverse()) {
    // Plain named bindings only; defaults, rest and computed keys need their
    // own value tracing rather than a same-name guess.
    if (!m[1]!.split(',').some(part => part.trim() === ref.referenceName)) continue;
    const scope = stackAt(m.index!);
    if (!scope.every((pos, i) => callScope[i] === pos)) continue;
    const rest = code.slice(m.index! + m[0].length);
    // Keep the guard when another declaration shadows the captured const.
    if (new RegExp(`\\b(?:const|let|var|function|class)\\s+(?:${name}\\b|\\{[^}]*\\b${name}\\b)`).test(rest)) return null;
    return resolveStoreAction(`${m[2]}.getState`, ref.referenceName, ref, context);
  }
  return null;
}

/** Bound action names need not have a same-named definition (selectors may
 * rename them). The resolver's symbol-existence prefilter must allow them. */
export function matchJsStoreBindingCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (!isBareJsCall(ref, context)) return null;
  return matchDestructuredStoreCall(ref, context) ?? matchSelectedStoreCall(ref, context);
}

/** A qualified untyped chain is useful source evidence, not permission to
 * infer a property type. Framework resolution runs before this guard. */
export function isUnresolvedJsMemberCall(ref: UnresolvedRef): boolean {
  return ref.referenceKind === 'calls' && JS_FAMILY.has(ref.language) &&
    !/^(?:this|window)\./.test(ref.referenceName) &&
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){2,}$/.test(ref.referenceName);
}

const SELECTOR_NAMES = new WeakMap<ResolutionContext, Map<string, Set<string>>>();

/** A selector returns the named action from one identified store. Keep the
 * lexical block identity so closures may capture it but sibling scopes and
 * shadowing parameters/declarations cannot donate a binding. */
function matchSelectedStoreCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const source = context.readFile(ref.filePath);
  if (!source?.includes('=>')) return null;
  let files = SELECTOR_NAMES.get(context);
  if (!files) { files = new Map(); SELECTOR_NAMES.set(context, files); }
  let names = files.get(ref.filePath);
  if (!names) {
    names = new Set([...source.matchAll(/\bconst\s+([\w$]+)\s*=\s*[\w$]+\s*\(\s*(?:\(\s*[\w$]+\s*\)|[\w$]+)\s*=>/g)].map(m => m[1]!));
    files.set(ref.filePath, names);
  }
  if (!names.has(ref.referenceName)) return null;
  const name = ref.referenceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = source.split('\n');
  const before = lines.slice(0, ref.line - 1).concat(lines[ref.line - 1]!.slice(0, ref.column)).join('\n');
  const code = blankStringContents(stripCommentsForRegex(before, 'typescript'));
  const binding = new RegExp(`\\bconst\\s+${name}\\s*=\\s*([\\w$]+)\\s*\\(\\s*(?:\\(\\s*([\\w$]+)\\s*\\)|([\\w$]+))\\s*=>\\s*([\\w$]+)\\.([\\w$]+)\\s*\\)`, 'g');
  const stackAt = (end: number): number[] => {
    const stack: number[] = [];
    for (let i = 0; i < end; i++) {
      if (code[i] === '{') stack.push(i);
      else if (code[i] === '}') stack.pop();
    }
    return stack;
  };
  const callScope = stackAt(code.length);
  for (const m of [...code.matchAll(binding)].reverse()) {
    if ((m[2] ?? m[3]) !== m[4]) continue;
    if (!stackAt(m.index!).every((pos, i) => callScope[i] === pos)) continue;
    const rest = code.slice(m.index! + m[0].length);
    if (new RegExp(`\\b(?:const|let|var|function|class)\\s+(?:${name}\\b|\\{[^}]*\\b${name}\\b)`).test(rest) ||
        hasParameterBinding(rest, name)) return null;
    return resolveStoreAction(`${m[1]}.getState`, m[5]!, ref, context, true);
  }
  return null;
}

/** Import resolution names the module binding; a nearer parameter or block
 * declaration can shadow that binding at this particular call site. */
function importShadowedAt(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const fn of context.getNodesInFile(ref.filePath)) {
    if ((fn.kind === 'function' || fn.kind === 'method') && fn.startLine <= ref.line && fn.endLine >= ref.line &&
        fn.signature && hasParameterBinding(`${fn.signature} {`, escaped)) return true;
  }
  const lines = (context.readFile(ref.filePath) ?? '').split('\n');
  const before = lines.slice(0, ref.line - 1).concat(lines[ref.line - 1]?.slice(0, ref.column) ?? '').join('\n');
  const code = blankStringContents(stripCommentsForRegex(before, 'typescript'));
  const stackAt = (end: number): number[] => {
    const stack: number[] = [];
    for (let i = 0; i < end; i++) {
      if (code[i] === '{') stack.push(i);
      else if (code[i] === '}') stack.pop();
    }
    return stack;
  };
  const scope = stackAt(code.length);
  const declarations = new RegExp(`\\b(?:const|let|var|function|class)\\s+(?:${escaped}\\b|\\{[^}]*\\b${escaped}\\b)`, 'g');
  return [...code.matchAll(declarations)].some(m => stackAt(m.index!).every((p, i) => scope[i] === p));
}

/** Balanced parameter lists also cover function-typed parameters, whose own
 * parentheses must not make the outer shadow invisible. Conservative when a
 * parameter's type mentions the same name: leave that call unresolved. */
function hasParameterBinding(code: string, escapedName: string): boolean {
  const name = new RegExp(`\\b${escapedName}\\b`);
  if (new RegExp(`\\b${escapedName}\\s*=>`).test(code)) return true;
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '(' || /\b(?:if|while|for|switch|with)\s*$/.test(code.slice(0, i))) continue;
    let depth = 1, j = i + 1;
    for (; j < code.length && depth; j++) {
      if (code[j] === '(') depth++;
      else if (code[j] === ')') depth--;
    }
    if (depth === 0 && name.test(code.slice(i + 1, j - 1)) &&
        /^\s*(?::[^=;{]*)?(?:=>|\{)/.test(code.slice(j))) return true;
  }
  return false;
}

/**
 * Split a camelCase or PascalCase string into words.
 */
function splitCamelCase(str: string): string[] {
  return str.replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s._:\/\\]+/)
    .filter(w => w.length > 1);
}

/**
 * Compute directory proximity from a pre-split list of directory segments
 * (`filePath1` minus its filename) and a second file path.
 * Returns a score based on the number of shared leading directory segments.
 * Higher score = closer in directory tree.
 *
 * Split into a pre-split variant because findBestMatch scores every candidate
 * against the SAME `ref.filePath`; re-splitting it per candidate was a hot spot
 * on large repos (#915), so the caller splits it once and passes the segments.
 */
function pathProximityFromDirs(dir1: string[], filePath2: string): number {
  const dir2 = filePath2.split('/');
  dir2.pop(); // drop filename — matches the original slice(0, -1) on both paths

  let shared = 0;
  const limit = Math.min(dir1.length, dir2.length);
  for (let i = 0; i < limit; i++) {
    if (dir1[i] === dir2[i]) {
      shared++;
    } else {
      break;
    }
  }

  // Each shared directory segment contributes 15 points, capped at 80
  return Math.min(shared * 15, 80);
}

/**
 * Compute directory proximity between two file paths.
 * Returns a score based on the number of shared directory segments.
 */
function computePathProximity(filePath1: string, filePath2: string): number {
  const dir1 = filePath1.split('/');
  dir1.pop();
  return pathProximityFromDirs(dir1, filePath2);
}

/**
 * Find the best matching node when there are multiple candidates
 */
function findBestMatch(
  ref: UnresolvedRef,
  candidates: Node[],
  _context: ResolutionContext
): Node | null {
  // Prioritization rules:
  // 1. Same file > different file
  // 2. Directory proximity (same module/package > different module)
  // 3. Same language > different language
  // 4. Functions/methods > classes/types (for call references)
  // 5. Exported > non-exported

  let bestScore = -1;
  let bestNode: Node | null = null;

  // Split the ref's path once (it's the same across every candidate) instead of
  // re-splitting it inside computePathProximity per candidate (#915 hot spot).
  const refDirs = ref.filePath.split('/');
  refDirs.pop();

  // A same-language candidate ALWAYS outscores a cross-language one: same-language
  // scores at least +50 (language bonus), while a cross-language candidate maxes
  // out at +35 (−80 language, +80 proximity, +25 kind, +10 exported; it can never
  // be in the same file). So when any same-language candidate exists, skip the
  // cross-language ones — provably the same winner, without paying the per-candidate
  // scoring. Cuts the candidate set to same-language size on mixed front-end +
  // back-end repos (#915). When ALL candidates are cross-language (a legitimate
  // cross-language `calls` bridge), none are skipped and behavior is unchanged.
  const hasSameLanguage = candidates.some((c) => c.language === ref.language);

  for (const candidate of candidates) {
    if (hasSameLanguage && candidate.language !== ref.language) continue;

    let score = 0;

    // Same file bonus
    if (candidate.filePath === ref.filePath) {
      score += 100;
    }

    // Directory proximity bonus — strongly prefer same module/package
    score += pathProximityFromDirs(refDirs, candidate.filePath);

    // Language matching: strongly prefer same language, penalize cross-language
    if (candidate.language === ref.language) {
      score += 50;
    } else {
      score -= 80;
    }

    // For call references, prefer functions/methods
    if (ref.referenceKind === 'calls') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25;
      }
    }

    // For instantiation references (`new Foo()`), prefer class-like
    // targets — without this, a function named `Foo` in another module
    // could outscore the actual class.
    if (ref.referenceKind === 'instantiates') {
      if (
        candidate.kind === 'class' ||
        candidate.kind === 'struct' ||
        candidate.kind === 'union' ||
        candidate.kind === 'interface'
      ) {
        score += 25;
      }
    }

    // For decorator references (`@Foo`), prefer functions. Class
    // decorators (Python `@SomeClass`, Java annotation interfaces)
    // also resolve here, hence the smaller class bonus.
    if (ref.referenceKind === 'decorates') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25;
      } else if (candidate.kind === 'class' || candidate.kind === 'interface') {
        score += 15;
      }
    }

    // Exported bonus
    if (candidate.isExported) {
      score += 10;
    }

    // Closer line number (within same file)
    if (candidate.filePath === ref.filePath && candidate.startLine) {
      const distance = Math.abs(candidate.startLine - ref.line);
      score += Math.max(0, 20 - distance / 10);
    }

    if (score > bestScore) {
      bestScore = score;
      bestNode = candidate;
    }
  }

  return bestNode;
}

/**
 * Fuzzy match - last resort with lower confidence
 */
export function matchFuzzy(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const lowerName = ref.referenceName.toLowerCase();

  // Use pre-built lowercase index for O(1) lookup instead of scanning all nodes
  const candidates = context.getNodesByLowerName(lowerName);

  // Filter to callable kinds only (function, method, class)
  const callableKinds = new Set(['function', 'method', 'class']);
  const typeRef = isDotNetTypeRef(ref, context);
  const rustBare = ref.language === 'rust' && /^[A-Za-z_]\w*$/.test(ref.referenceName);
  const pythonShape = pythonCallShape(ref, context);
  // Rust and Python names are case-sensitive: `Bytes` is not the method `bytes`,
  // Python's builtin `dir(…)` not a class `Dir`.
  const callableCandidates = candidates.filter((n) => callableKinds.has(n.kind) && !(typeRef && !canNameInTypePosition(n)) &&
    !(rustBare && (n.name !== ref.referenceName || !isRustNameInScope(n, ref, context))) &&
    !(ref.language === 'python' && n.name !== ref.referenceName) &&
    !(pythonShape && !fitsPythonCallShape(n, pythonShape, ref, context)))
    .filter((n) => (ref.referenceKind !== 'references' && ref.referenceKind !== 'function_ref') ||
      sameLanguageFamily(n.language, ref.language));

  // Prefer same-language matches
  const sameLanguageCandidates = callableCandidates.filter(n => n.language === ref.language);
  const finalCandidates = sameLanguageCandidates.length > 0 ? sameLanguageCandidates : callableCandidates;

  // Both post-pipeline visibility guards (#1745 language-local + #1719 sealed
  // module). The sealed-module test rejects the survivor and never filters the
  // set that produced it: removing a sealed candidate from a crowd would leave
  // a lone one and manufacture a 0.5 guess out of an ambiguity fuzzy declines.
  // Also decline a bare JS/TS call whose only survivor is a method or a
  // cross-file name the file already binds locally (#1714).
  // A function nested inside another function is only callable from inside
  // its container (#1230), so a builtin method call (`res.text()`) whose only
  // same-named project symbol is some file's closure must decline (#1708).
  // The check sits on the ONE candidate this strategy would commit to, not on
  // the candidate set: filtering the unreachable ones out of a crowd would
  // leave a single survivor and hand it every call of that name — on vite,
  // `import { resolve } from 'node:path'` in a dozen playground configs onto
  // the one reachable `resolve` method (#1709). Reachability may reject a
  // unique guess; it must never manufacture one.
  if (
    finalCandidates.length === 1 &&
    isVisibleAcrossFiles(finalCandidates[0]!, ref, context) &&
    isCrossFileReachable(finalCandidates[0]!, ref, context) &&
    !(isBareJsCall(ref, context) &&
      (TYPE_MEMBER_KINDS.has(finalCandidates[0]!.kind) || isOutOfRepoBinding(ref.referenceName, ref, context) ||
        (finalCandidates[0]!.filePath !== ref.filePath && isLocallyBoundJsName(ref.referenceName, ref.filePath, context)))) &&
    !(finalCandidates[0]!.kind === 'method' && isBareGoCall(ref, context)) &&
    // A bare PHP call is a function call (case-insensitive, so fuzzy may find
    // one) — never the class `View` for `view(…)`, never a method.
    !(finalCandidates[0]!.kind !== 'function' && isBarePhpCall(ref, context)) &&
    isLexicallyReachable(finalCandidates[0]!, ref, context)
  ) {
    const isCrossLanguage = finalCandidates[0]!.language !== ref.language;
    return {
      original: ref,
      targetNodeId: finalCandidates[0]!.id,
      confidence: isCrossLanguage ? 0.3 : 0.5,
      resolvedBy: 'fuzzy',
    };
  }

  return null;
}

/**
 * Match all strategies in order of confidence
 */
/** ArkUI attribute-helper decorators a `.attr(...)` chain may resolve to. */
const ARKUI_ATTRIBUTE_DECORATORS = new Set(['Extend', 'Styles', 'AnimatableExtend', 'Builder']);

/**
 * CODEGRAPH_RESOLVE_PROFILE=2 sub-stage attribution for matchReference's
 * strategy pipeline (`nm:<stage>|<refKind>|hit/miss`). Module-global because
 * the matcher is a free function; each thread (main + every pool worker) has
 * its own module instance, and dumpNameMatcherProfile is invoked from
 * ReferenceResolver.dumpResolveProfile so worker tables surface too.
 */
const NM_PROFILE: Map<string, { n: number; ns: bigint }> | null =
  process.env.CODEGRAPH_RESOLVE_PROFILE === '2' ? new Map() : null;

function nmTimedT<T>(stage: string, ref: UnresolvedRef, fn: () => T): T {
  if (!NM_PROFILE) return fn();
  const t0 = process.hrtime.bigint();
  const r = fn();
  const dt = process.hrtime.bigint() - t0;
  const key = `nm:${stage}|${ref.referenceKind}|${r ? 'hit' : 'miss'}`;
  const slot = NM_PROFILE.get(key);
  if (slot) {
    slot.n++;
    slot.ns += dt;
  } else {
    NM_PROFILE.set(key, { n: 1, ns: dt });
  }
  return r;
}

function nmTimed(stage: string, ref: UnresolvedRef, fn: () => ResolvedRef | null): ResolvedRef | null {
  return nmTimedT(stage, ref, fn);
}

/** Dump this thread's matchReference sub-stage table to stderr (no-op unless =2). */
export function dumpNameMatcherProfile(label: string): void {
  if (!NM_PROFILE || NM_PROFILE.size === 0) return;
  const rows = [...NM_PROFILE.entries()]
    .map(([k, v]) => ({ k, n: v.n, ms: Number(v.ns / 1_000_000n) }))
    .sort((a, b) => b.ms - a.ms);
  for (const r of rows) {
    console.error(
      `[resolve-profile] ${label} ${r.k}: n=${r.n} total=${(r.ms / 1000).toFixed(1)}s avg=${((r.ms * 1000) / Math.max(1, r.n)).toFixed(0)}µs`
    );
  }
}

export function matchReference(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  return gateLanguageMatch(matchReferenceInner(ref, context), ref, context);
}

function matchReferenceInner(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Function-as-value refs (#756) resolve ONLY through the dedicated matcher —
  // never the fuzzy/qualified fallthrough below (a wrong callback edge is
  // worse than none).
  if (ref.referenceKind === 'function_ref') {
    return matchFunctionRef(ref, context);
  }

  // ArkTS chained UI attributes — emitted with a leading dot (`.titleStyle`,
  // `.width`) by the extractor — resolve ONLY to decorator-marked attribute
  // helpers: `@Extend`/`@Styles`/`@AnimatableExtend` functions (and global
  // `@Builder`s used attribute-position). Framework attributes (`.width`,
  // `.fontSize` — on nearly every UI line) match no such helper and stay
  // unresolved, NEVER falling through to bare-name matching: on a samples
  // monorepo that fallthrough manufactured 36k wrong edges, giving single
  // same-named properties thousands of false callers. Ambiguity rule matches
  // the rest of the file: several same-named helpers → prefer the call-site
  // file, still ambiguous → drop the ref rather than guess.
  if (ref.language === 'arkts' && ref.referenceName.startsWith('.')) {
    const base = ref.referenceName.slice(1);
    const candidates = context
      .getNodesByName(base)
      .filter(
        (n) =>
          n.language === 'arkts' &&
          n.kind === 'function' &&
          (n.decorators ?? []).some((d) => ARKUI_ATTRIBUTE_DECORATORS.has(d))
      );
    const chosen =
      candidates.length > 1 ? preferCallSiteFile(candidates, ref.filePath) : candidates;
    if (chosen.length !== 1) return null;
    return {
      original: ref,
      targetNodeId: chosen[0]!.id,
      confidence: 0.85,
      resolvedBy: 'exact-match',
    };
  }

  // Erlang `-behaviour(m)` refs target a MODULE. Letting them fall through to
  // bare-name matching grabs any same-named symbol — on emqx,
  // `-behaviour(supervisor)` resolved to a `-define(supervisor, …)` macro
  // constant in an unrelated app. Resolve only to the behaviour module's
  // namespace; an out-of-repo behaviour (OTP's gen_server/supervisor) stays
  // unresolved rather than guessed. The same module-only rule applies to every
  // ref an `.app`/`.app.src` resource file emits — its `{mod, …}` callback and
  // `{applications, …}` dependency names can only mean modules, and on emqx
  // the `ssl` OTP app otherwise resolved to a test helper FUNCTION named ssl.
  if (
    ref.language === 'erlang' &&
    (ref.referenceKind === 'implements' || /\.app(?:\.src)?$/i.test(ref.filePath))
  ) {
    const modules = context
      .getNodesByName(ref.referenceName)
      .filter((n) => n.language === 'erlang' && n.kind === 'namespace');
    const chosen = preferCallSiteFile(modules, ref.filePath)[0];
    if (!chosen) return null;
    return {
      original: ref,
      targetNodeId: chosen.id,
      confidence: 0.9,
      resolvedBy: 'exact-match',
    };
  }

  // Erlang call/fun refs carry the call-site arity (`f/1` — #1610) because
  // arity is part of the function's identity and every erlang function's
  // qualifiedName carries it (`mod::f/1`). Resolve ONLY to a definition of
  // that exact arity: the call site's own file first (a local call targets its
  // own module by language semantics; `-import`ed functions ride the
  // cross-file branch), and when no definition of that arity exists anywhere,
  // resolve to NOTHING rather than a sibling arity — the real target may be
  // macro-generated or out of repo, and a wrong-arity edge is worse than none.
  if (
    ref.language === 'erlang' &&
    !ref.referenceName.includes('::') &&
    (ref.referenceKind === 'calls' || ref.referenceKind === 'references')
  ) {
    const am = /^(.+)\/(\d{1,3})$/.exec(ref.referenceName);
    if (am) {
      // endsWith is length-anchored, so `/1` cannot match `…/11`.
      const arityTail = `/${am[2]}`;
      const candidates = context
        .getNodesByName(am[1]!)
        .filter(
          (n) =>
            n.language === 'erlang' && n.kind === 'function' && n.qualifiedName.endsWith(arityTail),
        );
      if (candidates.length > 0) {
        const sameFile = candidates.find((n) => n.filePath === ref.filePath);
        if (sameFile) {
          return { original: ref, targetNodeId: sameFile.id, confidence: 0.95, resolvedBy: 'exact-match' };
        }
        if (candidates.length === 1) {
          return { original: ref, targetNodeId: candidates[0]!.id, confidence: 0.8, resolvedBy: 'exact-match' };
        }
        const best = findBestMatch(ref, candidates, context);
        if (best) {
          const proximity = computePathProximity(ref.filePath, best.filePath);
          return {
            original: ref,
            targetNodeId: best.id,
            confidence: proximity >= 30 ? 0.7 : 0.4,
            resolvedBy: 'exact-match',
          };
        }
      }
      return null;
    }
  }

  if (isUnresolvedJsMemberCall(ref)) return null;

  // A Swift call through a type path (`API.PackageController.GetRoute.query`)
  // resolves on the type the path names, or not at all: the strategies below
  // would bind it by the member's name alone.
  if (ref.language === 'swift' && ref.referenceKind === 'calls' && SWIFT_TYPE_PATH_CALL.test(ref.referenceName)) {
    return nmTimed('swiftTypePath', ref, () => resolveSwiftTypePathCall(ref, context));
  }

  // Try strategies in order of confidence
  let result: ResolvedRef | null;

  // 0. File path match (e.g., "snippets/drawer-menu.liquid" → file node)
  result = nmTimed('filePath', ref, () => matchByFilePath(ref, context));
  if (result) return result;

  // 1. Qualified name match (highest confidence)
  result = nmTimed('qualifiedName', ref, () => matchByQualifiedName(ref, context));
  if (result) return result;

  // 1b. C++ chained call whose receiver is another call — `Foo::instance().bar()`
  // encoded as `Foo::instance().bar` by the extractor (#645). Resolve the
  // receiver's type from what the inner call returns, then the method on it.
  if (ref.language === 'cpp' || ref.language === 'c') {
    result = nmTimed('cppChain', ref, () => matchCppCallChain(ref, context));
    if (result) return result;
  }

  // 1c. `::`-scoped factory chain — PHP `Cls::for($x)->method()` (#608) or Rust
  // `Foo::new().bar()`, both encoded as `Cls::factory().method`. The receiver's
  // type is the factory's `self` (PHP `: self`/`: static`, Rust `-> Self`) or
  // concrete return type.
  if (ref.language === 'php' || ref.language === 'rust') {
    result = nmTimed('scopedChain', ref, () => matchScopedCallChain(ref, context));
    if (result) return result;
  }

  // 1d. Dotted chained static-factory / fluent call (Java / Kotlin / C# / Swift /
  // Go / Scala / Dart / Objective-C) — `Foo.getInstance().bar()` encoded as
  // `Foo.getInstance().bar`, Go's bare-factory `New().Method()` as `New().Method`,
  // Scala's companion factory, Dart's static factory / factory-constructor, or
  // ObjC's chained message send `[[Foo create] doIt]` encoded as `Foo.create().doIt`
  // (#645/#608 mechanism). Resolve the method's class from the inner call's
  // declared return type, then validate it.
  if (
    ref.language === 'java' ||
    ref.language === 'kotlin' ||
    ref.language === 'csharp' ||
    ref.language === 'swift' ||
    ref.language === 'go' ||
    ref.language === 'scala' ||
    ref.language === 'dart' ||
    ref.language === 'objc' ||
    ref.language === 'pascal'
  ) {
    result = nmTimed('dottedChain', ref, () => matchDottedCallChain(ref, context));
    if (result) return result;
  }

  // A call-receiver chain the extractor encoded as `<inner>().<method>` for a
  // language with no chain resolver above (TS/JS, Python — #1683) is a
  // receiver whose type is unknown. Nothing below may guess for it: the
  // method-call pattern rejects the parens, exact name never matches, but the
  // fuzzy strategy splits on `.` and would hand `make().run` to any `run` —
  // the fabricated edge the encoding exists to prevent.
  if (
    ref.referenceName.includes('().') &&
    (ref.language === 'typescript' || ref.language === 'javascript' || ref.language === 'tsx' || ref.language === 'jsx' || ref.language === 'python')
  ) {
    return nmTimed('storeAccessorChain', ref, () => matchStoreAccessorChain(ref, context));
  }

  // 2. Method call pattern
  result = nmTimed('methodCall', ref, () => matchMethodCall(ref, context));
  if (result) return result;

  // 3. Exact name match
  result = nmTimed('exactName', ref, () => matchByExactName(ref, context));
  if (result) return result;

  // 4. Fuzzy match (lowest confidence)
  result = nmTimed('fuzzy', ref, () => matchFuzzy(ref, context));
  if (result) return result;

  return null;
}
