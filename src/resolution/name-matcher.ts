/**
 * Name Matcher
 *
 * Handles symbol name matching for reference resolution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Language, Node } from '../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext, isSupertypeTarget, CPP_DEFINE_SIGNATURE, isInheritanceRef, isImportableKind } from './types';
import { blankStringContents, stripCommentsForRegex } from './strip-comments';
import { JS_BUILT_INS, JS_BUILTIN_METHODS, TS_PRIMITIVE_TYPES } from './js-builtins';
import { SWIFT_TYPE_PATH_CALL, resolveSwiftTypePathCall } from './swift-type-visibility';
import { isTestPath } from '../search/query-utils';
import { isMinifiedContent } from '../extraction/generated-detection';
import { getCargoWorkspaceCrateMap } from './frameworks/cargo-workspace';
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
  // files. Tests and abstract-looking bodies are candidates too. A lone method
  // stands only when the receiver is named after its owner: netbox's
  // `device=self.parent.device` is a model field, not the project's one
  // `device` method (a GraphQL filter's). A veto, never a filter — filtering
  // first would promote some other lone match into a new guess.
  const unique = result(context.getNodesByName(member), 0.8);
  const target = unique ? context.getNodeById?.(unique.targetNodeId) : null;
  return target && target.kind === 'method' && !sharesReceiverWord(receiverLink(receiver), target) ? null : unique;
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

  const named = context
    .getNodesByName(ref.referenceName)
    .filter(
      (n) =>
        (n.kind === 'function' ||
          (!bareFnOnly && n.kind === 'method') ||
          (bareClassOk && n.kind === 'class')) &&
        sameLanguageFamily(n.language, ref.language) &&
        n.id !== ref.fromNodeId // a function registering itself is not a dependency edge
    );
  // A function declared inside another is in scope only in there: httpx's
  // `self._build_auth(auth)` passes its own parameter, not the `auth` a test
  // defines inside `test_custom_auth`. Those still count against a lone
  // cross-file guess below — a name several functions use for themselves is
  // as likely a local's.
  let candidates = named.filter((n) => isLexicallyReachable(n, ref, context));
  if (candidates.length === 0) return null;
  // A Python name the function around it binds — a parameter, an assignment —
  // is that local's value: httpx's `auth_flow(self, request)` handing `request`
  // on is not the package's `request()` function. A pytest fixture is what a
  // test's parameter of its name receives.
  if (ref.language === 'python' && !candidates.some((n) => isFixtureInReach(n, ref.filePath, context)) &&
      isPythonLocallyBound(ref.referenceName, ref, context)) return null;
  // Likewise a JS/TS parameter or local: lodash's `baseHas(object, key)` passes its own `object`.
  const jsLocal = jsFunctionLocalScope(ref.referenceName, ref, context);
  if (jsLocal) {
    candidates = candidates.filter((n) => n.filePath === ref.filePath && n.startLine >= jsLocal.start && n.startLine <= jsLocal.end);
    if (candidates.length === 0) return null;
  }

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
  // only an unambiguous match resolves — or, in Python, the one in reach of
  // a name the file imports (netbox's `sender=CustomField` beside a test's
  // own nested `CustomField`).
  if (candidates.length === 1 && (named.length === 1 ||
      (ref.language === 'python' && pythonFromImports(ref.filePath, context).has(ref.referenceName)))) {
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
export function isLexicallyReachable(
  candidate: Node,
  ref: UnresolvedRef,
  context: ResolutionContext
): boolean {
  // A `val` / `const` declared in a function body is that body's alone —
  // okio's `(source as Source).buffer()` bound to a `val buffer = Buffer()`
  // inside another test file's `pipe()`.
  if (candidate.kind === 'variable' || candidate.kind === 'constant' || (candidate.kind === 'field' && candidate.language === 'scala')) {
    const scope = localDeclarationScope(candidate, context);
    return scope === null || (ref.filePath === candidate.filePath && ref.line >= scope.start && ref.line <= scope.end);
  }
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

/** Per context: node id → the function body (or Scala block) a declaration is local to. */
const LOCAL_DECL_MEMO = new WeakMap<ResolutionContext, Map<string, { start: number; end: number } | null>>();

/**
 * The lines a variable declaration is in scope for when it is local: the
 * innermost function or method of its file whose lines hold it — or, for a
 * Scala `val` the graph files under its class but written inside a block of
 * the class body (cats' `test("…") { val f = … }`), that block. Null for a
 * declaration at file, class or object level. A Lua global assigned inside a
 * function is still global; C and C++ nesting is not trusted (see below).
 */
function localDeclarationScope(candidate: Node, context: ResolutionContext): { start: number; end: number } | null {
  if (NO_NESTED_FUNCTIONS.has(candidate.language)) return null;
  let memo = LOCAL_DECL_MEMO.get(context);
  if (!memo) LOCAL_DECL_MEMO.set(context, (memo = new Map()));
  const hit = memo.get(candidate.id);
  if (hit !== undefined) return hit;
  let scope: { start: number; end: number } | null = null;
  if (!((candidate.language === 'lua' || candidate.language === 'luau') && !isLuaLocal(candidate, context))) {
    for (const n of context.getNodesInFile(candidate.filePath)) {
      if ((n.kind !== 'function' && n.kind !== 'method') || n.id === candidate.id) continue;
      if (n.startLine > candidate.startLine || n.endLine < candidate.startLine || n.startLine === n.endLine) continue;
      if (n.startLine === candidate.startLine && (n.startColumn ?? 0) >= (candidate.startColumn ?? 0)) continue;
      if (!scope || n.endLine - n.startLine < scope.end - scope.start) scope = { start: n.startLine, end: n.endLine };
    }
    if (!scope && candidate.kind === 'field' && candidate.language === 'scala') scope = scalaBlockOf(candidate, context);
  }
  memo.set(candidate.id, scope);
  return scope;
}

/** The `{ … }` block, deeper than its class body, that a Scala `val` is written in; null for a member. */
function scalaBlockOf(candidate: Node, context: ResolutionContext): { start: number; end: number } | null {
  const owner = candidate.qualifiedName.includes('::') ? candidate.qualifiedName.slice(0, candidate.qualifiedName.lastIndexOf('::')) : '';
  const cls = context.getNodesInFile(candidate.filePath).find((n) =>
    n.qualifiedName === owner && (n.kind === 'class' || n.kind === 'trait' || n.kind === 'struct' || n.kind === 'module'));
  if (!cls || cls.startLine >= candidate.startLine) return null;
  const lines = context.getFileLines?.(candidate.filePath) ?? context.readFile(candidate.filePath)?.split(/\r?\n/) ?? [];
  const clean = (l: string) => l.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)'/g, '""').replace(/\/\/.*$/, '');
  // Depth at the start of each line, counted from the class header; the body is depth 1.
  const opens: number[] = [];
  let depth = 0;
  for (let line = cls.startLine; line < candidate.startLine; line++) {
    for (const ch of clean(lines[line - 1] ?? '')) {
      if (ch === '{') { depth++; opens.push(line); }
      else if (ch === '}') { depth = Math.max(0, depth - 1); opens.pop(); }
    }
  }
  if (depth <= 1) return null;
  const start = opens[opens.length - 1]!;
  let d = depth;
  for (let line = candidate.startLine; line <= cls.endLine; line++) {
    for (const ch of clean(lines[line - 1] ?? '')) {
      if (ch === '{') d++;
      else if (ch === '}' && --d < depth) return { start, end: line };
    }
  }
  return { start, end: cls.endLine };
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
    (!isSealedModule(candidate.filePath, context) && !isUnexportedModuleBinding(candidate, context))
  );
}

const ESM_BINDING_KINDS: ReadonlySet<string> = new Set(['function', 'variable', 'constant', 'class', 'interface', 'type_alias', 'enum', 'component']);
const ESM_EXPORT_LISTS = new WeakMap<ResolutionContext, Map<string, { module: boolean; names: Set<string> }>>();

/**
 * Whether `candidate` is a top-level binding of an ES module that the module
 * doesn't export — declared without `export` and absent from its `export { … }`
 * / `export default x` lists. No other file can name it. The sealed-module
 * rule above covers files that export nothing; this is the same boundary per
 * symbol: sveltekit's `generate_manifest.js` keeps an unexported `resolve`
 * that twenty other files' `resolve(…)` calls went to. Classic scripts,
 * CommonJS, `declare global` and `.d.ts` files, members of a class or
 * namespace (qualified names), names a default-exported or returned object
 * literal lists,
 * and anything not declared by a statement of its own (an object literal's
 * member, `proto.x = function x() {}`) are exempt.
 */
function isUnexportedModuleBinding(candidate: Node, context: ResolutionContext): boolean {
  if (candidate.isExported || !ESM_BINDING_KINDS.has(candidate.kind)) return false;
  if (candidate.qualifiedName.includes('::') || /\.d\.[cm]?ts$/.test(candidate.filePath)) return false;
  let memo = ESM_EXPORT_LISTS.get(context);
  if (!memo) ESM_EXPORT_LISTS.set(context, (memo = new Map()));
  let info = memo.get(candidate.filePath);
  if (!info) {
    const source = context.readFile(candidate.filePath) ?? '';
    const code = blankStringContents(stripCommentsForRegex(source, 'typescript'));
    const module = (HAS_IMPORT_STATEMENT.test(code) || HAS_ESM_EXPORT.test(code)) &&
      !HAS_CJS_EXPORT.test(source) && !/\bdeclare\s+global\b/.test(code);
    const names = new Set<string>();
    if (module) {
      for (const m of source.matchAll(/^[ \t]*export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
        for (const item of m[1]!.split(',')) {
          const local = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
          if (local) names.add(local);
        }
      }
      for (const m of source.matchAll(/^[ \t]*export\s+(?:default|=)\s+([A-Za-z_$][\w$]*)\s*;?\s*$/gm)) names.add(m[1]!);
      // `export default { getAdapter, adapters: known }` exposes its shorthand and
      // value names; so does a `return { getDefaultActivityRoute, … }` (a
      // composable hands the function out through its result).
      for (const m of code.matchAll(/^[ \t]*export\s+default\s+\{([^}]*)\}|\breturn\s*\{([^{}]*)\}/gm)) {
        for (const item of (m[1] ?? m[2])!.split(',')) {
          const value = item.includes(':') ? item.split(':').pop()! : item;
          const id = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(value)?.[1];
          if (id) names.add(id);
        }
      }
    }
    info = { module, names };
    memo.set(candidate.filePath, info);
  }
  if (!info.module || info.names.has(candidate.name)) return false;
  const line = (context.getFileLines?.(candidate.filePath) ?? context.readFile(candidate.filePath)?.split('\n'))?.[candidate.startLine - 1] ?? '';
  // Its own line says `export` (a node's flag can miss a form), or it is
  // `prototype.toString = function toString() {…}`, reached through instances.
  if (/^\s*export\b/.test(line)) return false;
  // Only a declaration statement is a module binding: an object literal's
  // member (a zustand store action `setZipUri: (v) => set(…)`) is reached
  // through the object, and so is `proto.x = function x() {}`.
  return /^\s*(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|(?:abstract\s+)?class|interface|type|enum)\s/.test(line);
}

const LUA_LOCALS = new WeakMap<ResolutionContext, Map<string, boolean>>();

/** Whether a Lua variable or function is declared `local` (`local x = …`, `local function f`, `local a, x = …`). */
function isLuaLocal(candidate: Node, context: ResolutionContext): boolean {
  if (candidate.kind !== 'variable' && candidate.kind !== 'constant' && candidate.kind !== 'function') return false;
  let memo = LUA_LOCALS.get(context);
  if (!memo) LUA_LOCALS.set(context, (memo = new Map()));
  const hit = memo.get(candidate.id);
  if (hit !== undefined) return hit;
  const line = (context.getFileLines?.(candidate.filePath) ?? context.readFile(candidate.filePath)?.split(/\r?\n/))?.[candidate.startLine - 1] ?? '';
  const local = /^\s*local\b/.test(line);
  memo.set(candidate.id, local);
  return local;
}

const JVM_CALLABLE_KINDS: ReadonlySet<string> = new Set(['method', 'function']);
const JVM_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'enum', 'struct', 'trait', 'type_alias', 'annotation']);

/**
 * A test suite — a test source set, a `tests/` / `__tests__/` / `spec/`
 * directory, a `FooTest.kt` / `test_foo.py` / `foo.test.ts` file — as opposed
 * to test-support code a project ships (`testing/`, `fakes/`, a `*-test`
 * module like kotlinx-coroutines-test), which its own code may use.
 */
function isTestSuitePath(filePath: string): boolean {
  if (!isTestPath(filePath)) return false;
  const lower = filePath.toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  const original = filePath.slice(filePath.lastIndexOf('/') + 1);
  // (`…Spec.java` alone is no test: halo's `IndexSpecs`, okhttp's `ConnectionSpec`.)
  if (name.startsWith('test_') || /[._-](?:test|tests)\.[a-z0-9]+$|[._](?:spec|specs)\.[a-z0-9]+$/.test(name) ||
      // CamelCase suffixes where the language names tests so: not `useTests.ts`, a React hook.
      /(?:Test|Tests|TestCase)\.(?:java|kt|kts|swift|cs|scala|groovy|m|mm|vb|fs)$/.test(original) || name === 'conftest.py') return true;
  return /(?:^|\/)(?:tests?|__tests__|specs?|e2e)\//.test(lower) || /(?:^|\/)[A-Za-z0-9]*(?:Test|Tests|Spec)\//.test(filePath);
}

const MINIFIED_SCRIPTS = new WeakMap<ResolutionContext, Map<string, boolean>>();

/** A minified / bundled script, by name (`jquery.min.js`) or by its text. */
function isMinifiedScript(filePath: string, context: ResolutionContext): boolean {
  if (!/\.(?:m?js|cjs)$/i.test(filePath)) return false;
  let memo = MINIFIED_SCRIPTS.get(context);
  if (!memo) MINIFIED_SCRIPTS.set(context, (memo = new Map()));
  let hit = memo.get(filePath);
  if (hit === undefined) {
    hit = /[.-]min\.m?js$/i.test(filePath) || isMinifiedContent(filePath, context.readFile(filePath) ?? '');
    memo.set(filePath, hit);
  }
  return hit;
}

/** Per context: every package the project's JVM sources declare. */
const JVM_PACKAGES = new WeakMap<ResolutionContext, Set<string>>();

/**
 * Whether a Java file binds `name` with a single-type (or static) import from
 * a package the project does not declare — `import java.lang.reflect.Field;`,
 * `import static org.junit.Assert.assertEquals;`. A nested class of a project
 * type (`import com.acme.Outer.Inner;`) is under a project package, so it is not.
 */
function isJavaOutsideImport(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const binding = context.getImportMappings(ref.filePath, ref.language).find((m) => m.localName === name);
  if (!binding) return false;
  // A member the file declares itself is in scope before any import —
  // Exposed's `toLocalDateTime(value)` inside the column type that defines it —
  // in the same namespace only: gson's `new URI(…)` is `java.net.URI` beside
  // `TypeAdapters`' field `URI`, as a type always is beside a value.
  const call = ref.referenceKind === 'calls' && name === ref.referenceName;
  const kinds = call ? JVM_CALLABLE_KINDS : JVM_TYPE_KINDS;
  if ((context.getNodesInFileNamed?.(ref.filePath, name) ?? context.getNodesInFile(ref.filePath).filter((n) => n.name === name))
    .some((n) => kinds.has(n.kind))) return false;
  let packages = JVM_PACKAGES.get(context);
  if (!packages) {
    packages = new Set<string>();
    for (const n of context.getNodesByKind('namespace')) {
      if (n.language === 'java' || n.language === 'kotlin' || n.language === 'scala') packages.add(n.qualifiedName);
    }
    JVM_PACKAGES.set(context, packages);
  }
  const parts = binding.source.split('.');
  for (let i = 1; i < parts.length; i++) {
    if (packages.has(parts.slice(0, i).join('.'))) return false;
  }
  return true;
}

/** Lua's global functions, and the test runner's: `local type = type` is the standard library's `type`. */
const LUA_GLOBAL_FUNCTIONS: ReadonlySet<string> = new Set([
  'assert', 'error', 'ipairs', 'pairs', 'next', 'type', 'tostring', 'tonumber', 'setmetatable', 'getmetatable',
  'rawget', 'rawset', 'rawequal', 'rawlen', 'select', 'pcall', 'xpcall', 'unpack', 'print', 'load', 'loadstring',
  'loadfile', 'dofile', 'collectgarbage', 'require', 'setfenv', 'getfenv', 'newproxy', 'typeof', 'warn', 'tick', 'wait',
  'describe', 'it', 'before_each', 'after_each', 'setup', 'teardown', 'lazy_setup', 'lazy_teardown', 'pending', 'finally',
  'insulate', 'expose',
]);

/** `require "m"` (or a loader named for it — kong's `reload_module("spec.internal.misc")`), then any `.member`s. */
const LUA_REQUIRE_ALIAS = /^(?:require|[A-Za-z_]\w*(?:[Rr]equire|_module|[Ii]mport))\s*\(?\s*(["'])([^"']+)\1\s*\)?((?:\s*\.\s*[A-Za-z_]\w*)*)\s*$/;
const LUA_NAME_ALIAS = /^([A-Za-z_]\w*)((?:\s*\.\s*[A-Za-z_]\w*)*)\s*$/;

/**
 * A bare Lua call through a `local` alias, followed to what the alias names:
 *
 *   local splitn = require("kong.tools.string").splitn   → the module's `splitn`
 *   local select_listener = utils.select_listener        → through `local utils = require …`
 *   local fmt = string.format / local type = type        → the standard library's: no edge
 *
 * Kong localizes every global and module function it uses this way, so its
 * calls stopped at a same-file variable — 8,000 of them, most for the
 * standard library. `undefined` when the call is not through such an alias
 * (it resolves as before), null when the alias names nothing in the project.
 */
function luaAliasTarget(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null | undefined {
  const decl = luaLocalDecl(ref.referenceName, ref.filePath, ref.line, context);
  if (!decl) return undefined;
  const target = luaAliasOf(decl, context, 0);
  if (target === undefined) return undefined;
  if (target === null) return null;
  return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'import' };
}

/** The `local name = …` in scope at `line` of `file`: the nearest one above it that no other function holds. */
function luaLocalDecl(name: string, file: string, line: number, context: ResolutionContext): Node | null {
  const nodes = context.getNodesInFile(file);
  const fns = nodes.filter((n) => n.kind === 'function' || n.kind === 'method');
  let best: Node | null = null;
  for (const n of nodes) {
    if (n.name !== name || n.kind !== 'variable' || n.startLine > line || !n.signature) continue;
    if (fns.some((f) => f.startLine <= n.startLine && n.startLine <= f.endLine && !(f.startLine <= line && line <= f.endLine))) continue;
    if (!isLuaLocal(n, context)) continue;
    if (!best || n.startLine > best.startLine) best = n;
  }
  // A function's own locals are not nodes: kong's `local clear_header =
  // kong.response.clear_header` inside an access handler. Read the nearest
  // one above the call within the innermost function around it.
  const fn = fns.filter((f) => f.startLine <= line && line <= f.endLine && f.startLine < line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
  if (fn && (!best || best.startLine < fn.startLine)) {
    const lines = context.getFileLines?.(file) ?? context.readFile(file)?.split(/\r?\n/) ?? [];
    const decl = new RegExp(`^\\s*local\\s+${name}\\s*=\\s*(.+?)\\s*$`);
    for (let at = line - 1; at > fn.startLine; at--) {
      const m = decl.exec(lines[at - 1] ?? '');
      if (!m) continue;
      const fileNode = nodes.find((n) => n.kind === 'file');
      if (!fileNode) break;
      return { ...fileNode, name, kind: 'variable', signature: `= ${m[1]}`, startLine: at, endLine: at };
    }
  }
  return best;
}

/** Where a Lua alias is written: its file, line and name, and a node there to resolve `require`s from. */
interface LuaSite { file: string; line: number; name: string; node: Node }

/**
 * What a Lua alias variable names: a project function (or the module's own
 * global), null for the standard library or an outside module, `undefined`
 * for an initializer that is not an alias.
 */
function luaAliasOf(decl: Node, context: ResolutionContext, depth: number): Node | null | undefined {
  const rhs = decl.signature!.replace(/^\s*=\s*/, '').trim();
  return luaAliasExpr(rhs, { file: decl.filePath, line: decl.startLine, name: decl.name, node: decl }, context, depth);
}

const luaMembers = (chain: string): string[] => chain.split('.').map((s) => s.trim()).filter(Boolean);

function luaAliasExpr(rhs: string, site: LuaSite, context: ResolutionContext, depth: number): Node | null | undefined {
  const req = LUA_REQUIRE_ALIAS.exec(rhs);
  if (req) return luaModuleMember(req[2]!, luaMembers(req[3]!), site.node, context, depth);
  const named = LUA_NAME_ALIAS.exec(rhs);
  if (!named) return undefined;
  const root = named[1]!;
  const path = luaMembers(named[2]!);
  const rootDecl = root === site.name ? null : luaLocalDecl(root, site.file, site.line - 1, context);
  if (rootDecl) {
    const module = LUA_REQUIRE_ALIAS.exec(rootDecl.signature!.replace(/^\s*=\s*/, '').trim());
    if (module && path.length > 0) return luaModuleMember(module[2]!, [...luaMembers(module[3]!), ...path], rootDecl, context, depth);
    return undefined;
  }
  if (path.length === 0) return LUA_GLOBAL_FUNCTIONS.has(root) ? null : undefined;
  if (!LUA_LIBRARY_TABLES.has(root)) {
    // A member of a global table the host provides — kong's `local clear_header =
    // kong.response.clear_header` — is the one method of a table named after its holder.
    const member = path[path.length - 1]!;
    const holder = path.length > 1 ? path[path.length - 2]! : root;
    const owned = context.getNodesByName(member).filter((n) =>
      (n.language === 'lua' || n.language === 'luau') && n.kind === 'method' && sharesReceiverWord(holder, n) &&
      !(isTestPath(n.filePath) && !isTestPath(site.file)));
    return owned.length === 1 ? owned[0]! : undefined;
  }
  if (path.length !== 1) return undefined;
  // A library function the project patches itself (kong's `ngx.sleep`) is the project's —
  // a test's stand-in (`function ngx.get_phase()` in a spec) only for that test.
  const patched = context.getNodesByName(path[0]!).filter((n) =>
    (n.kind === 'function' || n.kind === 'method') && n.qualifiedName.split(/::|\./)[0] === root &&
    (n.filePath === site.file || !isTestPath(n.filePath)));
  return patched.length === 1 ? patched[0]! : null;
}

/** Per-context memo: `file\0a.b` → what that module member is. */
const LUA_MEMBERS = new WeakMap<ResolutionContext, Map<string, Node | null | undefined>>();

/** `member` of the module `require(name)` returns, from `decl`'s file: its function of that name. */
function luaModuleMember(name: string, path: string[], decl: Node, context: ResolutionContext, depth: number): Node | null | undefined {
  const file = luaModuleFile(name, decl, context);
  if (!file) return null;
  // `require "kong.conf_loader"` called directly: the module's returned value.
  if (path.length === 0) return undefined;
  let memo = LUA_MEMBERS.get(context);
  if (!memo) LUA_MEMBERS.set(context, (memo = new Map()));
  const key = `${file}\0${path.join('.')}`;
  if (memo.has(key)) return memo.get(key);
  memo.set(key, null); // a cycle of re-exports names nothing
  const found = luaMemberIn(file, path, context, depth);
  memo.set(key, found);
  return found;
}

function luaMemberIn(file: string, path: string[], context: ResolutionContext, depth: number): Node | null | undefined {
  const member = path[path.length - 1]!;
  const nodes = context.getNodesInFile(file);
  const inFile = nodes.filter((n) => n.name === member);
  const fns = inFile.filter((n) => n.kind === 'function' || n.kind === 'method');
  if (fns.length > 0) {
    const owner = path.length > 1 ? path[path.length - 2]! : null;
    return fns.find((n) => owner !== null && n.qualifiedName.endsWith(`${owner}::${member}`)) ??
      fns.find((n) => n.kind === 'method') ?? fns[0]!;
  }
  if (depth >= 3) return null;
  // The module exports something under this name: `return { check = check_phase }`,
  // `_M.check = check_phase`, `kong_exec = cmd.kong_exec,` (spec helpers' table).
  const source = (context.readFile(file) ?? '')
    .replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, (c) => c.replace(/[^\n]/g, ''))
    .replace(/--[^\n]*/g, '');
  const exported = new RegExp(`(?:^|[\\s{,.])${member}\\s*=\\s*([A-Za-z_]\\w*(?:\\s*\\.\\s*[A-Za-z_]\\w*)*)\\s*(?:[,;}]|$)`, 'm').exec(source);
  if (exported && exported[1] !== member) {
    const rhs = exported[1]!;
    const line = source.slice(0, exported.index).split('\n').length + 1;
    if (/^[A-Za-z_]\w*$/.test(rhs)) {
      const fn = nodes.find((n) => n.name === rhs && (n.kind === 'function' || n.kind === 'method'));
      if (fn) return fn;
    }
    const at = nodes.find((n) => n.kind === 'file') ?? nodes[0];
    const next = at ? luaAliasExpr(rhs, { file, line, name: member, node: at }, context, depth + 1) : undefined;
    if (next !== undefined) return next;
  }
  // The module re-exports an alias of its own (`local splitn = require(…).splitn`).
  const alias = inFile.find((n) => n.kind === 'variable' && n.signature && isLuaLocal(n, context));
  if (alias) {
    const next = luaAliasOf(alias, context, depth + 1);
    if (next !== undefined) return next;
  }
  const global = inFile.find((n) => n.kind === 'variable' && !isLuaLocal(n, context));
  return global ?? null;
}

/** The project file `require(name)` loads from `decl`'s file, or null for a module outside it. */
function luaModuleFile(name: string, decl: Node, context: ResolutionContext): string | null {
  const resolved = context.resolveImport?.({
    fromNodeId: decl.id,
    referenceName: name,
    referenceKind: 'imports',
    line: decl.startLine,
    column: 0,
    filePath: decl.filePath,
    language: decl.language,
  });
  if (!resolved) return null;
  return context.getNodeById?.(resolved.targetNodeId)?.filePath ?? null;
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

const GO_EXTERNAL_QUALIFIED = new WeakMap<ResolutionContext, Map<string, boolean>>();

/**
 * Whether a Go reference is written through an imported package from outside
 * the module — `context.Context`, `fmt.Errorf`, a third-party `gin.H` — read
 * from its line, since the index keeps only the name.
 */
function isGoExternalQualified(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.referenceKind === 'imports') return false;
  const name = ref.referenceName.split('.').pop()!;
  if (!/^[A-Za-z_]\w*$/.test(name)) return false;
  let memo = GO_EXTERNAL_QUALIFIED.get(context);
  if (!memo) GO_EXTERNAL_QUALIFIED.set(context, (memo = new Map()));
  const key = `${ref.filePath}\0${ref.line}\0${ref.column}\0${ref.referenceName}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let external = false;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split(/\r?\n/)[ref.line - 1] ?? '';
  const at = Math.max(0, ref.column);
  // The qualifier right before the name at the reference's column, or the
  // line's only spelling of the name.
  const before = line.startsWith(name, at) ? /(?:^|[^\w.])([A-Za-z_]\w*)\.$/.exec(line.slice(0, at))?.[1]
    : !new RegExp(`(?<![\\w.])${name}\\b`).test(line) ? new RegExp(`(?:^|[^\\w.])([A-Za-z_]\\w*)\\.${name}\\b`).exec(line)?.[1] : undefined;
  if (before) {
    const imported = context.getImportMappings(ref.filePath, 'go').find((m) => m.localName === before);
    if (imported) {
      const mod = context.getGoModule?.();
      const local = imported.source.startsWith('.') || imported.source.includes('/internal/') ||
        (mod !== undefined && mod !== null && (imported.source === mod.modulePath || imported.source.startsWith(`${mod.modulePath}/`)));
      external = !local;
    }
  }
  memo.set(key, external);
  return external;
}

const PHP_CLASS_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'trait', 'enum']);
/**
 * Whether a bare PHP class name at `ref` can mean `candidate`. An unqualified
 * class name is the current namespace's class or the one a `use` imports —
 * PHP never falls back to another namespace for classes. koel's `extends
 * Request` (under `use Saloon\Http\Request;`, `use App\Http\Requests\API\Request;`,
 * or in `App\Http\Requests\API` itself) all went to the first `Request` indexed.
 */
function isPhpClassVisible(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.language !== 'php' || candidate.language !== 'php' || !PHP_CLASS_KINDS.has(candidate.kind)) return true;
  const name = ref.referenceName;
  if (!/^[A-Za-z_]\w*$/.test(name) || /^(?:self|static|parent)$/i.test(name)) return true;
  const fqn = candidate.qualifiedName.replace(/::/g, '\\');
  const scope = phpFileScope(ref.filePath, context);
  const imported = scope.uses.get(name);
  if (imported !== undefined) return imported.toLowerCase() === fqn.toLowerCase();
  return fqn.toLowerCase() === (scope.namespace ? `${scope.namespace}\\${name}` : name).toLowerCase();
}

const SCALA_OBJECT_PACKAGES = new WeakMap<ResolutionContext, Map<string, string | null>>();

/** The full package a Scala file's `package object X` opens (`algebra`, `cats.syntax`), or null for none. */
function scalaPackageObjectPackage(file: string, context: ResolutionContext): string | null {
  let memo = SCALA_OBJECT_PACKAGES.get(context);
  if (!memo) SCALA_OBJECT_PACKAGES.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit !== undefined) return hit;
  const text = context.readFile(file) ?? '';
  const object = /^\s*package\s+object\s+([\w$]+)/m.exec(text)?.[1];
  const pkg = object ? [...scalaPackageClauses(text), object].join('.') : null;
  memo.set(file, pkg);
  return pkg;
}

/** A Scala file's package clauses, in order (`package cats` / `package laws` → cats, laws). */
function scalaPackageClauses(text: string): string[] {
  return [...text.matchAll(/^\s*package\s+(?!object\b)([\w.]+)\s*$/gm)].flatMap((m) => m[1]!.split('.'));
}

/**
 * Whether a member of a Scala package object is in scope at `ref`: from its
 * package and the packages under it, or from a file that imports something
 * through the package (`import algebra._`, `import algebra.Eq`).
 */
function isScalaPackageObjectMemberVisible(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const objectPkg = scalaPackageObjectPackage(candidate.filePath, context);
  if (objectPkg === null) return true;
  const text = context.readFile(ref.filePath) ?? '';
  const here = scalaPackageClauses(text).join('.');
  if (here === objectPkg || here.startsWith(`${objectPkg}.`)) return true;
  const last = objectPkg.split('.').pop()!;
  return new RegExp(`^\\s*import\\s+[^\\n]*\\b${last.replace(/\$/g, '\\$')}\\b`, 'm').test(text);
}

const SFC_SCRIPT_RANGES = new WeakMap<ResolutionContext, Map<string, Array<{ start: number; end: number; exported: boolean }>>>();

/**
 * Whether a declaration in a `.svelte` / `.vue` file is the component's own:
 * anything but the component itself, unless it sits in a block that can export
 * — Svelte's `<script module>` (`context="module"`), or a Vue `<script>` that
 * is not `setup` — or is a type a Vue `<script setup>` exports.
 */
function isSfcPrivate(n: Node, context: ResolutionContext): boolean {
  const svelte = n.filePath.endsWith('.svelte');
  if ((!svelte && !n.filePath.endsWith('.vue')) || n.kind === 'component' || n.kind === 'file') return false;
  let memo = SFC_SCRIPT_RANGES.get(context);
  if (!memo) SFC_SCRIPT_RANGES.set(context, (memo = new Map()));
  let ranges = memo.get(n.filePath);
  if (!ranges) {
    ranges = [];
    const lines = context.getFileLines?.(n.filePath) ?? context.readFile(n.filePath)?.split(/\r?\n/) ?? [];
    let open: { start: number; exported: boolean } | null = null;
    lines.forEach((text, i) => {
      const tag = /<script\b([^>]*)>/i.exec(text);
      if (tag && !open) {
        const attrs = tag[1] ?? '';
        open = { start: i + 1, exported: svelte ? /\bmodule\b|context\s*=\s*["']module["']/.test(attrs) : !/\bsetup\b/.test(attrs) };
      }
      if (open && /<\/script\s*>/i.test(text)) {
        ranges!.push({ ...open, end: i + 1 });
        open = null;
      }
    });
    memo.set(n.filePath, ranges);
  }
  const block = ranges.find((r) => n.startLine >= r.start && n.startLine <= r.end);
  if (block?.exported) return false;
  // Vue hoists the types `<script setup>` exports: mealie imports CrudTable.vue's `TableConfig`.
  if (!svelte && block) {
    const line = context.getFileLines?.(n.filePath)?.[n.startLine - 1] ?? context.readFile(n.filePath)?.split(/\r?\n/)[n.startLine - 1] ?? '';
    if (/^\s*export\s+(?:declare\s+)?(?:interface|type|enum)\b/.test(line)) return false;
  }
  return true;
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
  // Go's `context.Context`, `http.Handler`: written through a package from
  // outside the module, so nothing in it — not even the same file's method
  // `Stream.Context` (fiber's 85 `context.Context` parameters went there).
  if (ref.language === 'go' && candidate.language === 'go' && isGoExternalQualified(ref, context)) return false;
  if (candidate.filePath === ref.filePath) return true;
  // A vendored minified bundle's names are mangled: healthchecks' 369 `$(…)`
  // (jQuery, a global) went to a one-letter helper inside bootstrap-native.min.js.
  if (isMinifiedScript(candidate.filePath, context)) return false;
  // A test suite is not linked into the program: typeorm's `Record<K, V>` is
  // not a test entity `Record`, tokio's `Output` not a `runtime/tests` type.
  if (isTestSuitePath(candidate.filePath) && !isTestPath(ref.filePath)) return false;
  // A Svelte component's instance script, or a Vue SFC's `<script setup>`, is
  // private to the component: shadcn-svelte's 838 `<Item.Root>` (a namespace
  // import) went to a `type Item` one example component declares for itself.
  if (isSfcPrivate(candidate, context)) return false;
  // A bare PHP class name is its namespace's class, or the one a `use` names.
  if (!isPhpClassVisible(candidate, ref, context)) return false;
  // A Scala package object's member is in scope in its package and those under
  // it, or through an import: cats.laws' `Eq` is the `cats` package object's
  // alias, not the `algebra` one's (752 refs went there).
  if (candidate.language === 'scala' && ref.language === 'scala' && !isScalaPackageObjectMemberVisible(candidate, ref, context)) return false;
  if (candidate.language === 'csharp' && ref.language === 'csharp' && CSHARP_TYPE_KINDS.has(candidate.kind) &&
      /^[A-Za-z_]\w*$/.test(ref.referenceName) &&
      (!isCsharpTypeVisible(candidate, ref, context) || !isCsharpNestedTypeInScope(candidate, ref, context))) return false;
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
  // An R test file runs in an environment of its own (testthat): its top-level
  // `c <- ggplot(…)` is not what the package's 2,843 `c(…)` calls mean. The
  // `helper-*.R` / `setup-*.R` files are sourced for every test, so theirs are shared.
  if (lang === 'r' && (candidate.kind === 'variable' || candidate.kind === 'constant') &&
      /(?:^|\/)tests?\//.test(candidate.filePath) && !/(?:^|\/)(?:helper|setup)[^/]*\.[rR]$/.test(candidate.filePath)) return false;
  // A Lua `local` belongs to its chunk: kong's spec helpers' `local it = it`
  // took busted's `it(…)` in every other spec file, 4,166 times. Its module
  // can still hand it out — `return { check = check_phase }` — to a file that
  // names it through a `require` alias.
  if ((lang === 'lua' || lang === 'luau') && isLuaLocal(candidate, context)) {
    return ref.referenceKind === 'calls' && /^[A-Za-z_]\w*$/.test(ref.referenceName) &&
      luaAliasTarget(ref, context)?.targetNodeId === candidate.id;
  }
  // JS/TS/ArkTS sealed modules + markdown/JSON call-target guards (#1719).
  // Same predicate matchByExactName / matchFuzzy apply to their survivors so a
  // rejection here cannot fall through to a promoted runner-up.
  return isCrossFileReachable(candidate, ref, context);
}

/**
 * Languages whose calls are JS/TS calls — Vue, Svelte and Astro components'
 * scripts and template expressions included: a bare `t('key')` in a `.vue`
 * file resolves lexically exactly as in a `.ts` one.
 */
const JS_FAMILY = new Set<string>(['typescript', 'tsx', 'javascript', 'jsx', 'vue', 'svelte', 'astro']);
const JS_TS = new Set<string>(['typescript', 'tsx', 'javascript', 'jsx']);

/** Languages whose identifiers resolve regardless of case. */
export const CASE_INSENSITIVE_LANGUAGES = new Set<string>(['php', 'pascal', 'cfml', 'cfscript', 'cfquery', 'cobol', 'vbnet']);

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
/**
 * The receiver a call the extractor recorded by its bare name is written on,
 * read from the source: TS/JS keeps `this.container.classList.toggle()` and
 * `window.$events.listen()` bare, Scala `requestToArmeria(request).execute()`
 * and `_.get.whenRequestMatchesPartial(…)`. `'self'` for `this.m()` /
 * `self.m()` / `super.m()` / `super().m()`; null for a call written bare (or
 * not found). `links` are the member names between `this` and the method.
 */
function bareCallReceiver(ref: UnresolvedRef, context: ResolutionContext): { receiver: string; links: string[] } | null {
  if (ref.referenceKind !== 'calls' || !/^[A-Za-z_$][\w$]*$/.test(ref.referenceName)) return null;
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/);
  if (!lines) return null;
  const text = lines.slice(ref.line - 1, ref.line + 7).join('\n').slice(Math.max(0, ref.column));
  const name = ref.referenceName.replace(/\$/g, '\\$');
  const at = new RegExp(`(?<![\\w$])${name}\\s*(?:<[^<>()]*>|\\[(?:[^\\[\\]]|\\[[^\\[\\]]*\\])*\\])?\\s*[({]`).exec(text);
  if (!at) return null;
  const before = text.slice(0, at.index).replace(/\s+$/, '');
  if (!/\??\.$/.test(before)) return null;
  const head = before.replace(/\??\.$/, '').replace(/\s+$/, '');
  if (/(?:^|[^\w$.])(?:this|self|super|Self)$/.test(head) || /(?:^|[^\w$.])super\s*\([^()]*\)$/.test(head)) return { receiver: 'self', links: [] };
  const chain = /(?:^|[^\w$.#])((?:this|super)(?:\s*\??\.\s*#?[\w$]+)+)$/.exec(head);
  const links = chain ? chain[1]!.split('.').slice(1).map((l) => l.replace(/[\s?]/g, '')) : [];
  return { receiver: head.slice(-40), links };
}

/** Whether a call recorded by its bare name is written on something other than the caller's own object. */
function isCollapsedNonRecursion(ref: UnresolvedRef, context: ResolutionContext): boolean {
  const written = bareCallReceiver(ref, context);
  if (!written || written.receiver === 'self') return false;
  return !(JS_FAMILY.has(ref.language) && isCollapsedSelfRecursion({ root: 'this', links: written.links }, ref, context));
}

function isCollapsedSelfRecursion(chain: { root: string; links: string[] }, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (chain.root !== 'this' || chain.links.length !== 1 || chain.links[0]!.includes('(')) return false;
  const field = chain.links[0]!.replace(/^#/, '');
  const caller = context.getNodeById?.(ref.fromNodeId);
  const cut = caller ? caller.qualifiedName.lastIndexOf('::') : -1;
  if (!caller || cut <= 0) return false;
  const owner = caller.qualifiedName.slice(0, cut).split('::').pop()!;
  const cls = context.getNodesInFile(ref.filePath).find((n) =>
    n.kind === 'class' && n.name === owner && n.startLine <= ref.line && n.endLine >= ref.line);
  if (!cls) return false;
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/) ?? [];
  const body = lines.slice(cls.startLine - 1, cls.endLine).join('\n');
  const f = field.replace(/\$/g, '\\$');
  const declared = new RegExp(`(?:^|[\\s(,])#?${f}\\s*[?!]?\\s*:\\s*([A-Za-z_$][\\w$]*)`, 'm').exec(body)?.[1] ??
    new RegExp(`\\bthis\\.${f}\\s*=\\s*new\\s+([A-Za-z_$][\\w$]*)`).exec(body)?.[1];
  return declared === owner;
}

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
 * Whether an R call is a plain function call — `range(x)`, `vars(a)` — not a
 * ggproto / R6 method through `obj$m(…)` or `self$m(…)`. A method is only
 * reached through its object: ggplot2's `range(data$x)` (base R's) went to a
 * Coord's `range` method.
 */
function isBareRCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.language !== 'r' || ref.referenceKind !== 'calls' || !/^[A-Za-z_.][\w.]*$/.test(ref.referenceName)) return false;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (!line) return false;
  const m = new RegExp(`(?<![\\w.])${ref.referenceName.replace(/\./g, '\\.')}\\s*\\(`).exec(line);
  return !!m && !/(?:\$|@|::)\s*$/.test(line.slice(0, m.index));
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
  // `$obj->name(` / `Foo::name(` / `$obj?->name(`, should a column ever land on
  // the name — but not `'size' => filesize($zip)` or `$x ? a : name()`.
  return !(end > 1 && ((line[end - 1] === '>' && line[end - 2] === '-') || (line[end - 1] === ':' && line[end - 2] === ':')));
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
    if (n.filePath === ref.filePath) return true;
    // `from django.shortcuts import render`: the call is the package's.
    if (isPythonNameImportedFromOutside(ref.referenceName, ref, context)) return false;
    // `view = UserView.as_view()` … `view(request)`: the file's own value —
    // unless it is a pytest fixture, which a test takes as a parameter of that name.
    return isFixtureInReach(n, ref.filePath, context) || !isPythonLocallyBound(ref.referenceName, ref, context);
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

/**
 * A pytest fixture: `@pytest.fixture` / `@fixture`, or anything a `conftest.py`
 * defines. Python decorators are not kept on the node, so they are read from
 * the lines above its `def` (a decorator's arguments may span lines).
 */
function isPytestFixture(n: Node, context: ResolutionContext): boolean {
  if (/(?:^|\/)conftest\.py$/.test(n.filePath) || (n.decorators ?? []).some((d) => /(?:^|\.)fixture\b/.test(d))) return true;
  return isDecoratedFixture(n, context);
}

/**
 * A fixture a test at `filePath` can take by name: one its own module defines,
 * or one a `conftest.py` of its directory or a parent does. A test module's
 * fixture is that module's alone — pytest's `_run_both(func)` is handing on its
 * parameter, not a doc example's `func` fixture.
 */
function isFixtureInReach(n: Node, filePath: string, context: ResolutionContext): boolean {
  if (n.filePath === filePath) return isPytestFixture(n, context);
  const conftest = /^(.*?)(?:^|\/)conftest\.py$/.exec(n.filePath);
  if (conftest !== null) return conftest[1] === '' || filePath.startsWith(`${conftest[1]}/`);
  // A fixture module a `conftest.py` above the test pulls in — `from
  // tests.fixtures.cli import *`, or `pytest_plugins = ["tests.fixtures.cli"]`.
  if (!isPytestFixture(n, context)) return false;
  return pluggedFixtureModules(filePath, context).some((m) => n.filePath === m || n.filePath.endsWith(`/${m}`));
}

const PY_PLUGGED_MODULES = new WeakMap<ResolutionContext, Map<string, string[]>>();

/** The module files (`tests/fixtures/cli.py`) the `conftest.py` files above `filePath` star-import or list in `pytest_plugins`. */
function pluggedFixtureModules(filePath: string, context: ResolutionContext): string[] {
  let memo = PY_PLUGGED_MODULES.get(context);
  if (!memo) PY_PLUGGED_MODULES.set(context, (memo = new Map()));
  const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
  const hit = memo.get(dir);
  if (hit) return hit;
  const modules: string[] = [];
  for (let d = dir; ; d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') {
    const text = context.readFile(d ? `${d}/conftest.py` : 'conftest.py');
    if (text) {
      for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+\*/gm)) modules.push(`${m[1]!.replace(/\./g, '/')}.py`);
      const plugins = /^\s*pytest_plugins\s*=\s*[[(]([^\])]*)[\])]/m.exec(text)?.[1] ?? '';
      for (const m of plugins.matchAll(/["']([\w.]+)["']/g)) modules.push(`${m[1]!.replace(/\./g, '/')}.py`);
    }
    if (!d) break;
  }
  memo.set(dir, modules);
  return modules;
}

const PY_FIXTURE_TYPES = new WeakMap<ResolutionContext, Map<string, string | null>>();

/**
 * The class a pytest fixture returns, for a test parameter of its name — the
 * fixture in reach (the test's module, else the nearest `conftest.py` above
 * it) whose body returns or yields `Cls(…)`, directly or through a local
 * assigned `Cls(…)`. Null for anything else (a parameter that is no fixture's,
 * a fixture returning a call of a function).
 */
function pythonFixtureReturnType(receiver: string, ref: UnresolvedRef, context: ResolutionContext): string | null {
  if (!/^[a-z_]\w*$/.test(receiver) || receiver === 'self' || receiver === 'cls') return null;
  let memo = PY_FIXTURE_TYPES.get(context);
  if (!memo) PY_FIXTURE_TYPES.set(context, (memo = new Map()));
  const key = `${ref.fromNodeId}\0${receiver}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let type: string | null = null;
  const caller = context.getNodeById?.(ref.fromNodeId);
  const lines = caller ? context.getFileLines?.(caller.filePath) ?? context.readFile(caller.filePath)?.split(/\r?\n/) ?? [] : [];
  // The receiver must be the test's own parameter.
  const signature = caller && (caller.kind === 'function' || caller.kind === 'method')
    ? lines.slice(caller.startLine - 1, caller.startLine + 4).join(' ').split(/\)\s*(?:->[^:]*)?:/)[0] ?? '' : '';
  if (new RegExp(`[(,]\\s*${receiver}\\s*(?:[:=,)]|$)`).test(signature)) {
    const fixtures = context.getNodesByName(receiver)
      .filter((n) => n.kind === 'function' && n.language === 'python' && isFixtureInReach(n, ref.filePath, context))
      .sort((a, b) => (a.filePath === ref.filePath ? -1 : 0) - (b.filePath === ref.filePath ? -1 : 0) || b.filePath.length - a.filePath.length);
    const fixture = fixtures[0];
    if (fixture) {
      const body = (context.getFileLines?.(fixture.filePath) ?? context.readFile(fixture.filePath)?.split(/\r?\n/) ?? [])
        .slice(fixture.startLine, fixture.endLine).join('\n');
      const returned = /^\s*(?:return|yield)\s+([A-Za-z_][\w.]*)\s*(\()?/m.exec(body);
      if (returned) {
        const direct = returned[2] ? returned[1]! : new RegExp(`^\\s*${returned[1]!.replace(/\./g, '\\.')}\\s*=\\s*([A-Za-z_][\\w.]*)\\s*\\(`, 'm').exec(body)?.[1];
        const cls = direct?.split('.').pop();
        if (cls && /^[A-Z]/.test(cls)) type = cls;
      }
    }
  }
  memo.set(key, type);
  return type;
}

function isDecoratedFixture(n: Node, context: ResolutionContext): boolean {
  if (n.language !== 'python' || n.kind !== 'function') return false;
  const lines = context.getFileLines?.(n.filePath) ?? context.readFile(n.filePath)?.split(/\r?\n/) ?? [];
  // Upward through the decorator lines: each one starts with `@`, or sits inside one's parentheses.
  let open = 0;
  for (let i = n.startLine - 2; i >= 0 && i >= n.startLine - 16; i--) {
    const text = lines[i]?.trim() ?? '';
    open += (text.match(/\)/g)?.length ?? 0) - (text.match(/\(/g)?.length ?? 0);
    if (open > 0) continue;
    if (!text.startsWith('@')) return false;
    if (/^@(?:\w+\.)*fixture\b/.test(text)) return true;
  }
  return false;
}

const PY_LOCAL_BINDS = new WeakMap<ResolutionContext, Map<string, boolean>>();

/**
 * Whether the function around a Python call — or its module, at top level —
 * binds `name` itself: an assignment (`view = X.as_view()`, `a, view = …`,
 * `view: T = …`), a parameter, a `for` / `with … as` / `except … as` target.
 * DRF's tests write `view = SomeView.as_view()` then `view(request)`, and
 * every such call went to one test file's `def view`.
 */
function isPythonLocallyBound(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const fn = context.getNodesInFile(ref.filePath)
    .filter((f) => (f.kind === 'function' || f.kind === 'method') && f.startLine <= ref.line && f.endLine >= ref.line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
  let memo = PY_LOCAL_BINDS.get(context);
  if (!memo) PY_LOCAL_BINDS.set(context, (memo = new Map()));
  const key = `${ref.filePath}\0${fn?.id ?? ''}\0${name}\0${fn ? '' : ref.line}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  // An imported name is the import's (the import resolver's to follow).
  if (pythonFromImports(ref.filePath, context).has(name)) {
    memo.set(key, false);
    return false;
  }
  // Code only: `{% user_display user as user_display %}` in a docstring binds nothing.
  const lines = stripCommentsForRegex(context.readFile(ref.filePath) ?? '', 'python').split(/\r?\n/);
  const n = name;
  const assigns = new RegExp(`^\\s*(?:[\\w\\s,*()\\[\\]]*,\\s*)?\\(?\\*?${n}\\)?\\s*(?:,[\\w\\s,*()\\[\\]]*)?(?::[^=]+)?=(?!=)`);
  const targets = new RegExp(`\\bfor\\s+[\\w\\s,()]*\\b${n}\\b[\\w\\s,()]*\\s+in\\b|\\bas\\s+${n}\\b`);
  const params = new RegExp(`[(,]\\s*\\*{0,2}${n}\\s*(?:[:=,)]|$)`);
  let bound = false;
  if (fn) {
    // The signature up to its `:` (it may span lines), then the body above the call.
    let i = fn.startLine - 1;
    let signature = '';
    for (; i < Math.min(lines.length, fn.startLine + 20); i++) {
      signature += lines[i] ?? '';
      if (/\)\s*(?:->[^:]*)?:\s*(?:#.*)?$/.test(lines[i] ?? '')) break;
    }
    bound = params.test(signature.replace(/^[^(]*/, ''));
    for (let line = i + 1; !bound && line < ref.line - 1; line++) {
      const text = lines[line] ?? '';
      bound = assigns.test(text) || targets.test(text);
    }
  }
  // A module-level binding (`view = api_view(['GET'])(handler)`).
  const top = new RegExp(`^(?:[\\w,\\s]*,\\s*)?${n}\\s*(?:,[\\w\\s,]*)?(?::[^=]+)?=(?!=)`);
  for (let line = 0; !bound && line < lines.length; line++) bound = top.test(lines[line] ?? '');
  memo.set(key, bound);
  return bound;
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

const JAVA_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'enum', 'struct', 'record', 'trait']);
const JAVA_SUPERS = new WeakMap<ResolutionContext, Map<string, string[]>>();
const JAVA_STATIC_IMPORTS = new WeakMap<ResolutionContext, Map<string, { owners: Set<string>; members: Set<string> }>>();

/**
 * A bare Java call — `verify(mock)`, `helper()`, `this.x()`, `super.x()` —
 * reaches a method of a class around it, of one of that class's supertypes, or
 * one the file imports statically. Not some other class's method of that name:
 * halo's tests' Mockito `verify(…)` and `eq(…)` bound 1,038 calls to an
 * `EmailVerificationService.verify` and 845 to a builder's `eq`. Supertypes are
 * read from the declarations — the resolved `extends` edges do not exist yet on
 * the first pass.
 */
function isJavaMethodInScope(method: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const cut = method.qualifiedName.lastIndexOf('::');
  if (cut < 0) return true;
  const owner = method.qualifiedName.slice(0, cut).split('::').pop()!;
  const imports = javaStaticImportsOf(ref.filePath, context);
  if (imports.owners.has(owner) || imports.members.has(`${owner}.${ref.referenceName}`)) return true;
  const around = context
    .getNodesInFile(ref.filePath)
    .filter((n) => JAVA_TYPE_KINDS.has(n.kind) && n.startLine <= ref.line && n.endLine >= ref.line);
  const seen = new Set<string>();
  const queue = around.map((n) => n.name);
  while (queue.length > 0 && seen.size < 40) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    if (name === owner) return true;
    queue.push(...javaSupertypesOf(name, context));
  }
  return false;
}

/** The simple names a Java type's declarations extend or implement. */
function javaSupertypesOf(typeName: string, context: ResolutionContext): string[] {
  let memo = JAVA_SUPERS.get(context);
  if (!memo) {
    memo = new Map();
    JAVA_SUPERS.set(context, memo);
  }
  const hit = memo.get(typeName);
  if (hit) return hit;
  const names: string[] = [];
  for (const decl of context.getNodesByName(typeName)) {
    if (decl.language !== 'java' || !JAVA_TYPE_KINDS.has(decl.kind)) continue;
    const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
    const head = lines.slice(decl.startLine - 1, decl.startLine + 5).join(' ');
    const clause = /\b(?:extends|implements)\b([^{]*)\{/.exec(head)?.[1] ?? '';
    const flat = clause.replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, '');
    for (const m of flat.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g)) {
      const simple = m[1]!.split('.').pop()!;
      if (simple !== 'extends' && simple !== 'implements') names.push(simple);
    }
  }
  memo.set(typeName, names);
  return names;
}

/** A Java file's `import static a.b.Owner.member;` / `import static a.b.Owner.*;`. */
function javaStaticImportsOf(filePath: string, context: ResolutionContext): { owners: Set<string>; members: Set<string> } {
  let memo = JAVA_STATIC_IMPORTS.get(context);
  if (!memo) {
    memo = new Map();
    JAVA_STATIC_IMPORTS.set(context, memo);
  }
  const hit = memo.get(filePath);
  if (hit) return hit;
  const found = { owners: new Set<string>(), members: new Set<string>() };
  const text = context.readFile(filePath) ?? '';
  for (const m of text.matchAll(/^\s*import\s+static\s+([\w.$]+)\s*\.\s*(\*|[\w$]+)\s*;/gm)) {
    const owner = m[1]!.split('.').pop()!;
    if (m[2] === '*') found.owners.add(owner);
    else found.members.add(`${owner}.${m[2]}`);
  }
  memo.set(filePath, found);
  return found;
}

const DART_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'enum', 'mixin', 'extension', 'struct', 'trait']);
const DART_SUPERS = new WeakMap<ResolutionContext, Map<string, string[]>>();

/**
 * Whether a bare Dart call can reach `method`: only a method of the class it
 * is written in, or of what that class extends, mixes in or implements (an
 * extension's `on` type included). riverpod's tests' `test(…)` — package:test's
 * function — went to `ProviderContainer.test` 2,360 times; shelf's `expect(…)`
 * to a test handler's `expect` method. Outside any class (`main`), no method.
 */
function isDartMethodInScope(method: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  return dartMemberDepth(method, ref, context) < Infinity;
}

/**
 * How many supertype steps separate the class a Dart call is written in from
 * `method`'s owner: 0 for its own member, Infinity when the owner is not in
 * its hierarchy at all. An extension's member is in scope when the extension
 * is `on` a type of that hierarchy — a bare `requireElement()` inside a
 * notifier is `this.requireElement()`, the `on AnyNotifier` extension's — and
 * ranks after every real member, as Dart resolves it.
 */
function dartMemberDepth(method: Node, ref: UnresolvedRef, context: ResolutionContext): number {
  const cut = method.qualifiedName.lastIndexOf('::');
  if (cut < 0) return 0;
  const owner = method.qualifiedName.slice(0, cut).split('::').pop()!;
  const hierarchy = dartHierarchyAt(ref, context);
  const own = hierarchy.get(owner);
  if (own !== undefined) return own;
  const decl = context
    .getNodesInFile(method.filePath)
    .find((n) => n.name === owner && DART_TYPE_KINDS.has(n.kind) && n.startLine <= method.startLine && n.endLine >= method.endLine);
  if (!decl) return Infinity;
  const head = dartHeadOf(decl, context);
  if (!head.extension) return Infinity;
  const on = Math.min(...head.supers.map((t) => hierarchy.get(t) ?? Infinity));
  return on === Infinity ? Infinity : DART_EXTENSION_RANK + on;
}

/** Past any real member's depth: an extension member only applies when no instance member does. */
const DART_EXTENSION_RANK = 1000;
const DART_HIERARCHIES = new WeakMap<ResolutionContext, WeakMap<UnresolvedRef, Map<string, number>>>();

/** Every type the classes around a Dart call site are, by supertype distance (at most 40). */
function dartHierarchyAt(ref: UnresolvedRef, context: ResolutionContext): Map<string, number> {
  let memo = DART_HIERARCHIES.get(context);
  if (!memo) {
    memo = new WeakMap();
    DART_HIERARCHIES.set(context, memo);
  }
  const hit = memo.get(ref);
  if (hit) return hit;
  const depths = new Map<string, number>();
  const queue: Array<[string, number]> = context
    .getNodesInFile(ref.filePath)
    .filter((n) => DART_TYPE_KINDS.has(n.kind) && n.startLine <= ref.line && n.endLine >= ref.line)
    .map((n) => [n.name, 0]);
  while (queue.length > 0 && depths.size < 40) {
    const [name, depth] = queue.shift()!;
    if (depths.has(name)) continue;
    depths.set(name, depth);
    for (const sup of dartSupertypesOf(name, context)) queue.push([sup, depth + 1]);
  }
  memo.set(ref, depths);
  return depths;
}

/**
 * Of the in-scope members a bare Dart call could mean, the nearest: a
 * subclass's override, or the class that implements what an interface only
 * declares. bloc's `emit(…)` in a `Cubit` is `BlocBase.emit`, not the
 * `Emittable` interface's.
 */
function nearestDartMembers(candidates: Node[], ref: UnresolvedRef, context: ResolutionContext): Node[] {
  const members = candidates.filter(isDartMember);
  if (members.length < 2) return candidates;
  const depth = new Map(members.map((n) => [n.id, dartMemberDepth(n, ref, context)]));
  const nearest = Math.min(...depth.values());
  return candidates.filter((n) => !depth.has(n.id) || depth.get(n.id) === nearest);
}

/** A member of a Dart type — a method, or an abstract member written without a body (extracted as a `function` owned by the type). */
function isDartMember(n: Node): boolean {
  return n.kind === 'method' || (n.kind === 'function' && n.qualifiedName.includes('::'));
}

/**
 * Whether a bare Dart reference really is receiver-less at its call site. The
 * extractor keeps one receiver level, so the later links of a chain —
 * `LoginState().withEmail(e).withPassword(p)` — arrive as bare names; their
 * line shows `.withPassword(` all the same. (A Dart ref's column sits just
 * past the name; the name's start is found either way.)
 */
function isReceiverLessDartCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return true;
  const name = ref.referenceName;
  let start = -1;
  if (line.startsWith(name, ref.column)) start = ref.column;
  else if (ref.column >= name.length && line.startsWith(name, ref.column - name.length)) start = ref.column - name.length;
  else start = line.indexOf(name);
  if (start < 0) return true;
  return !/\.\s*$/.test(line.slice(0, start));
}

/** The simple names a Dart type's declarations extend, mix in, implement, or (an extension / mixin) sit `on`. */
function dartSupertypesOf(typeName: string, context: ResolutionContext): string[] {
  let memo = DART_SUPERS.get(context);
  if (!memo) {
    memo = new Map();
    DART_SUPERS.set(context, memo);
  }
  const hit = memo.get(typeName);
  if (hit) return hit;
  const names: string[] = [];
  for (const decl of context.getNodesByName(typeName)) {
    if (decl.language !== 'dart' || !DART_TYPE_KINDS.has(decl.kind)) continue;
    names.push(...dartHeadOf(decl, context).supers);
  }
  memo.set(typeName, names);
  return names;
}

const DART_HEAD_WORDS: ReadonlySet<string> = new Set(['extends', 'with', 'implements', 'on']);

/**
 * A Dart type declaration's head, read from source up to its body: the
 * supertypes it names, and whether it is an `extension` (whose one supertype
 * is the type it extends). Comments and type arguments are dropped first, so
 * riverpod's `class $NotifierProviderElement< // … NotifierT extends
 * $Notifier<ValueT>, ValueT > extends $ClassProviderElement<…> with
 * ElementWithFuture<…>` reads as `extends $ClassProviderElement with
 * ElementWithFuture`, and `class A = B with C;` as its mixin application.
 */
function dartHeadOf(decl: Node, context: ResolutionContext): { supers: string[]; extension: boolean } {
  const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
  const text = lines
    .slice(decl.startLine - 1, Math.min(decl.endLine, decl.startLine + 40))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  let depth = 0;
  let flat = '';
  for (const ch of text) {
    if (ch === '<') depth++;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (ch === '{' || ch === ';') break;
      flat += ch;
    }
  }
  const keyword = /\b(class|mixin|extension|enum)\b/.exec(flat);
  const head = keyword ? flat.slice(keyword.index) : flat;
  const clause = /(?:\b(?:extends|with|implements|on)\b|=)([\s\S]*)$/.exec(head)?.[1] ?? '';
  return {
    supers: [...clause.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]).filter((w) => !DART_HEAD_WORDS.has(w)),
    extension: keyword?.[1] === 'extension' && !/^extension\s+type\b/.test(head),
  };
}

/**
 * How a bare Rust or Go name is written at its call: `path` after `::` (left
 * to the path strategies), `chained` after a `.` — with the receiver it is
 * written on, call and type arguments dropped — or `bare`. The extractors
 * keep one receiver level, so `sym.filename().map(From::from)` and
 * `child.Flags().String("f", …)` arrive as bare `map` / `String`.
 */
function rustGoCallShape(ref: UnresolvedRef, context: ResolutionContext): { shape: 'path' } | { shape: 'bare' } | { shape: 'chained'; receiver: string } | null {
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split('\n');
  let line = lines?.[ref.line - 1];
  if (line === undefined) return null;
  const name = ref.referenceName;
  const at = new RegExp(`(?<![\\w$])${name}\\s*(?:\\(|::<|!)`);
  let start = line.startsWith(name, ref.column) ? ref.column : -1;
  if (start < 0) {
    const m = at.exec(line);
    start = m ? m.index : -1;
  }
  // A link further down a chain the call's line starts — `bat()\n  .arg(…)\n  .stdout(…)` —
  // is recorded at the chain's first line.
  for (let next = ref.line; start < 0 && lines && next < Math.min(lines.length, ref.line + 20); next++) {
    const m = /^\s*\./.test(lines[next]!) ? at.exec(lines[next]!) : null;
    if (m) {
      // Named after the chain's head: `Command::new("true")` for its `.stdout(…)`.
      if (/^\s*\.\s*$/.test(lines[next]!.slice(0, m.index))) {
        return { shape: 'chained', receiver: rustGoReceiverName(line.trimEnd().replace(/[?;]+$/, '')) };
      }
      line = lines[next]!;
      start = m.index;
    }
  }
  if (start < 0) return null;
  const before = line.slice(0, start);
  if (/::\s*$/.test(before)) return { shape: 'path' };
  if (!/\.\s*$/.test(before)) return { shape: 'bare' };
  return { shape: 'chained', receiver: rustGoReceiverName(before.replace(/\?\s*\.\s*$/, '')) };
}

/**
 * The receiver a Rust / Go `….name(` is written on, as its path and dotted
 * identifiers with arguments dropped — `Command::new("x").short_flag('f')` →
 * `Command::new.short_flag`, a macro `arg!(…)` → `arg`, a Go composite
 * literal `(JSON{data})` → `JSON`. Read backwards to the expression's start.
 */
function rustGoReceiverName(text: string): string {
  let out = '';
  let i = text.replace(/\s*\.\s*$/, '').length - 1;
  const src = text.replace(/\s*\.\s*$/, '');
  while (i >= 0) {
    const ch = src[i]!;
    if (ch === ')' || ch === ']' || ch === '}') {
      const open = ch === ')' ? '(' : ch === ']' ? '[' : '{';
      let depth = 0;
      let j = i;
      for (; j >= 0; j--) {
        if (src[j] === ch) depth++;
        else if (src[j] === open && --depth === 0) break;
      }
      if (j < 0) return '';
      // `(JSON{data})` — a parenthesized composite literal names its type.
      if (ch === ')' && out === '') {
        const literal = /^\(\s*&?\s*([A-Za-z_][\w.]*)\s*\{/.exec(src.slice(j, i + 1));
        if (literal) return literal[1]!;
      }
      i = j - 1;
    } else if (/[\w$.:!]/.test(ch)) {
      if (ch !== '!') out = ch + out;
      i--;
    } else break;
  }
  return out.replace(/^[.:]+|[.:]+$/g, '');
}

/**
 * Whether a Rust / Go call of that shape can mean `n`. A bare call never
 * reaches a method (Rust needs `self.` / `Type::`, Go a receiver): axum's
 * routing `get(handler)` went to a cookie jar's `get`. A chained call reaches
 * a method of what its receiver is named after (or of `self`), never a free
 * function: tokio's `sym.filename().map(…)` went to `MutexGuard::map` 156
 * times, cobra's `c.Flags().String(…)` to a test type's `String`.
 */
function isRustGoCallTarget(n: Node, shape: ReturnType<typeof rustGoCallShape>): boolean {
  if (!shape || shape.shape === 'path') return true;
  const member = n.kind === 'method';
  if (shape.shape === 'bare') return !member;
  if (!member) return n.kind !== 'function';
  // A name the standard library's own types all carry (`unwrap`, `clone`,
  // `iter`, Go's `String` / `Get`) needs a receiver named after the owner; a
  // project-specific one keeps its match — clap's `flag("n").short('n')` is
  // `Arg::short`, cobra's `c.Root().Name()` `Command::Name`.
  // Go's `w.Header().Get(…)` / `r.Header.Set(…)`: net/http's Header map.
  if (n.language === 'go' && /(?:^|\.)Header$/.test(shape.receiver) && /^(?:Get|Set|Add|Del|Values|Clone|Write)$/.test(n.name)) return false;
  const std = (n.language === 'go' ? GO_STD_METHODS : RUST_STD_METHODS).has(n.name);
  return !std || /^(?:self|Self)$/.test(shape.receiver) || (shape.receiver !== '' && sharesReceiverWord(shape.receiver, n));
}

/**
 * Kotlin's scope functions and standard collection / string / conversion
 * methods: on an untyped chain link (`builder.apply { … }`, `list.map { … }`)
 * they are the standard library's, never a project type's same-named member.
 * Names project types commonly carry (`get`, `write`, `close`, `add`) are left
 * out — okio's `sink.write(…)` is its own Buffer's.
 */
const KOTLIN_STD_METHODS: ReadonlySet<string> = new Set([
  'apply', 'also', 'let', 'run', 'takeIf', 'takeUnless', 'toString', 'equals', 'hashCode', 'map', 'mapNotNull',
  'mapIndexed', 'filter', 'filterNot', 'filterIsInstance', 'forEach', 'forEachIndexed', 'first', 'firstOrNull',
  'last', 'lastOrNull', 'single', 'singleOrNull', 'isEmpty', 'isNotEmpty', 'isNullOrEmpty', 'isNullOrBlank',
  'isBlank', 'isNotBlank', 'orEmpty', 'joinToString', 'toList', 'toMutableList', 'toSet', 'toMutableSet', 'toMap',
  'toTypedArray', 'any', 'all', 'none', 'count', 'sumOf', 'maxOf', 'minOf', 'maxOrNull', 'minOrNull', 'sortedBy',
  'sortedByDescending', 'sorted', 'sortedWith', 'reversed', 'drop', 'dropLast', 'take', 'takeLast', 'zip',
  'flatMap', 'flatten', 'distinct', 'groupBy', 'associate', 'associateBy', 'associateWith', 'partition',
  'contains', 'containsKey', 'getOrElse', 'getOrNull', 'getOrPut', 'getOrDefault', 'trim', 'trimEnd', 'trimStart',
  'split', 'substring', 'startsWith', 'endsWith', 'replace', 'lowercase', 'uppercase', 'toInt', 'toLong',
  'toDouble', 'toFloat', 'toIntOrNull', 'toLongOrNull', 'encodeToByteArray', 'decodeToString',
  'copyOf', 'copyOfRange', 'indexOf', 'lastIndexOf', 'withIndex', 'asSequence', 'asList', 'ifEmpty', 'ifBlank',
  'padStart', 'padEnd', 'repeat', 'lines', 'toCharArray', 'coerceAtLeast', 'coerceAtMost', 'coerceIn',
]);

/**
 * Methods of .NET's base types, collections, streams, strings, LINQ and
 * reflection — names a project type overrides or wraps, which a call through
 * an untyped receiver means only when the receiver is named after the owner.
 * Newtonsoft's `reader.Value.ToString()` went to its JValue's `ToString`,
 * `table.Columns.Add(…)` to a name table's `Add`.
 */
const CSHARP_STD_METHODS: ReadonlySet<string> = new Set([
  'ToString', 'Equals', 'GetHashCode', 'GetType', 'CompareTo', 'Add', 'AddRange', 'Remove', 'RemoveAt', 'RemoveAll',
  'Contains', 'ContainsKey', 'ContainsValue', 'Clear', 'Insert', 'IndexOf', 'CopyTo', 'ToArray', 'ToList',
  'ToDictionary', 'GetEnumerator', 'MoveNext', 'Reset', 'TryGetValue', 'GetValueOrDefault', 'TryAdd', 'Write',
  'WriteLine', 'WriteAsync', 'WriteLineAsync', 'Read', 'ReadAsync', 'ReadLine', 'ReadToEnd', 'Flush', 'FlushAsync',
  'Close', 'Dispose', 'DisposeAsync', 'Parse', 'TryParse', 'Format', 'Join', 'Split', 'Replace', 'Substring', 'Trim',
  'TrimStart', 'TrimEnd', 'StartsWith', 'EndsWith', 'ToUpper', 'ToLower', 'ToUpperInvariant', 'ToLowerInvariant',
  'Select', 'Where', 'First', 'FirstOrDefault', 'Single', 'SingleOrDefault', 'Last', 'LastOrDefault', 'Any', 'All',
  'Count', 'Sum', 'Max', 'Min', 'OrderBy', 'OrderByDescending', 'GroupBy', 'Skip', 'Take', 'Distinct', 'Concat',
  'Cast', 'OfType', 'Aggregate', 'Invoke', 'DynamicInvoke', 'GetMethod', 'GetProperty', 'GetField', 'GetConstructor',
  'GetCustomAttributes', 'GetGenericArguments', 'MakeGenericType', 'IsAssignableFrom', 'ConfigureAwait', 'Wait',
  'ContinueWith', 'Append', 'AppendLine', 'Peek', 'Push', 'Pop', 'Enqueue', 'Dequeue', 'HasFlag', 'Find', 'FindAll',
  'ForEach', 'Sort', 'Reverse', 'Clone', 'Seek', 'SetLength',
]);

/**
 * A request handler the web framework dispatches to: a Django / DRF / Flask
 * view's `get` / `post` / …, a controller's `index` / `store` / `update` /
 * `destroy`. Nothing calls one through an instance by name, so a guess from
 * a Django test's `client.post(…)` (allauth: 425 times on a
 * ClientRegistrationView) or an Eloquent `$page->update(…)` is never one.
 */
const DISPATCHED_OWNER = /(?:View|ViewSet|APIView|Controller|Endpoint|ViewMixin)$/;
const DISPATCHED_ACTIONS: ReadonlySet<string> = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'index', 'show', 'store', 'update', 'destroy',
  'create', 'edit', 'list', 'retrieve', 'partial_update',
]);

/** A test double's name: Fake…, Mock…, Stub…, Dummy…, Spy…, …Fake, …Mock, …Stub. */
const TEST_DOUBLE_OWNER = /\b(?:fake|mock|mocked|stub|dummy|spy)\b/i;

/** A method of a test double (`MockedResponse`, `_FakeHTTPResponse`) the receiver and the calling file never name. */
function isUnnamedTestDouble(method: Node, receiver: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const cut = method.qualifiedName.lastIndexOf('::');
  if (cut <= 0) return false;
  const owner = method.qualifiedName.slice(0, cut).split(/::|\./).pop()!;
  if (!TEST_DOUBLE_OWNER.test(splitCamelCase(owner).join(' '))) return false;
  if (splitCamelCase(receiverLink(receiver)).some((w) => TEST_DOUBLE_OWNER.test(w))) return false;
  return !(context.readFile(ref.filePath) ?? '').includes(owner);
}

/**
 * The link of a dotted receiver its value is named after: the last, or for a
 * constant (`InitializationPhase.CONTROLLERS`, `Foo.INSTANCE`) the type it
 * belongs to.
 */
function receiverLink(receiver: string): string {
  const links = receiver.split('.');
  const last = links[links.length - 1]!;
  return links.length > 1 && /^[A-Z][A-Z0-9_]+$/.test(last) ? links[links.length - 2]! : last;
}

/** The standard-library method names of a language whose receiver-less guesses need the receiver to name the owner. */
function stdMethodNames(language: string): ReadonlySet<string> | null {
  switch (language) {
    case 'go': return GO_STD_METHODS;
    case 'rust': return RUST_STD_METHODS;
    case 'kotlin': return KOTLIN_STD_METHODS;
    case 'csharp': return CSHARP_STD_METHODS;
    case 'dart': return DART_STD_METHODS;
    default: return null;
  }
}

/** Methods of Dart's String, List, Iterable, Map and Set — names a project type rarely carries itself. */
const DART_STD_METHODS: ReadonlySet<string> = new Set([
  'endsWith', 'startsWith', 'contains', 'split', 'substring', 'trim', 'trimLeft', 'trimRight', 'toLowerCase',
  'toUpperCase', 'replaceAll', 'replaceFirst', 'replaceRange', 'indexOf', 'lastIndexOf', 'padLeft', 'padRight',
  'codeUnitAt', 'allMatches', 'firstMatch', 'hasMatch', 'addAll', 'removeAt', 'removeWhere', 'removeLast',
  'retainWhere', 'insertAll', 'where', 'whereType', 'forEach', 'toList', 'toSet', 'join', 'reduce', 'fold',
  'any', 'every', 'firstWhere', 'lastWhere', 'singleWhere', 'containsKey', 'containsValue', 'putIfAbsent',
  'sublist', 'take', 'takeWhile', 'skip', 'skipWhile', 'expand', 'cast', 'compareTo', 'elementAt', 'followedBy',
  'asMap', 'getRange', 'setAll', 'fillRange', 'shuffle', 'sort', 'indexWhere', 'lastIndexWhere',
]);

/**
 * Whether a receiver is named after the owner of `method` — for a Dart
 * extension, after the type it is `on`: getx's `ext.endsWith(".avi")` on a
 * String shares a word with `RxStringExt`, none with its `Rx<String>`.
 */
function receiverNamesOwner(receiver: string, method: Node, context: ResolutionContext): boolean {
  if (method.language === 'dart') {
    const cut = method.qualifiedName.lastIndexOf('::');
    const owner = cut > 0 ? method.qualifiedName.slice(0, cut).split('::').pop()! : '';
    const decl = owner ? context.getNodesByName(owner).find((n) => n.language === 'dart' && n.filePath === method.filePath) : undefined;
    const line = decl ? (context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [])[decl.startLine - 1] ?? '' : '';
    const on = /\bextension\s+\w*\s*(?:<[^>]*>)?\s*on\s+([\w<>, ?]+?)\s*\{/.exec(line)?.[1];
    if (on) return sharesReceiverWord(receiver, { ...method, qualifiedName: `${on.replace(/[<>, ?]+/g, '')}::${method.name}` });
  }
  return sharesReceiverWord(receiver, method);
}

const CSHARP_ALIASES = new WeakMap<ResolutionContext, Map<string, Map<string, string>>>();

/**
 * The type a C# file's `using Name = Some.Namespace.Type;` (or `global using`)
 * aliases `name` to, as its simple name — or null.
 */
function csharpUsingAlias(name: string, ref: UnresolvedRef, context: ResolutionContext): string | null {
  if (!/^[A-Za-z_]\w*$/.test(name)) return null;
  let memo = CSHARP_ALIASES.get(context);
  if (!memo) {
    memo = new Map();
    CSHARP_ALIASES.set(context, memo);
  }
  let aliases = memo.get(ref.filePath);
  if (!aliases) {
    aliases = new Map();
    const source = context.readFile(ref.filePath) ?? '';
    for (const m of source.matchAll(/^\s*(?:global\s+)?using\s+([A-Za-z_]\w*)\s*=\s*(?:global::)?([\w.]+)\s*(?:<[^;>]*>)?\s*;/gm)) {
      aliases.set(m[1]!, m[2]!.split('.').pop()!);
    }
    memo.set(ref.filePath, aliases);
  }
  return aliases.get(name) ?? null;
}

/** The receiver a Kotlin chain link `….name(` / `?.name {` is written on, or null for a call with none. */
function kotlinChainReceiver(ref: UnresolvedRef, context: ResolutionContext): string | null {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return null;
  const name = ref.referenceName;
  let start = line.startsWith(name, ref.column) ? ref.column : -1;
  if (start < 0) {
    const m = new RegExp(`(?<![\\w$])${name}\\s*[({]`).exec(line);
    start = m ? m.index : -1;
  }
  if (start < 0) {
    // An infix call on an expression — `alias(libs.x) apply false` — whose
    // receiver the extractor could not name.
    const infix = new RegExp(`(?<=[\\w)\\]"'}]\\s+)${name}\\s+(?=[^\\s=])`).exec(line);
    return infix ? rustGoReceiverName(line.slice(0, infix.index).trimEnd()) : null;
  }
  const before = line.slice(0, start);
  if (!/\.\s*$/.test(before)) return null;
  return rustGoReceiverName(before.replace(/\?\s*\.\s*$/, '').replace(/!!\s*$/, ''));
}

const KOTLIN_BITWISE_INFIX: ReadonlySet<string> = new Set(['and', 'or', 'xor', 'shl', 'shr', 'ushr', 'inv']);
const KOTLIN_NUMBER_TYPES: ReadonlySet<string> = new Set(['Byte', 'Short', 'Int', 'Long', 'UByte', 'UShort', 'UInt', 'ULong', 'Char']);

/**
 * A project's bitwise extension on a number type — okio's `infix fun
 * Byte.and(mask: Int)` — is indistinguishable, without the operand's type,
 * from the standard library's own `Int.and` / `Long.shr` members every other
 * `x and 0xff` / `h shr 8` calls; neither is a safe edge.
 */
function isKotlinNumberBitwise(n: Node, ref: UnresolvedRef): boolean {
  if (ref.language !== 'kotlin' || !KOTLIN_BITWISE_INFIX.has(n.name)) return false;
  const cut = n.qualifiedName.lastIndexOf('::');
  return cut > 0 && KOTLIN_NUMBER_TYPES.has(n.qualifiedName.slice(0, cut).split(/::|\./).pop()!);
}

/** Whether a bare Kotlin name is written with no receiver at its call — not a later link of a chain (`….name(`). */
function isReceiverLessKotlinCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return false;
  const name = ref.referenceName;
  let start = line.startsWith(name, ref.column) && !/[\w$]/.test(line[ref.column - 1] ?? '') ? ref.column : -1;
  if (start < 0) {
    const m = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}\\s*[({<]`).exec(line);
    start = m ? m.index : -1;
  }
  return start >= 0 && !/[.:]\s*$/.test(line.slice(0, start));
}

/**
 * Whether a bare `require(…)` / `check(…)` / `assert(…)` is Kotlin's
 * precondition: its condition is a comparison or boolean expression, or a
 * lazy message follows it.
 */
function isKotlinPreconditionCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (!/^(?:require|check|assert)$/.test(ref.referenceName)) return false;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  const at = line ? new RegExp(`(?<![\\w.])${ref.referenceName}\\s*\\(`).exec(line) : null;
  if (!line || !at) return false;
  let depth = 0;
  let args = '';
  let rest = '';
  for (let i = at.index + at[0].length; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '(') depth++;
    else if (ch === ')' && depth-- === 0) {
      rest = line.slice(i + 1);
      break;
    }
    args += ch;
  }
  return /[<>=!]=|&&|\|\||(?:^|[\s(])!|\s[<>]\s|\bis\b|\bin\b|\btrue\b|\bfalse\b/.test(args) || /^\s*\{/.test(rest);
}

const KOTLIN_RECEIVER_TYPES = new WeakMap<ResolutionContext, Set<string>>();

/**
 * Every type a Kotlin function type in the project takes as its receiver —
 * `Module` in `typealias ModuleDeclaration = Module.() -> Unit`, `Scope` in
 * `Scope.(ParametersHolder) -> T`, `JdbcTransaction` in `statement:
 * JdbcTransaction.(TestDB) -> Unit`. A lambda of such a type runs with that
 * receiver, so a bare call inside one reaches its members.
 */
function kotlinReceiverTypes(context: ResolutionContext): Set<string> {
  const hit = KOTLIN_RECEIVER_TYPES.get(context);
  if (hit) return hit;
  const types = new Set<string>();
  const outside = new Set<string>();
  for (const file of context.getAllFiles()) {
    if (!/\.kts?$/.test(file)) continue;
    const source = stripCommentsForRegex(context.readFile(file) ?? '', 'java');
    for (const m of source.matchAll(/\b([A-Z]\w*)(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?\s*\.\s*\(/g)) types.add(m[1]!);
    // An extension on a type from outside the project (`fun
    // MacrobenchmarkScope.waitForContent()`, `fun StringBuilder.padInt(…)`)
    // is written to be called inside that library's lambdas.
    for (const m of source.matchAll(/\bfun\s+(?:<[^>]*>\s*)?([A-Z]\w*(?:\.[A-Z]\w*)*)(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?\??\.[A-Za-z_`][\w`]*\s*\(/g)) {
      for (const part of m[1]!.split('.')) outside.add(part);
    }
  }
  for (const name of outside) {
    if (!context.getNodesByName(name).some((n) => MEMBER_CLASS_KINDS.has(n.kind) && (n.language === 'kotlin' || n.language === 'java'))) types.add(name);
  }
  // A receiver's members include those it inherits: Exposed's `mergeFrom`
  // body runs on a MergeTableStatement, whose `whenMatchedDelete` is
  // MergeStatement's.
  const queue = [...types];
  while (queue.length > 0 && types.size < 5000) {
    const name = queue.shift()!;
    for (const decl of context.getNodesByName(name)) {
      if (decl.language !== 'kotlin' || !MEMBER_CLASS_KINDS.has(decl.kind)) continue;
      for (const sup of classHeadSupertypes(decl, context)) {
        if (!types.has(sup)) {
          types.add(sup);
          queue.push(sup);
        }
      }
    }
  }
  KOTLIN_RECEIVER_TYPES.set(context, types);
  return types;
}

/**
 * What the Android framework and AndroidX classes a Kotlin class commonly
 * extends inherit, so an extension on `ComponentCallbacks` or
 * `ComponentActivity` is in reach of an `AppCompatActivity` subclass.
 */
const KOTLIN_PLATFORM_SUPERS: Readonly<Record<string, readonly string[]>> = {
  AppCompatActivity: ['FragmentActivity'], FragmentActivity: ['ComponentActivity'],
  ComponentActivity: ['Activity', 'LifecycleOwner', 'ViewModelStoreOwner', 'SavedStateRegistryOwner'],
  Activity: ['ContextThemeWrapper', 'ComponentCallbacks2'], ContextThemeWrapper: ['ContextWrapper'],
  ContextWrapper: ['Context'], Application: ['ContextWrapper', 'ComponentCallbacks2'],
  Service: ['ContextWrapper', 'ComponentCallbacks2'], ComponentCallbacks2: ['ComponentCallbacks'],
  Fragment: ['ComponentCallbacks', 'LifecycleOwner', 'ViewModelStoreOwner', 'SavedStateRegistryOwner'],
  DialogFragment: ['Fragment'], AppCompatDialogFragment: ['DialogFragment'],
  BottomSheetDialogFragment: ['AppCompatDialogFragment'], AndroidViewModel: ['ViewModel'],
};

const KOTLIN_HIERARCHIES = new WeakMap<ResolutionContext, WeakMap<UnresolvedRef, Set<string>>>();

/**
 * The Kotlin types a bare call is written inside — the classes and objects
 * around it and the receiver of the extension function it is in — and what
 * they inherit.
 */
function kotlinHierarchyAt(ref: UnresolvedRef, context: ResolutionContext): Set<string> {
  let memo = KOTLIN_HIERARCHIES.get(context);
  if (!memo) {
    memo = new WeakMap();
    KOTLIN_HIERARCHIES.set(context, memo);
  }
  const hit = memo.get(ref);
  if (hit) return hit;
  const queue: string[] = [];
  for (const n of context.getNodesInFile(ref.filePath)) {
    if (n.startLine > ref.line || n.endLine < ref.line) continue;
    if (MEMBER_CLASS_KINDS.has(n.kind)) queue.push(n.name);
    // `fun Foo.bar() { baz() }`: Foo is the implicit receiver.
    else if ((n.kind === 'method' || n.kind === 'function') && n.qualifiedName.includes('::')) {
      queue.push(n.qualifiedName.slice(0, n.qualifiedName.lastIndexOf('::')).split(/::|\./).pop()!);
    }
  }
  // A Gradle build script runs on the Project (a settings script on Settings).
  if (ref.filePath.endsWith('.gradle.kts')) queue.push(/(?:^|\/)settings\.gradle\.kts$/.test(ref.filePath) ? 'Settings' : 'Project');
  // The same read from the source's braces, which also sees an anonymous
  // `object : Table("t") { … }` and survives a class the parser lost.
  for (const frame of kotlinBraceFrames(ref.filePath, context)) {
    if (frame.start <= ref.line && frame.end >= ref.line) queue.push(...frame.names);
  }
  const names = new Set<string>();
  while (queue.length > 0 && names.size < 60) {
    const name = queue.shift()!;
    if (names.has(name)) continue;
    names.add(name);
    queue.push(...(KOTLIN_PLATFORM_SUPERS[name] ?? []));
    for (const decl of context.getNodesByName(name)) {
      if (decl.language === 'kotlin' && MEMBER_CLASS_KINDS.has(decl.kind)) queue.push(...classHeadSupertypes(decl, context));
    }
  }
  memo.set(ref, names);
  return names;
}

const KOTLIN_FRAMES = new WeakMap<ResolutionContext, Map<string, Array<{ start: number; end: number; names: string[] }>>>();

/**
 * The type bodies of a Kotlin file by line range, read from its braces: each
 * `class` / `object` / `interface` body with its name and supertypes, an
 * anonymous `object : Base(…)` with its base, and an extension function's
 * body with its receiver type.
 */
function kotlinBraceFrames(file: string, context: ResolutionContext): Array<{ start: number; end: number; names: string[] }> {
  let memo = KOTLIN_FRAMES.get(context);
  if (!memo) {
    memo = new Map();
    KOTLIN_FRAMES.set(context, memo);
  }
  const hit = memo.get(file);
  if (hit) return hit;
  const frames: Array<{ start: number; end: number; names: string[] }> = [];
  const source = blankStringContents(stripCommentsForRegex(context.readFile(file) ?? '', 'java'));
  const stack: Array<{ start: number; names: string[] | null }> = [];
  let line = 1;
  let pending = '';
  for (const ch of source) {
    if (ch === '\n') line++;
    if (ch === '{') {
      // `with(x) {`, `x.apply {`, `x.run {`: a receiver of whatever type x is.
      const scoped = /(?:\bwith\s*\([^{}]*\)|\.\s*(?:apply|run)(?:\s*<[^<>]*>)?)\s*$/.test(pending);
      let names = scoped ? ['*'] : kotlinHeadNames(pending);
      // `single { get() }`: a lambda runs on the receiver its function's parameter type names.
      if (!scoped && (!names || names.length === 0)) {
        const call = /(?:^|[^\w$])([a-z_]\w*)\s*(?:<[^<>{}]*>)?\s*(?:\([^(){}]*\))?\s*$/.exec(pending)?.[1];
        const receiver = call && !KOTLIN_BLOCK_WORDS.has(call) ? kotlinLambdaReceiver(call, context) : null;
        if (receiver) names = [receiver];
      }
      stack.push({ start: line, names });
      pending = '';
    } else if (ch === '}') {
      const open = stack.pop();
      if (open?.names && open.names.length > 0) frames.push({ start: open.start, end: line, names: open.names });
      pending = '';
    } else if (ch === ';') pending = '';
    else if (pending.length < 600) pending += ch;
    else pending = pending.slice(300) + ch;
  }
  memo.set(file, frames);
  return frames;
}

/** Words before a `{` that open a block, not a lambda argument. */
const KOTLIN_BLOCK_WORDS: ReadonlySet<string> = new Set([
  'if', 'else', 'for', 'while', 'do', 'when', 'try', 'catch', 'finally', 'init', 'get', 'set', 'constructor',
  'fun', 'class', 'object', 'interface', 'return', 'by', 'lazy', 'apply', 'run', 'also', 'let', 'with', 'use',
]);

const KOTLIN_LAMBDA_RECEIVERS = new WeakMap<ResolutionContext, Map<string, string | null>>();

/**
 * The receiver a lambda passed to the project's `name` runs with: the type
 * before `.(` in its last parameter's function type, directly or through a
 * typealias — koin's `single(…, definition: Definition<T>)` with `typealias
 * Definition<T> = Scope.(ParametersHolder) -> T` runs its lambda on a Scope.
 * Null unless every `name` agrees.
 */
function kotlinLambdaReceiver(name: string, context: ResolutionContext): string | null {
  let memo = KOTLIN_LAMBDA_RECEIVERS.get(context);
  if (!memo) KOTLIN_LAMBDA_RECEIVERS.set(context, (memo = new Map()));
  if (memo.has(name)) return memo.get(name)!;
  const receiverOf = (type: string, depth: number): string | null => {
    const direct = /^\s*(?:suspend\s+)?([A-Z]\w*)(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?\s*\.\s*\(/.exec(type);
    if (direct) return direct[1]!;
    const alias = /^\s*([A-Z]\w*)\b/.exec(type)?.[1];
    if (!alias || depth > 2) return null;
    for (const decl of context.getNodesByName(alias)) {
      if (decl.language !== 'kotlin' || decl.kind !== 'type_alias') continue;
      const text = (context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [])[decl.startLine - 1] ?? '';
      const rhs = /=\s*(.+)$/.exec(text)?.[1];
      if (rhs) return receiverOf(rhs, depth + 1);
    }
    return null;
  };
  const found = new Set<string>();
  for (const fn of context.getNodesByName(name)) {
    if (fn.language !== 'kotlin' || (fn.kind !== 'function' && fn.kind !== 'method')) continue;
    const lines = context.getFileLines?.(fn.filePath) ?? context.readFile(fn.filePath)?.split(/\r?\n/) ?? [];
    const head = lines.slice(fn.startLine - 1, fn.startLine + 11).join(' ');
    const open = head.search(new RegExp(`\\b${name}\\s*\\(`));
    if (open < 0) continue;
    let depth = 0;
    let end = -1;
    for (let i = head.indexOf('(', open); i < head.length; i++) {
      if (head[i] === '(') depth++;
      else if (head[i] === ')' && --depth === 0) { end = i; break; }
    }
    if (end < 0) continue;
    const params = splitCppTopLevel(head.slice(head.indexOf('(', open) + 1, end));
    const last = params[params.length - 1];
    const type = last ? /:\s*([\s\S]+?)(?:\s*=\s*[^=>][\s\S]*)?$/.exec(last.replace(/^\s*(?:noinline|crossinline)\s+/, ''))?.[1] : undefined;
    const receiver = type ? receiverOf(type, 0) : null;
    if (receiver) found.add(receiver);
  }
  const result = found.size === 1 ? [...found][0]! : null;
  memo.set(name, result);
  return result;
}

/** The type names a Kotlin block head introduces: a type declaration's name and supertypes, or an extension function's receiver. */
function kotlinHeadNames(head: string): string[] | null {
  let depth = 0;
  let flat = '';
  for (const ch of head) {
    if (ch === '<' || ch === '(') depth++;
    else if (ch === '>' || ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) flat += ch;
  }
  const decl = /\b(?:class|interface|object)\b(?:\s+([A-Za-z_]\w*))?([^=]*)$/.exec(flat);
  if (decl) {
    const supers = /:\s*([\s\S]*)$/.exec(decl[2] ?? '')?.[1] ?? '';
    const names = [...supers.replace(/\bwhere\b[\s\S]*$/, '').matchAll(/([A-Z]\w*)\s*(?=,|$|\bby\b)/g)].map((m) => m[1]!);
    return decl[1] ? [decl[1], ...names] : names;
  }
  const receiver = /\bfun\s+(?:<[^>]*>\s*)?([A-Z]\w*)(?:<[^>]*>)?\??\.[A-Za-z_]\w*\s*\(/.exec(head)?.[1];
  return receiver ? [receiver] : null;
}

/**
 * Whether a bare Kotlin call can reach method `n`: a member of a type around
 * the call or of what it inherits, or of a type the project's function types
 * take as a lambda receiver (a DSL). koin's `error("…")` — Kotlin's — went to
 * a Logger's `error`, and `module { … }` in one test to another test class's
 * private `module`.
 */
function isKotlinMemberReachable(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  // A Gradle script's bare calls — `plugins { }`, `dependencies { }`,
  // `api(projects.core)` — run on the build tool's own types: never a member
  // of a class the project declares (nowinandroid's `Graph.plugins()`, a lint
  // registry's `api` property). Build logic's extensions on Gradle's types
  // (`NamedDomainObjectContainer.createSourceSet(…)`) stay.
  if (ref.filePath.endsWith('.kts')) {
    if (n.kind !== 'method' && n.kind !== 'field' && n.kind !== 'property') return true;
    const cut = n.qualifiedName.lastIndexOf('::');
    const owner = cut > 0 ? n.qualifiedName.slice(0, cut).split(/::|\./).pop()! : '';
    return owner !== '' && !context.getNodesByName(owner).some((c) => isMethodOwnerKind(c) || c.kind === 'module');
  }
  // A Java class's method, too: Kotlin calls it bare only from a subclass or through a static import.
  if (n.kind !== 'method' || (n.language !== 'kotlin' && n.language !== 'java')) return true;
  // `require(n >= 0) { … }`, `check(!closed)`: Kotlin's preconditions, not a
  // member `require(byteCount: Long)` of the type around the call.
  if (isKotlinPreconditionCall(ref, context)) return false;
  const cut = n.qualifiedName.lastIndexOf('::');
  if (cut <= 0) return true;
  const path = n.qualifiedName.slice(0, cut).split(/::|\./);
  let owner = path.pop()!;
  const companion = owner === 'Companion' && path.length > 0;
  if (companion) owner = path.pop()!;
  // A (Java) constructor is the type's, called by its name.
  if (n.name === owner) return true;
  const hierarchy = kotlinHierarchyAt(ref, context);
  if (hierarchy.has('*') || kotlinReceiverTypes(context).has(owner) || hierarchy.has(owner)) return true;
  // `import okio.TestUtil.deepCopy` / `import okio.TestUtil.*` names an object's members.
  const pkg = kotlinFileScope(n.filePath, context).pkg;
  const objectPath = (pkg ? `${pkg}.${owner}` : owner) + (companion ? '.Companion' : '');
  const here = kotlinFileScope(ref.filePath, context);
  return here.imports.has(`${objectPath}.${n.name}`) || here.stars.has(objectPath);
}

/**
 * Of the members a bare Kotlin call can reach, the ones the code around it
 * reaches — its class, an extension's receiver, the lambda it is in — before
 * those only a lambda type somewhere in the project could: koin's `get()` in
 * `Scope.new(…)` is Scope's, not Koin's.
 */
function lexicalKotlinMembers(candidates: Node[], ref: UnresolvedRef, context: ResolutionContext): Node[] {
  if (candidates.length < 2) return candidates;
  const hierarchy = kotlinHierarchyAt(ref, context);
  if (hierarchy.has('*')) return candidates;
  const lexical = candidates.filter((n) => {
    if (n.kind !== 'method') return false;
    const path = n.qualifiedName.slice(0, Math.max(0, n.qualifiedName.lastIndexOf('::'))).split(/::|\./);
    let owner = path.pop() ?? '';
    if (owner === 'Companion') owner = path.pop() ?? '';
    return hierarchy.has(owner);
  });
  return lexical.length > 0 ? lexical : candidates;
}

/** Whether a standard-named Kotlin chain link can mean `n`: only through a receiver named after its owner. */
function isKotlinStdChainTarget(n: Node, receiver: string): boolean {
  if (n.kind !== 'method' && n.kind !== 'function') return true;
  return receiver === 'this' || (receiver !== '' && sharesReceiverWord(receiver, n));
}

/**
 * How a Swift call is written: `bare` (implicit self, or a free function),
 * through `self.` / `super.`, or `chained` on some other receiver. The
 * extractor keeps one receiver level, so `super.init(…)`,
 * `axis.entries.removeAll()` and `min(a, b)` all arrive as bare names.
 */
interface SwiftCallShape {
  shape: 'bare' | 'self' | 'super' | 'chained';
  /** A chained call's receiver, calls and subscripts dropped. */
  receiver: string;
  /** The first argument's label, if any. */
  label: string;
  /** `name[…]`: a subscript of a value, not a call. */
  subscript: boolean;
  /** `URLEncodedFormDecoder().decode(…)`: the type the link before the call constructs. */
  constructed?: string;
}

function swiftCallShape(ref: UnresolvedRef, context: ResolutionContext): SwiftCallShape | null {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return null;
  const name = ref.referenceName;
  let start = line.startsWith(name, ref.column) && !/[\w$]/.test(line[ref.column - 1] ?? '') ? ref.column : -1;
  if (start < 0) {
    const m = new RegExp(`(?<![\\w$])${name}\\s*[({<[]`).exec(line);
    start = m ? m.index : -1;
  }
  if (start < 0) return null;
  const before = line.slice(0, start);
  const after = line.slice(start + name.length);
  const base = { receiver: '', label: '', subscript: /^\s*\[/.test(after) };
  if (!/\.\s*$/.test(before)) return { ...base, shape: 'bare' };
  // `self.m(` — not `self[i].m(` or `self.items.m(`, which are chains.
  const plain = /(?:^|[^\w$.)\]])(self|Self|super)\s*[?!]?\s*\.\s*$/.exec(before)?.[1];
  if (plain) return { ...base, shape: plain === 'super' ? 'super' : 'self' };
  return {
    ...base,
    shape: 'chained',
    receiver: rustGoReceiverName(before.replace(/[?!]\s*\./g, '.')),
    label: /^\s*\(\s*([A-Za-z_]\w*)\s*:(?!:)/.exec(after)?.[1] ?? '',
    constructed: /(?<![\w$.])([A-Z][\w$]*)\s*(?:<[^<>()]*>)?\s*\([^()]*\)\s*[?!]?\s*\.\s*$/.exec(before)?.[1],
  };
}

/** Argument labels the standard library's collection and string methods take. */
const SWIFT_STD_LABELS: ReadonlySet<string> = new Set([
  'contentsOf', 'where', 'by', 'at', 'keepingCapacity', 'separator', 'forKey', 'of', 'into', 'in', 'options',
  'maxSplits', 'omittingEmptySubsequences', 'with', 'after', 'before', 'upTo', 'through', 'offsetBy', 'default',
]);

/**
 * Whether a Swift method's declaration takes the argument label a call gives
 * first (`func contains(jpeg marker: JPEGMarker)` for `data.kf.contains(jpeg:
 * .SOF2)`). Labels are part of a Swift method's name, so one the standard
 * library's namesakes never take identifies the project's.
 */
function swiftDeclaresLabel(n: Node, label: string, context: ResolutionContext): boolean {
  if (label === '' || SWIFT_STD_LABELS.has(label)) return false;
  const lines = context.getFileLines?.(n.filePath) ?? context.readFile(n.filePath)?.split(/\r?\n/) ?? [];
  const head = lines.slice(n.startLine - 1, n.startLine + 3).join(' ');
  return new RegExp(`\\bfunc\\s+${n.name}\\s*(?:<[^>]*>)?\\s*\\(\\s*${label}\\b`).test(head);
}

/**
 * What the standard library's collection types and protocols refine, so a
 * project extension of `Collection` is in reach of a type that conforms to
 * `RandomAccessCollection`. UIKit / AppKit ancestry comes from the
 * Objective-C table.
 */
const SWIFT_STD_SUPERS: Readonly<Record<string, readonly string[]>> = {
  RandomAccessCollection: ['BidirectionalCollection'], BidirectionalCollection: ['Collection'],
  MutableCollection: ['Collection'], RangeReplaceableCollection: ['Collection'], Collection: ['Sequence'],
  LazySequenceProtocol: ['Sequence'], LazyCollectionProtocol: ['Collection', 'LazySequenceProtocol'],
  StringProtocol: ['BidirectionalCollection'],
  Array: ['RandomAccessCollection', 'MutableCollection', 'RangeReplaceableCollection'],
  ArraySlice: ['RandomAccessCollection', 'MutableCollection', 'RangeReplaceableCollection'],
  ContiguousArray: ['RandomAccessCollection', 'MutableCollection', 'RangeReplaceableCollection'],
  String: ['StringProtocol', 'RangeReplaceableCollection'], Substring: ['StringProtocol', 'RangeReplaceableCollection'],
  Dictionary: ['Collection'], Set: ['Collection', 'SetAlgebra'], Range: ['RandomAccessCollection'],
  ClosedRange: ['RandomAccessCollection'],
};

/** Swift declarations a member hangs off: types, protocols, and extensions (extracted as classes). */
const SWIFT_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'enum', 'interface']);
const SWIFT_MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'property', 'field', 'enum_member']);
const SWIFT_DECLS = new WeakMap<ResolutionContext, Map<string, { supers: string[]; projectType: boolean }>>();
const SWIFT_HIERARCHIES = new WeakMap<ResolutionContext, WeakMap<UnresolvedRef, Map<string, number>>>();

/**
 * What the project declares a Swift type as: the supertypes and protocols
 * every declaration and extension of it names, and whether any of them is
 * the type itself rather than an extension of an outside one
 * (`extension Sequence`).
 */
function swiftDeclOf(typeName: string, context: ResolutionContext): { supers: string[]; projectType: boolean } {
  let memo = SWIFT_DECLS.get(context);
  if (!memo) {
    memo = new Map();
    SWIFT_DECLS.set(context, memo);
  }
  const hit = memo.get(typeName);
  if (hit) return hit;
  const system = OBJC_SYSTEM_SUPERS[typeName];
  const info = { supers: [...(SWIFT_STD_SUPERS[typeName] ?? (system ? [system] : []))], projectType: false };
  for (const decl of context.getNodesByName(typeName)) {
    if (decl.language !== 'swift' || !SWIFT_TYPE_KINDS.has(decl.kind)) continue;
    const head = swiftHeadOf(decl, context);
    info.supers.push(...head.supers);
    if (!head.extension) info.projectType = true;
  }
  memo.set(typeName, info);
  return info;
}

/**
 * A Swift declaration's head, read up to its body with comments, attribute
 * arguments and generic parameters dropped: `@objc(ChartViewBase) open class
 * ChartViewBase<T>: NSUIView, ChartDataProvider where T: Equatable {` →
 * NSUIView, ChartDataProvider.
 */
function swiftHeadOf(decl: Node, context: ResolutionContext): { supers: string[]; extension: boolean } {
  const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
  const text = lines
    .slice(decl.startLine - 1, Math.min(decl.endLine, decl.startLine + 20))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  let depth = 0;
  let flat = '';
  for (const ch of text) {
    if (ch === '<' || ch === '(') depth++;
    else if (ch === '>' || ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (ch === '{') break;
      flat += ch;
    }
  }
  const head = /\b(class|struct|enum|protocol|extension|actor)\s+[\w.]+\s*([\s\S]*)$/.exec(flat);
  if (!head) return { supers: [], extension: false };
  const clause = /^:([\s\S]*?)(?:\bwhere\b|$)/.exec(head[2]!.trim())?.[1] ?? '';
  return {
    supers: clause.split(',').map((item) => /([A-Za-z_]\w*)\s*$/.exec(item.trim())?.[1]).filter((w): w is string => !!w),
    extension: head[1] === 'extension',
  };
}

/** The Swift types around a call (depth 0) and what they inherit or conform to, by distance. */
function swiftHierarchyAt(ref: UnresolvedRef, context: ResolutionContext): Map<string, number> {
  let memo = SWIFT_HIERARCHIES.get(context);
  if (!memo) {
    memo = new WeakMap();
    SWIFT_HIERARCHIES.set(context, memo);
  }
  const hit = memo.get(ref);
  if (hit) return hit;
  const depths = new Map<string, number>();
  const queue: Array<[string, number]> = context
    .getNodesInFile(ref.filePath)
    .filter((n) => SWIFT_TYPE_KINDS.has(n.kind) && n.startLine <= ref.line && n.endLine >= ref.line)
    .map((n) => [n.name.split('.').pop()!, 0]);
  while (queue.length > 0 && depths.size < 40) {
    const [name, depth] = queue.shift()!;
    if (depths.has(name)) continue;
    depths.set(name, depth);
    for (const sup of swiftDeclOf(name, context).supers) queue.push([sup, depth + 1]);
  }
  memo.set(ref, depths);
  return depths;
}

/** A Swift type and every supertype and protocol the project says it has. */
function swiftTypeClosure(typeName: string, context: ResolutionContext): Set<string> {
  const seen = new Set<string>();
  const queue = [typeName];
  while (queue.length > 0 && seen.size < 40) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...swiftDeclOf(name, context).supers);
  }
  return seen;
}

/**
 * Of the in-scope members a bare / `self.` / `super.` Swift call could mean,
 * the nearest: the type's own, else its superclass's — Alamofire's
 * `self.cancel()` in a DownloadRequest extension is DownloadRequest's
 * override, not Request's.
 */
function nearestSwiftMembers(candidates: Node[], ref: UnresolvedRef, context: ResolutionContext): Node[] {
  const hierarchy = swiftHierarchyAt(ref, context);
  const depthOf = (n: Node): number | undefined => {
    if (!SWIFT_MEMBER_KINDS.has(n.kind) && n.kind !== 'constant' && n.kind !== 'variable') return undefined;
    const cut = n.qualifiedName.lastIndexOf('::');
    return cut > 0 ? hierarchy.get(n.qualifiedName.slice(0, cut).split(/::|\./).pop()!) : undefined;
  };
  const depths = candidates.map(depthOf).filter((d): d is number => d !== undefined);
  if (depths.length < 2) return candidates;
  const nearest = Math.min(...depths);
  return candidates.filter((n) => {
    const d = depthOf(n);
    return d === undefined || d === nearest;
  });
}

/**
 * Methods of Swift's standard collections, strings and optionals and of
 * Foundation / UIKit views — names a project type rarely carries itself.
 * Ones it often does (`cancel`, `resume`, `store`, `validate`, `load`) are
 * left out: Alamofire's `request.resume()`, Kingfisher's `cache.store(…)`.
 */
const SWIFT_STD_METHODS: ReadonlySet<string> = new Set([
  'append', 'insert', 'remove', 'removeAll', 'removeFirst', 'removeLast', 'removeValue', 'contains', 'map',
  'compactMap', 'flatMap', 'filter', 'reduce', 'forEach', 'sorted', 'sort', 'first', 'last', 'min', 'max',
  'firstIndex', 'lastIndex', 'index', 'enumerated', 'reversed', 'joined', 'split', 'prefix', 'suffix',
  'dropFirst', 'dropLast', 'allSatisfy', 'randomElement', 'shuffled', 'popLast', 'replaceSubrange',
  'replacingOccurrences', 'components', 'trimmingCharacters', 'hasPrefix', 'hasSuffix', 'lowercased',
  'uppercased', 'appending', 'updateValue', 'merge', 'merging', 'union', 'intersection', 'subtracting',
  'formUnion', 'isEqual', 'addSubview', 'removeFromSuperview', 'setNeedsDisplay', 'setNeedsLayout',
  'layoutIfNeeded', 'addGestureRecognizer', 'addTarget', 'addObserver', 'removeObserver', 'eraseToAnyPublisher',
]);

/**
 * Whether a Swift file's declarations are visible from another file as far as
 * separate modules go: one under a `…Tests` directory (SwiftPM's
 * `Tests/VaporTests`, Xcode's `KingfisherTests`) or in a playground only from
 * inside it.
 */
function isSwiftTargetVisible(declFile: string, fromFile: string): boolean {
  const segments = declFile.split('/').slice(0, -1);
  const target = segments.findIndex((seg) => /Tests$|\.playground$/.test(seg));
  if (target < 0) return true;
  const prefix = segments.slice(0, target + 1).join('/') + '/';
  return fromFile.startsWith(prefix);
}

/**
 * Whether a Swift call of that shape can mean `n`. A member reached with no
 * receiver or through `self.` belongs to a type around the call or to what
 * it inherits or conforms to — `super.` to the latter only; top-level code
 * has no implicit self. Charts' `min(a, b)` went to a range type's `min`
 * field, `super.init(…)` to an Objective-C demo's `init` 170 times. A member
 * reached down a longer chain keeps its match unless its name is one the
 * standard types all carry: `axis.entries.removeAll()` is the array's, not
 * a chart data class's (unless the receiver names the owner, or the owner
 * is an outside type the project only extends).
 */
function isSwiftCallTarget(n: Node, shape: SwiftCallShape | null, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (!shape) return true;
  // A global `let` / `var` from another file is subscripted, not called —
  // Charts' `min(a, b)` went to a playground page's `let min = 20.0`.
  if ((n.kind === 'constant' || n.kind === 'variable') && n.filePath !== ref.filePath && !shape.subscript) return false;
  // A test target imports the module it tests, never the reverse.
  if (!isSwiftTargetVisible(n.filePath, ref.filePath)) return false;
  const cut = n.qualifiedName.lastIndexOf('::');
  const owner = cut > 0 ? n.qualifiedName.slice(0, cut).split(/::|\./).pop()! : null;
  if (!SWIFT_MEMBER_KINDS.has(n.kind) && !(owner !== null && (n.kind === 'constant' || n.kind === 'variable'))) {
    if (n.kind !== 'function') return true;
    return shape.shape === 'bare' || owner !== null || (shape.shape === 'chained' && /^[A-Z]/.test(shape.receiver));
  }
  if (owner === null) return true;
  if (shape.shape === 'chained') {
    // A member of what the link before constructs, or of what that inherits:
    // vapor's `URLEncodedFormDecoder().decode(…)` is not a request's private
    // `_URLQueryContainer.decode`, `JSONDecoder().decode(…)` no project type's.
    // (A capitalized C function — realm's `RLMObjectBaseObjectSchema(obj)!` — constructs nothing.)
    if (shape.constructed && !context.getNodesByName(shape.constructed).some((f) => f.kind === 'function')) {
      return swiftTypeClosure(shape.constructed, context).has(owner);
    }
    // A property the type around the call declares with a type — Kingfisher's
    // `var cache: ImageCache!` — is that type: `cache.imageCachedType(…)` is
    // ImageCache's, not a test subclass's override.
    const typed = /^(?:self\.)?[A-Za-z_]\w*$/.test(shape.receiver) ? inferMemberReceiverType(shape.receiver, ref, context) : null;
    if (typed && /^[A-Z]/.test(typed)) return swiftTypeClosure(typed, context).has(owner);
    if (shape.receiver === '' || !SWIFT_STD_METHODS.has(n.name)) return true;
    return sharesReceiverWord(shape.receiver.split('.').pop()!, n) || !swiftDeclOf(owner, context).projectType ||
      swiftDeclaresLabel(n, shape.label, context);
  }
  const depth = swiftHierarchyAt(ref, context).get(owner);
  return depth !== undefined && (shape.shape !== 'super' || depth > 0);
}

/**
 * Methods of Rust's Option / Result / iterators / collections / strings /
 * smart pointers — names a project type rarely carries itself. Ones it often
 * does (`get`, `set`, `insert`, `next`, `call`, `read`) are left out: serde's
 * `Attr::set`, clap's own `get`.
 */
const RUST_STD_METHODS: ReadonlySet<string> = new Set([
  'unwrap', 'unwrap_or', 'unwrap_or_else', 'unwrap_or_default', 'unwrap_err', 'unwrap_unchecked', 'expect',
  'expect_err', 'ok', 'err', 'map', 'map_err', 'map_or', 'map_or_else', 'and_then', 'or_else', 'ok_or',
  'ok_or_else', 'is_some', 'is_none', 'is_ok', 'is_err', 'is_some_and', 'as_ref', 'as_mut', 'as_deref', 'clone',
  'cloned', 'copied', 'iter', 'iter_mut', 'into_iter', 'collect', 'enumerate', 'zip', 'rev', 'chain', 'skip',
  'step_by', 'peekable', 'flat_map', 'filter_map', 'flatten', 'any', 'all', 'len', 'is_empty', 'push', 'push_str',
  'pop', 'extend', 'drain', 'clear', 'retain', 'truncate', 'reserve', 'with_capacity', 'capacity', 'sort',
  'sort_by', 'sort_by_key', 'dedup', 'split_off', 'contains_key', 'to_string', 'to_owned', 'to_vec', 'as_str',
  'as_bytes', 'as_slice', 'as_ptr', 'into', 'try_into', 'borrow', 'borrow_mut', 'deref', 'deref_mut', 'chars',
  'bytes', 'lines', 'starts_with', 'ends_with', 'trim', 'to_lowercase', 'to_uppercase', 'windows', 'chunks',
  'then', 'then_some', 'eq', 'cmp', 'partial_cmp', 'read_to_end', 'read_to_string', 'fetch_add', 'fetch_sub',
  // std::process::Command's pipes and the assert_cmd assertions tests chain
  // onto it (not `arg` / `env`, which clap's own builders carry)
  'current_dir', 'stdout', 'stderr', 'stdin', 'success', 'failure',
]);

/**
 * Methods of Go's standard types and interfaces — `fmt.Stringer`, `error`,
 * `http.ResponseWriter`, `sync` locks, `reflect`, `time`. Ones a project type
 * often carries itself (`Get`, `Set`, `Close`, `Value`, `Next`) are left out:
 * gin's `c.Set(…)` is its Context's.
 */
const GO_STD_METHODS: ReadonlySet<string> = new Set([
  'String', 'Error', 'Unwrap', 'Is', 'As', 'Header', 'WriteHeader', 'WriteString', 'Lock', 'Unlock', 'RLock',
  'RUnlock', 'Err', 'Deadline', 'Int', 'Bool', 'Float64', 'Int64', 'Uint64', 'Bytes', 'Len', 'Cap', 'Seconds',
  'Unix', 'Before', 'After', 'Equal', 'IsNil', 'IsValid', 'Elem', 'NumField', 'Interface', 'Kind',
]);

const SCALA_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'trait', 'interface', 'enum', 'struct', 'module', 'namespace']);
const SCALA_MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'field', 'property', 'variable', 'constant']);
const SCALA_SUPERS = new WeakMap<ResolutionContext, Map<string, string[]>>();
const SCALA_IMPORTS = new WeakMap<ResolutionContext, Map<string, { owners: Set<string>; members: Set<string>; values: Set<string> }>>();

/**
 * Whether a bare Scala name can mean the member `n`, read at its site. Three
 * shapes:
 * - a later link of a chain (`fa.iterator.map(f)` — the extractor keeps one
 *   receiver level, the line still shows the dot): the receiver must be named
 *   after `n`'s owner (`Foo.bar` on object Foo). cats's chained `.map(…)` went
 *   to a lazy-list ops class's `map` 186 times;
 * - a name the enclosing definition binds — a parameter `f: A => B`, a
 *   `val` — is that local: `f(true)` is not a case class's field `f` (396);
 * - otherwise a member of the types around it or their `extends` / `with`
 *   supertypes, of a companion, of the same file, or of an object the file
 *   imports (`import Foo._`, `import Foo.{bar}`).
 */
function isScalaMemberInScope(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return true;
  const name = ref.referenceName;
  const at = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$')}\\b`).exec(line);
  if (!at) return true;
  const before = line.slice(0, at.index);
  if (/\.\s*$/.test(before)) {
    // A later link of a chain: a member of what the receiver is named after,
    // never a package object's function — unless it is an `extension` method.
    if (n.filePath === ref.filePath) return true;
    // A type or object as a chain link (`pkg.Obj(…)`) is named by what holds it:
    // cats' `arbitrary[Int].map { … }` is no call of alleycats' `object map`.
    if (SCALA_TYPE_KINDS.has(n.kind)) {
      // Scala qualified names leave the package out: a top-level type's holder is its file's package.
      const outer = n.qualifiedName.split('::').slice(-2, -1)[0];
      const holder = outer !== undefined ? outer.split('.').pop()!
        : [...(context.readFile(n.filePath) ?? '').matchAll(/^\s*package\s+([\w.]+)\s*$/gm)].pop()?.[1]?.split('.').pop() ?? '';
      return holder !== '' && scalaReceiverName(before).split('.').pop() === holder;
    }
    if (!SCALA_MEMBER_KINDS.has(n.kind)) return n.kind !== 'function' || isScalaExtensionMethod(n, context);
    const receiver = scalaReceiverName(before);
    return receiver !== '' && sharesReceiverWord(receiver, n);
  }
  const local = scalaLocalBinder(name, ref, context);
  if (local) return n.filePath === ref.filePath && n.startLine >= local.startLine && n.endLine <= local.endLine;
  if (!SCALA_MEMBER_KINDS.has(n.kind)) return true;
  const cut = n.qualifiedName.lastIndexOf('::');
  if (cut < 0 || n.filePath === ref.filePath) return true;
  const owner = n.qualifiedName.slice(0, cut).split('::').pop()!;
  const imports = scalaImportsOf(ref.filePath, context);
  if (imports.owners.has(owner) || imports.members.has(`${owner}.${name}`)) return true;
  // `import builder._` brings in a VALUE's members, of a type the file doesn't say.
  if (imports.values.size > 0) return true;
  // An imported object's inherited members: `import sttp.client4._` is
  // `package object client4 extends SttpApi`, so `multipart(…)` is SttpApi's.
  if (scalaImportedSupertypes(ref.filePath, imports, context).has(owner)) return true;
  const around = context
    .getNodesInFile(ref.filePath)
    .filter((t) => SCALA_TYPE_KINDS.has(t.kind) && t.startLine <= ref.line && t.endLine >= ref.line);
  if (around.length === 0) return true;
  const seen = new Set<string>();
  const queue = [...around.map((t) => t.name), ...scalaAnonymousBases(ref, context)];
  while (queue.length > 0 && seen.size < 60) {
    const typeName = queue.shift()!;
    if (seen.has(typeName)) continue;
    seen.add(typeName);
    if (typeName === owner) return true;
    queue.push(...scalaSupertypesOf(typeName, context));
  }
  return false;
}

/**
 * The types an anonymous class around a Scala site instantiates — `new
 * scopt.OptionParser[Config]("scopt") { head("scopt") }` puts OptionParser's
 * members in scope. Read backwards over the open braces above the site.
 */
function scalaAnonymousBases(ref: UnresolvedRef, context: ResolutionContext): string[] {
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split('\n') ?? [];
  const bases: string[] = [];
  let depth = 0;
  for (let i = ref.line - 1; i >= 0 && i >= ref.line - 400; i--) {
    const text = lines[i]!;
    for (let c = text.length - 1; c >= 0; c--) {
      if (text[c] === '}') depth++;
      else if (text[c] === '{') {
        if (depth > 0) { depth--; continue; }
        const head = /\bnew\s+([\w.]+(?:\s*\[[^\]]*\])?(?:\s*\([^)]*\))?(?:\s+with\s+[\w.]+(?:\s*\[[^\]]*\])?)*)\s*$/.exec(text.slice(0, c));
        if (head) for (const m of head[1]!.replace(/\[[^\]]*\]|\([^)]*\)/g, '').split(/\s+with\s+/)) bases.push(m.trim().split('.').pop()!);
      }
    }
  }
  return bases;
}

/**
 * The receiver a Scala `….name` is written on, as its dotted identifiers with
 * call and type arguments dropped: `proc("bash").call()` → `proc`,
 * `Alternative[List].unite` → `Alternative`, `checker.value.onWrite` →
 * `checker.value`. Read backwards to the expression's start.
 */
function scalaReceiverName(before: string): string {
  const text = before.replace(/\s*\.\s*$/, '');
  let out = '';
  let i = text.length - 1;
  while (i >= 0) {
    const ch = text[i]!;
    if (ch === ')' || ch === ']') {
      const open = ch === ')' ? '(' : '[';
      let depth = 0;
      for (; i >= 0; i--) {
        if (text[i] === ch) depth++;
        else if (text[i] === open && --depth === 0) break;
      }
      if (i < 0) return '';
      i--;
    } else if (/[\w$.]/.test(ch)) {
      out = ch + out;
      i--;
    } else break;
  }
  return out.replace(/^\.+|\.+$/g, '');
}

/** Whether a Scala function is declared in an `extension (…)` block. */
function isScalaExtensionMethod(n: Node, context: ResolutionContext): boolean {
  const lines = context.getFileLines?.(n.filePath) ?? context.readFile(n.filePath)?.split('\n') ?? [];
  return lines.slice(Math.max(0, n.startLine - 4), n.startLine).some((l) => /^\s*extension\b/.test(l));
}

/**
 * The definition around a Scala site that binds `name` itself — a parameter, a
 * `val` / `var` / `def`, a lambda or `for` parameter — or null.
 */
function scalaLocalBinder(name: string, ref: UnresolvedRef, context: ResolutionContext): Node | null {
  const nodes = context.getNodesInFile(ref.filePath);
  const innermost = (kinds: ReadonlySet<string>) => nodes
    .filter((f) => kinds.has(f.kind) && f.startLine <= ref.line && f.endLine >= ref.line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
  const fn = innermost(SCALA_FUNCTION_KINDS);
  // A test suite's body runs in its class: `test("…") { forAll { (e: E, f: A => B) => f(1) } }`.
  const scope = fn ?? innermost(SCALA_TYPE_KINDS);
  if (!scope) return null;
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split('\n') ?? [];
  const text = lines.slice(scope.startLine - 1, ref.line).join('\n');
  const n = name.replace(/[$]/g, '\\$');
  const binder = new RegExp(`(?:[(,\\[]\\s*(?:implicit\\s+|using\\s+)?${n}\\s*:)|(?:\\b(?:val|var|def|lazy\\s+val)\\s+${n}\\b)|(?:(?<![\\w$.])${n}\\s*(?:=>|<-))|(?:\\(\\s*${n}\\s*(?:,[^)]*)?\\)\\s*=>)`, 'g');
  if (fn) return binder.test(text) ? fn : null;
  // In a class body, a binder counts only inside a block still open at the site —
  // not a sibling test's `val f`, not the class's own members at its body's depth.
  const blockAt: number[] = new Array(text.length);
  const open: number[] = [];
  let next = 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') { open.push(++next); depth++; }
    else if (ch === '}') { open.pop(); depth--; }
    blockAt[i] = open.length > 1 ? open[open.length - 1]! : 0;
  }
  const live = new Set(open.slice(1));
  for (const m of text.matchAll(binder)) {
    const block = blockAt[m.index!] ?? 0;
    if (block !== 0 && live.has(block)) return scope;
  }
  return null;
}

const SCALA_FUNCTION_KINDS: ReadonlySet<string> = new Set(['method', 'function']);

/** The simple names a Scala type's declarations extend or mix in. */
function scalaSupertypesOf(typeName: string, context: ResolutionContext): string[] {
  let memo = SCALA_SUPERS.get(context);
  if (!memo) SCALA_SUPERS.set(context, (memo = new Map()));
  const hit = memo.get(typeName);
  if (hit) return hit;
  const names: string[] = [typeName];
  for (const decl of context.getNodesByName(typeName)) {
    if (decl.language !== 'scala' || !SCALA_TYPE_KINDS.has(decl.kind)) continue;
    const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
    const text = lines.slice(decl.startLine - 1, decl.startLine + 12).join(' ');
    let depth = 0;
    let flat = '';
    for (const ch of text) {
      if (ch === '[' || ch === '(') depth++;
      else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0) {
        if (ch === '{' || ch === '=') break;
        flat += ch;
      }
    }
    const clause = /\bextends\b(.*)$/.exec(flat)?.[1] ?? '';
    for (const m of clause.matchAll(/([A-Za-z_][\w.]*)/g)) {
      const simple = m[1]!.split('.').pop()!;
      if (simple !== 'with' && simple !== 'derives' && simple !== typeName) names.push(simple);
    }
  }
  memo.set(typeName, names.slice(1));
  return names.slice(1);
}

const SCALA_IMPORTED_SUPERS = new WeakMap<ResolutionContext, Map<string, Set<string>>>();
const SCALA_PACKAGE_OBJECTS = new WeakMap<ResolutionContext, Map<string, string[]>>();

/** `package object client4 extends SttpApi with …` — the graph holds no node for one. */
function scalaPackageObjects(context: ResolutionContext): Map<string, string[]> {
  const hit = SCALA_PACKAGE_OBJECTS.get(context);
  if (hit) return hit;
  const out = new Map<string, string[]>();
  for (const file of context.getAllFiles()) {
    if (!file.endsWith('.scala') || (context.fileContains && !context.fileContains(file, 'package object'))) continue;
    const source = context.readFile(file) ?? '';
    for (const m of source.matchAll(/\bpackage\s+object\s+([\w$]+)\s+extends\s+([^{\n]+)/g)) {
      const names = m[2]!.replace(/\[[^\]]*\]/g, '').split(/\bwith\b/).map((t) => t.trim().split('.').pop()!.replace(/\(.*$/, '').trim()).filter(Boolean);
      out.set(m[1]!, [...(out.get(m[1]!) ?? []), ...names]);
    }
  }
  SCALA_PACKAGE_OBJECTS.set(context, out);
  return out;
}

/** Every supertype of the objects a Scala file imports wholesale (`import Obj._`). */
function scalaImportedSupertypes(file: string, imports: { owners: Set<string> }, context: ResolutionContext): Set<string> {
  let memo = SCALA_IMPORTED_SUPERS.get(context);
  if (!memo) SCALA_IMPORTED_SUPERS.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const seen = new Set<string>();
  // Code in `package sttp.client4` (or under it) sees `package object client4`'s members unimported.
  const packages = [...(context.readFile(file) ?? '').matchAll(/^\s*package\s+([\w.]+)\s*$/gm)].flatMap((m) => m[1]!.split('.'));
  const queue = [...imports.owners, ...packages];
  const packageObjects = scalaPackageObjects(context);
  while (queue.length > 0 && seen.size < 120) {
    const typeName = queue.shift()!;
    for (const sup of [...scalaSupertypesOf(typeName, context), ...(packageObjects.get(typeName) ?? [])]) {
      if (!seen.has(sup)) { seen.add(sup); queue.push(sup); }
    }
  }
  memo.set(file, seen);
  return seen;
}

/** A Scala file's `import a.b.Obj._` / `import a.b.Obj.*` owners and `import a.b.Obj.{x, y}` / `Obj.x` members. */
function scalaImportsOf(file: string, context: ResolutionContext): { owners: Set<string>; members: Set<string>; values: Set<string> } {
  let memo = SCALA_IMPORTS.get(context);
  if (!memo) SCALA_IMPORTS.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const found = { owners: new Set<string>(), members: new Set<string>(), values: new Set<string>() };
  const source = context.readFile(file) ?? '';
  for (const m of source.matchAll(/^\s*import\s+([\w.]+?)\.(?:(_|\*)|\{([^}]*)\}|([\w$]+))\s*$/gm)) {
    const owner = m[1]!.split('.').pop()!;
    // `import builder._` — rooted at a value the file declares, whose type it doesn't say.
    const root = m[1]!.split('.')[0]!;
    if (/^[a-z]/.test(root) && (root === m[1] || new RegExp(`\\b(?:val|var|lazy\\s+val)\\s+${root}\\b|[(,]\\s*${root}\\s*:`).test(source))) {
      found.values.add(owner);
    }
    if (m[2]) found.owners.add(owner);
    else for (const member of (m[3] ?? m[4] ?? '').split(',')) {
      const id = member.trim().split(/\s*=>\s*/)[0]!;
      if (id === '_' || id === '*') found.owners.add(owner);
      else if (id) found.members.add(`${owner}.${id}`);
    }
  }
  memo.set(file, found);
  return found;
}

const CSHARP_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'enum', 'struct', 'record']);
const CSHARP_MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'property', 'field', 'enum_member', 'constant', 'event']);
const CSHARP_SUPERS = new WeakMap<ResolutionContext, Map<string, string[]>>();
const CSHARP_STATIC_USINGS = new WeakMap<ResolutionContext, Map<string, Set<string>>>();

/**
 * Whether a bare C# name — `TestContext`, `Easing`, `Helper()` — can mean the
 * member `n`: C# reads a bare name as a member of the types around it (outer
 * classes included) or of their base types, or of a `using static` type.
 * Never some unrelated class's: eShop's `TestContext.CancellationToken` in
 * one test class went to another test class's `TestContext` property, MAUI's
 * `Easing.Linear` to an animation class's `Easing`. Chain links the line
 * shows a receiver for are not judged.
 */
function isCsharpMemberInScope(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (!CSHARP_MEMBER_KINDS.has(n.kind)) return true;
  const cut = n.qualifiedName.lastIndexOf('::');
  if (cut < 0 || !hasNoReceiverOnLine(ref, context)) return true;
  const owner = n.qualifiedName.slice(0, cut).split(/::|\./).pop()!;
  if (csharpStaticUsings(ref.filePath, context).has(owner)) return true;
  const around = context
    .getNodesInFile(ref.filePath)
    .filter((t) => CSHARP_TYPE_KINDS.has(t.kind) && t.startLine <= ref.line && t.endLine >= ref.line);
  // No type around the name: the declaration wasn't recovered — nothing to judge by.
  if (around.length === 0) return true;
  const seen = new Set<string>();
  const queue = around.map((t) => t.name);
  while (queue.length > 0 && seen.size < 40) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    if (name === owner) return true;
    queue.push(...csharpSupertypesOf(name, context));
  }
  return false;
}

/** The simple names a C# type's declarations (every `partial` one) derive from. */
function csharpSupertypesOf(typeName: string, context: ResolutionContext): string[] {
  let memo = CSHARP_SUPERS.get(context);
  if (!memo) CSHARP_SUPERS.set(context, (memo = new Map()));
  const hit = memo.get(typeName);
  if (hit) return hit;
  const names: string[] = [];
  for (const decl of context.getNodesByName(typeName)) {
    if (decl.language !== 'csharp' || !CSHARP_TYPE_KINDS.has(decl.kind)) continue;
    const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
    let head = lines.slice(decl.startLine - 1, decl.startLine + 8).join(' ');
    head = head.slice(0, (head.indexOf('{') + 1 || head.length + 1) - 1);
    let depth = 0;
    let flat = '';
    for (const ch of head) {
      if (ch === '<' || ch === '(') depth++;
      else if (ch === '>' || ch === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0) flat += ch;
    }
    const bases = new RegExp(`\\b${typeName}\\s*:\\s*(.*?)(?:\\bwhere\\b|$)`).exec(flat)?.[1] ?? '';
    for (const m of bases.matchAll(/([A-Za-z_][\w.]*)/g)) names.push(m[1]!.split('.').pop()!);
  }
  memo.set(typeName, names);
  return names;
}

/**
 * The types a C# file sees through static usings: its own `using static
 * A.B.Type;`, any file's `global using static`, and `<Using Include="A.B.Type"
 * Static="true"/>` in the `.csproj` / `Directory.Build.props` files above it
 * (AutoMapper imports its ExpressionBuilder helpers project-wide that way).
 */
function csharpStaticUsings(file: string, context: ResolutionContext): Set<string> {
  let memo = CSHARP_STATIC_USINGS.get(context);
  if (!memo) CSHARP_STATIC_USINGS.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const owners = new Set<string>(csharpProjectStaticUsings(path.posix.dirname(file), context, memo));
  for (const m of (context.readFile(file) ?? '').matchAll(/^\s*(?:global\s+)?using\s+static\s+([\w.]+)\s*;/gm)) owners.add(m[1]!.split('.').pop()!);
  memo.set(file, owners);
  return owners;
}

/** Static usings that apply to every file under `dir`: project files on the way up, and every `global using static`. */
function csharpProjectStaticUsings(dir: string, context: ResolutionContext, memo: Map<string, Set<string>>): Set<string> {
  const key = `dir:${dir}`;
  const hit = memo.get(key);
  if (hit) return hit;
  let owners: Set<string>;
  if (dir === '.' || dir === '' || dir === '/') {
    owners = new Set();
    for (const f of context.getAllFiles()) {
      if (!f.endsWith('.cs')) continue;
      const text = context.readFile(f) ?? '';
      if (!text.includes('global using static')) continue;
      for (const m of text.matchAll(/^\s*global\s+using\s+static\s+([\w.]+)\s*;/gm)) owners.add(m[1]!.split('.').pop()!);
    }
  } else {
    owners = new Set(csharpProjectStaticUsings(path.posix.dirname(dir), context, memo));
  }
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(path.join(context.getProjectRoot(), dir === '.' ? '' : dir));
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!/\.(?:csproj|props)$/i.test(entry)) continue;
    let text = '';
    try {
      text = fs.readFileSync(path.join(context.getProjectRoot(), dir === '.' ? '' : dir, entry), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/<Using\s+Include\s*=\s*"([\w.]+)"[^>]*\bStatic\s*=\s*"true"/gi)) owners.add(m[1]!.split('.').pop()!);
  }
  memo.set(key, owners);
  return owners;
}

const CSHARP_NAMESPACE_SCOPES = new WeakMap<ResolutionContext, Map<string, { namespaces: string[]; usings: Set<string>; aliases: Map<string, string> }>>();
const CSHARP_PROJECT_USINGS = new WeakMap<ResolutionContext, Map<string, { usings: Set<string>; project: boolean }>>();

/**
 * The namespaces a C# file's code runs in and the ones it imports: its
 * `namespace` declarations, its `using X;`, the `global using X;` of its
 * project's files (every file's, outside any project) and the
 * `<Using Include="X" />` of the project files above it.
 */
function csharpNamespaceScope(file: string, context: ResolutionContext): { namespaces: string[]; usings: Set<string>; aliases: Map<string, string> } {
  let memo = CSHARP_NAMESPACE_SCOPES.get(context);
  if (!memo) CSHARP_NAMESPACE_SCOPES.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const text = stripCommentsForRegex(context.readFile(file) ?? '', 'java');
  const namespaces = [...text.matchAll(/^\s*namespace\s+([\w.]+)/gm)].map((m) => m[1]!);
  let projectMemo = CSHARP_PROJECT_USINGS.get(context);
  if (!projectMemo) CSHARP_PROJECT_USINGS.set(context, (projectMemo = new Map()));
  const project = csharpProjectUsings(path.posix.dirname(file), context, projectMemo);
  const usings = new Set<string>(project.usings);
  if (!project.project) for (const u of csharpGlobalUsings('.', context)) usings.add(u);
  const aliases = new Map<string, string>();
  for (const m of text.matchAll(/^\s*(?:global\s+)?using\s+(?!static\b)(?:([A-Za-z_]\w*)\s*=\s*)?([\w.]+)\s*;/gm)) {
    if (m[1]) aliases.set(m[1], m[2]!);
    else usings.add(m[2]!);
  }
  const scope = { namespaces, usings, aliases };
  memo.set(file, scope);
  return scope;
}

/**
 * The `<Using Include="X" />` of the project files from `dir` up, and the
 * `global using X;` of each project's own files — a global using is its
 * project's alone: serilog's Serilog.Tests and Serilog.PerformanceTests each
 * `global using` their own `Support` namespace, and both define `Some`.
 * `project` says whether a `.csproj` sits at `dir` or above it.
 */
function csharpProjectUsings(dir: string, context: ResolutionContext, memo: Map<string, { usings: Set<string>; project: boolean }>): { usings: Set<string>; project: boolean } {
  const key = dir;
  const hit = memo.get(key);
  if (hit) return hit;
  const root = dir === '.' || dir === '' || dir === '/';
  const parent = root ? null : csharpProjectUsings(path.posix.dirname(dir), context, memo);
  const usings = new Set<string>(parent?.usings ?? []);
  let project = parent?.project ?? false;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(path.join(context.getProjectRoot(), root ? '' : dir));
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!/\.(?:csproj|props)$/i.test(entry)) continue;
    let text = '';
    try {
      text = fs.readFileSync(path.join(context.getProjectRoot(), root ? '' : dir, entry), 'utf8');
    } catch {
      continue;
    }
    if (/\.csproj$/i.test(entry) && !project) {
      project = true;
      for (const u of csharpGlobalUsings(root ? '.' : dir, context)) usings.add(u);
    }
    for (const m of text.matchAll(/<Using\s+Include\s*=\s*"([\w.]+)"(?![^>]*\bStatic\s*=\s*"true")[^>]*>/gi)) usings.add(m[1]!);
    // The SDK's implicit usings (serilog's own `System.TimeProvider` polyfill is seen through them).
    if (/<ImplicitUsings>\s*(?:enable|true)\s*<\/ImplicitUsings>/i.test(text)) {
      for (const ns of CSHARP_IMPLICIT_USINGS) usings.add(ns);
    }
  }
  const result = { usings, project };
  memo.set(key, result);
  return result;
}

const CSHARP_GLOBAL_USINGS = new WeakMap<ResolutionContext, Map<string, Set<string>>>();

/** The `global using X;` of the `.cs` files under `dir` (`.` = the whole repository). */
function csharpGlobalUsings(dir: string, context: ResolutionContext): Set<string> {
  let memo = CSHARP_GLOBAL_USINGS.get(context);
  if (!memo) CSHARP_GLOBAL_USINGS.set(context, (memo = new Map()));
  const hit = memo.get(dir);
  if (hit) return hit;
  const usings = new Set<string>();
  const prefix = dir === '.' ? '' : `${dir}/`;
  for (const f of context.getAllFiles()) {
    if (!f.endsWith('.cs') || !f.startsWith(prefix) || (context.fileContains && !context.fileContains(f, 'global using'))) continue;
    for (const m of (context.readFile(f) ?? '').matchAll(/^\s*global\s+using\s+(?!static\b)([\w.]+)\s*;/gm)) usings.add(m[1]!);
  }
  memo.set(dir, usings);
  return usings;
}

/** The namespaces `<ImplicitUsings>enable</ImplicitUsings>` imports into every file (Microsoft.NET.Sdk). */
const CSHARP_IMPLICIT_USINGS: readonly string[] = [
  'System', 'System.Collections.Generic', 'System.IO', 'System.Linq', 'System.Net.Http', 'System.Threading', 'System.Threading.Tasks',
];

/**
 * Whether a bare C# type name can mean `n` — a type in namespace `N` is seen
 * from `N` and the namespaces inside it, and through a `using N;` —
 * Newtonsoft's `async Task` tests (`using System.Threading.Tasks;`) bound
 * `Task` to a test class of that name in `Newtonsoft.Json.Tests.Schema`, 433
 * times. A type in the global namespace is seen everywhere.
 */
function isCsharpTypeVisible(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const cut = n.qualifiedName.indexOf('::');
  if (cut < 0) return true;
  const ns = n.qualifiedName.slice(0, cut);
  // A nested type (`Outer::Inner`) is judged by its outermost type's namespace.
  const scope = csharpNamespaceScope(ref.filePath, context);
  // `using License = AutoMapper.Licensing.License;` names that type, whatever the file's usings.
  const aliased = scope.aliases.get(ref.referenceName);
  if (aliased !== undefined) return aliased === `${ns}.${n.qualifiedName.slice(cut + 2).replace(/::/g, '.')}`;
  if (scope.namespaces.some((own) => own === ns || own.startsWith(ns + '.'))) return true;
  return scope.usings.has(ns);
}

/**
 * Whether a bare C# name can reach `n` as a nested type: only from inside the
 * type that declares it (any partial part, any depth) or a class deriving from
 * it. AutoMapper's tests each declare their own nested `Source`, and a
 * same-file `new Source()` went to whichever test class came first.
 */
function isCsharpNestedTypeInScope(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const cut = n.qualifiedName.lastIndexOf('::');
  if (cut < 0) return true;
  const owner = n.qualifiedName.slice(0, cut);
  const ownerType = context.getNodesInFile(n.filePath).find((p) => CSHARP_TYPE_KINDS.has(p.kind) && p.qualifiedName === owner);
  // Declared in a namespace, not a type.
  if (!ownerType) return true;
  const enclosing = context.getNodesInFile(ref.filePath)
    .filter((p) => CSHARP_TYPE_KINDS.has(p.kind) && p.startLine <= ref.line && p.endLine >= ref.line);
  if (enclosing.some((p) => p.qualifiedName === owner || p.qualifiedName.startsWith(`${owner}::`))) return true;
  // Inherited: a type around the ref derives from the owner (`class SourceA :
  // Source`), through any partial part — Newtonsoft's JsonTextReader.Async.cs
  // is `partial class JsonTextReader` with no base list, reading JsonReader's `State`.
  return enclosing.some((p) => csharpAncestorNames(p.qualifiedName, context).has(ownerType.name));
}

const CSHARP_ANCESTORS = new WeakMap<ResolutionContext, Map<string, Set<string>>>();

/** The simple names of the C# types `qn` derives from, through every partial part and base, a few levels up. */
function csharpAncestorNames(qn: string, context: ResolutionContext, depth = 0): Set<string> {
  let memo = CSHARP_ANCESTORS.get(context);
  if (!memo) CSHARP_ANCESTORS.set(context, (memo = new Map()));
  const hit = memo.get(qn);
  if (hit) return hit;
  const names = new Set<string>();
  memo.set(qn, names); // a cycle reads what is gathered so far
  for (const decl of context.getNodesByQualifiedName(qn)) {
    if (decl.language !== 'csharp' || !CSHARP_TYPE_KINDS.has(decl.kind)) continue;
    const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
    let header = '';
    for (let i = decl.startLine - 1; i < Math.min(lines.length, decl.startLine + 6) && !header.includes('{'); i++) header += `${lines[i] ?? ''} `;
    const list = /:\s*([^{;]*)/.exec(header.split('{')[0]!.replace(/\bwhere\b[\s\S]*$/, ''))?.[1] ?? '';
    for (const base of splitCppTopLevel(list)) {
      const name = /([A-Za-z_]\w*)\s*(?:<.*)?$/.exec(base.trim())?.[1];
      if (name) names.add(name);
    }
  }
  if (depth < 4) {
    for (const base of [...names]) {
      for (const t of context.getNodesByName(base)) {
        if (t.language !== 'csharp' || !CSHARP_TYPE_KINDS.has(t.kind) || t.qualifiedName === qn) continue;
        for (const up of csharpAncestorNames(t.qualifiedName, context, depth + 1)) names.add(up);
      }
    }
  }
  return names;
}

const OBJC_SUPERS = new WeakMap<ResolutionContext, Map<string, string[]>>();
const OBJC_MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'property', 'field']);

/**
 * How a bare Objective-C name is written at its site: `c-call` for C call
 * syntax (`completionBlock()` — a function, a block or a function pointer,
 * never a method), `self-send` for a message to `self` / `super` /
 * `[self class]`, whose receiver the extractor drops; null otherwise.
 */
function objcCallShape(ref: UnresolvedRef, context: ResolutionContext): 'c-call' | 'self-send' | 'super-send' | null {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return null;
  const name = ref.referenceName.split(':')[0]!;
  if (!name) return null;
  const at = new RegExp(`(?<![\\w.])${name}\\b`, 'g');
  let m: RegExpExecArray | null;
  let shape: 'c-call' | 'self-send' | 'super-send' | null = null;
  while ((m = at.exec(line))) {
    const before = line.slice(0, m.index);
    const after = line.slice(m.index + name.length);
    if (/^\s*\(/.test(after) && !/\[\s*[\w.]+\s+$/.test(before)) shape ??= 'c-call';
    else if (/\[\s*super\s+$/.test(before)) return 'super-send';
    else if (/\[\s*(?:self|\[\s*self\s+class\s*\])\s+$/.test(before)) return 'self-send';
  }
  return shape;
}

/**
 * The classes a message to `self` / `super` can reach: the class it is
 * written in and every class that one inherits from (read from its
 * `@interface Name : Super` declarations; category methods are indexed under
 * the class they extend). Null outside any class.
 */
function objcHierarchyAt(ref: UnresolvedRef, context: ResolutionContext): Set<string> | null {
  const inFile = context.getNodesInFile(ref.filePath);
  let here = inFile
    .filter((c) => c.kind === 'class' && c.startLine <= ref.line && c.endLine >= ref.line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0]?.name;
  // An `@implementation` whose range the index lost still names its class in
  // its methods: `SDWebImageDownloaderDecryptor::initWithBlock:`.
  if (!here) {
    const method = inFile.find((c) => c.kind === 'method' && c.startLine <= ref.line && c.endLine >= ref.line && c.qualifiedName.includes('::'));
    here = method?.qualifiedName.slice(0, method.qualifiedName.lastIndexOf('::'));
  }
  if (!here) return null;
  const seen = new Set<string>();
  const queue = [here];
  while (queue.length > 0 && seen.size < 30) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...objcSupertypesOf(name, context));
  }
  return seen;
}

/**
 * Whether a message to `self` / `super` can mean `n`: a method of a class in
 * the sender's hierarchy — SDWebImage's `[self class]` went to SDWeakProxy's
 * `class` 71 times. When tree-sitter-objc loses an `@implementation`
 * (AFNetworking's AFURLSessionManager) its methods are indexed as functions:
 * one in the sender's own file, or in the file named after a class of its
 * hierarchy, still counts (as does any, when the sender's own class was lost
 * too). A function elsewhere is never what `[super init]` sends to.
 */
function isObjcSelfSendTarget(n: Node, ref: UnresolvedRef, context: ResolutionContext, toSuper = false): boolean {
  const hierarchy = objcHierarchyAt(ref, context);
  if (OBJC_MEMBER_KINDS.has(n.kind)) {
    const cut = n.qualifiedName.lastIndexOf('::');
    if (cut < 0 || hierarchy === null) return true;
    const owner = n.qualifiedName.slice(0, cut);
    // `[super init]` goes past the class it is written in.
    return hierarchy.has(owner) && !(toSuper && owner === [...hierarchy][0]);
  }
  if (n.filePath === ref.filePath) return !toSuper;
  if (hierarchy === null) return true;
  const base = n.filePath.slice(n.filePath.lastIndexOf('/') + 1).replace(/\.\w+$/, '');
  return hierarchy.has(base) && !(toSuper && base === [...hierarchy][0]);
}

/**
 * UIKit / AppKit superclasses, for a category on a system class: an
 * `UIImageView (WebCache)` method sending `[self sd_internalSetImageWithURL:…]`
 * reaches the `UIView (WebCache)` category.
 */
const OBJC_SYSTEM_SUPERS: Readonly<Record<string, string>> = {
  UIResponder: 'NSObject', UIView: 'UIResponder', UIViewController: 'UIResponder', UIWindow: 'UIView',
  UIControl: 'UIView', UIButton: 'UIControl', UITextField: 'UIControl', UISwitch: 'UIControl', UISlider: 'UIControl',
  UISegmentedControl: 'UIControl', UIStepper: 'UIControl', UIPageControl: 'UIControl', UIDatePicker: 'UIControl',
  UIRefreshControl: 'UIControl', UIStackView: 'UIView', UINavigationBar: 'UIView', UIToolbar: 'UIView',
  UITabBar: 'UIView', UISearchBar: 'UIView', UIVisualEffectView: 'UIView', UIActivityIndicatorView: 'UIView',
  UIProgressView: 'UIView', UIPickerView: 'UIView', UITableViewHeaderFooterView: 'UIView',
  UITableViewController: 'UIViewController', UICollectionViewController: 'UIViewController',
  UINavigationController: 'UIViewController', UITabBarController: 'UIViewController',
  UIPageViewController: 'UIViewController', UISplitViewController: 'UIViewController',
  UIAlertController: 'UIViewController', UIHostingController: 'UIViewController',
  UIImageView: 'UIView', UILabel: 'UIView', UIScrollView: 'UIView', UITableView: 'UIScrollView',
  UICollectionView: 'UIScrollView', UITextView: 'UIScrollView', UITableViewCell: 'UIView',
  UICollectionReusableView: 'UIView', UICollectionViewCell: 'UICollectionReusableView',
  MKAnnotationView: 'UIView', MKMapView: 'UIView',
  NSResponder: 'NSObject', NSView: 'NSResponder', NSViewController: 'NSResponder', NSWindow: 'NSResponder',
  NSControl: 'NSView', NSImageView: 'NSControl', NSButton: 'NSControl', NSTextField: 'NSControl', NSTableView: 'NSControl',
};

/**
 * Whether an Objective-C receiver's type owns `method`, in its hierarchy: the
 * receiver names a class (`[AllTypesObject objectsInRealm:…]` — a class
 * method inherited from RLMObject), or is a property one of whose
 * `@property … Type *name` declarations gives such a type
 * (`managed.anyDataObj` → RLMSet, for `containsObject:`).
 */
function objcReceiverReaches(receiver: string, method: Node, context: ResolutionContext): boolean {
  const cut = method.qualifiedName.lastIndexOf('::');
  if (cut < 0) return false;
  const owner = method.qualifiedName.slice(0, cut);
  let types: string[] = [];
  if (/^[A-Z]\w*$/.test(receiver)) {
    if (context.getNodesByName(receiver).some((n) => n.kind === 'class' && n.language === 'objc')) types = [receiver];
  } else if (receiver.includes('.')) types = objcPropertyTypes(receiver.split('.').pop()!, context);
  const seen = new Set<string>();
  const queue = [...types];
  while (queue.length > 0 && seen.size < 40) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    if (name === owner) return true;
    queue.push(...objcSupertypesOf(name, context));
  }
  return false;
}

/** The classes the `@property … Type *name` declarations of `name` give. */
function objcPropertyTypes(name: string, context: ResolutionContext): string[] {
  const types = new Set<string>();
  const decl = new RegExp(`@property\\s*(?:\\([^)]*\\)\\s*)?([A-Z]\\w*)\\s*(?:<[^;]*>\\s*)?\\*\\s*(?:_Nullable\\s+|_Nonnull\\s+)?${name}\\b`);
  for (const n of context.getNodesByName(name)) {
    if (n.kind !== 'property' || n.language !== 'objc') continue;
    const line = context.getFileLines?.(n.filePath)?.[n.startLine - 1] ?? context.readFile(n.filePath)?.split('\n')[n.startLine - 1] ?? '';
    const t = decl.exec(line)?.[1];
    if (t) types.add(t);
  }
  return [...types];
}

/** The superclasses an Objective-C class's `@interface` declarations name. */
function objcSupertypesOf(name: string, context: ResolutionContext): string[] {
  let memo = OBJC_SUPERS.get(context);
  if (!memo) OBJC_SUPERS.set(context, (memo = new Map()));
  const hit = memo.get(name);
  if (hit) return hit;
  const supers: string[] = [];
  for (const decl of context.getNodesByName(name)) {
    if (decl.kind !== 'class' || decl.language !== 'objc') continue;
    const line = context.getFileLines?.(decl.filePath)?.[decl.startLine - 1] ?? context.readFile(decl.filePath)?.split('\n')[decl.startLine - 1] ?? '';
    const sup = /@interface\s+\w+\s*:\s*(\w+)/.exec(line)?.[1];
    if (sup && !supers.includes(sup)) supers.push(sup);
  }
  const system = OBJC_SYSTEM_SUPERS[name];
  if (supers.length === 0 && system) supers.push(system);
  memo.set(name, supers);
  return supers;
}

const VB_MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'property', 'field', 'enum_member', 'constant', 'variable']);

/**
 * What a VB.NET member access is written on, read at the call site: the
 * extractor keeps a call's last name only, so `Me.CMB.Buttons.Add(x)` and
 * `New System.Drawing.Size(1, 2)` arrive as bare `Add` / `Size`. Returns null
 * for a genuinely bare name, `''` for a `With` block's `.Name`, else the
 * text before the dot (`Me.CMB.Buttons`, `System.Drawing`).
 */
function vbReceiverOf(ref: UnresolvedRef, context: ResolutionContext): string | null {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return null;
  const lower = line.toLowerCase();
  const name = ref.referenceName.toLowerCase();
  let start = lower.startsWith(name, ref.column) ? ref.column : -1;
  if (start < 0) {
    const m = new RegExp(`(?<![\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`).exec(lower);
    start = m ? m.index : -1;
  }
  if (start < 0) return null;
  const before = line.slice(0, start);
  const dot = /([\w.()]*?)\s*\.\s*$/.exec(before);
  if (!dot) return null;
  // `GetService(Of TrayNotifierService).Notify()` — the type argument names the receiver.
  const typeArg = /\(\s*Of\s+([\w.]+)\s*\)\s*\.\s*$/i.exec(before);
  if (typeArg) return typeArg[1]!;
  return dot[1]!.replace(/\([^()]*\)/g, '');
}

/**
 * Whether a VB.NET member access can mean `n`: through `Me` / `MyBase` /
 * `MyClass`, or through a name that is `n`'s own type or module
 * (`Module1.Log()`, `Colors.Red`). Any other receiver has a type nothing here
 * names — SCrawler's `New System.Drawing.Size(…)` went to a nested enum's
 * `Size` case 713 times, its designer's `Controls.Add(…)` to a collection
 * class's `Add` 547.
 */
function isVbMemberReachable(n: Node, receiver: string): boolean {
  if (!VB_MEMBER_KINDS.has(n.kind)) return true;
  const cut = n.qualifiedName.lastIndexOf('::');
  if (cut < 0) return true;
  const last = receiver.split('.').pop()!.toLowerCase();
  if (/^(?:me|mybase|myclass)$/.test(last) && !receiver.includes('.')) return true;
  const owner = n.qualifiedName.slice(0, cut).split(/::|\./).pop()!.toLowerCase();
  return last !== '' && last === owner;
}

const CFML_CHAINS = new WeakMap<ResolutionContext, Map<string, Set<string>>>();

/**
 * Whether a bare CFML call written in a component can mean `method`: its own
 * component's, or one of the components it `extends` (read from source — a
 * dotted path matched against the indexed files by its longest suffix). A
 * call in a `.cfm` template is not judged: a ColdBox view runs inside the
 * renderer's scope. coldbox's `now()` — the built-in — went to a date
 * helper's `now` 228 times; chained `.then()` calls arrive bare too, and keep
 * their method.
 */
function isCfmlMethodInScope(method: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (!/\.cfc$/i.test(ref.filePath) || !hasNoReceiverOnLine(ref, context)) return true;
  return cfmlChain(ref.filePath, context).has(method.filePath);
}

/** A component file and every component file it extends. */
function cfmlChain(file: string, context: ResolutionContext): Set<string> {
  let memo = CFML_CHAINS.get(context);
  if (!memo) CFML_CHAINS.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const chain = new Set<string>();
  const queue = [file];
  while (queue.length > 0 && chain.size < 30) {
    const f = queue.shift()!;
    if (chain.has(f)) continue;
    chain.add(f);
    const text = context.readFile(f) ?? '';
    const head = text.slice(0, text.search(/\bfunction\b|<cffunction/i) >>> 0 || text.length);
    const ext = /\bextends\s*=\s*["']?([\w.\/:-]+)["']?/i.exec(head)?.[1];
    if (ext) queue.push(...cfmlComponentFiles(ext, f, context));
  }
  memo.set(file, chain);
  return chain;
}

/** The indexed `.cfc` files a component path names: the same directory first, else the longest path suffix. */
function cfmlComponentFiles(dotted: string, from: string, context: ResolutionContext): string[] {
  const segments = dotted.replace(/\//g, '.').split('.').filter(Boolean);
  const name = segments[segments.length - 1]!.toLowerCase();
  const files = [...new Set(context.getNodesByLowerName(name)
    .filter((n) => n.kind === 'class' && /\.cfc$/i.test(n.filePath))
    .map((n) => n.filePath))];
  if (files.length === 0) return [];
  const dir = from.slice(0, from.lastIndexOf('/') + 1);
  if (segments.length === 1) {
    const local = files.filter((f) => f.slice(0, f.lastIndexOf('/') + 1) === dir);
    return local.length > 0 ? local : files;
  }
  for (let take = segments.length; take >= 1; take--) {
    const suffix = '/' + segments.slice(-take).join('/').toLowerCase() + '.cfc';
    const hits = files.filter((f) => ('/' + f.toLowerCase()).endsWith(suffix));
    if (hits.length > 0) return hits;
  }
  return files;
}

/**
 * Whether a bare reference is receiver-less at its call site, name case
 * aside: the name is not preceded by a `.` on its line (true when the line
 * can't tell). An extractor that keeps one receiver level hands the later
 * links of a chain (`newFuture(f).then(g)`) over bare.
 */
function hasNoReceiverOnLine(ref: UnresolvedRef, context: ResolutionContext): boolean {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (line === undefined) return true;
  const lower = line.toLowerCase();
  const name = ref.referenceName.toLowerCase();
  let start = -1;
  if (lower.startsWith(name, ref.column)) start = ref.column;
  else if (ref.column >= name.length && lower.startsWith(name, ref.column - name.length)) start = ref.column - name.length;
  else start = lower.search(new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`));
  // Not on its line at all: a link of a chain written across lines.
  if (start < 0) return false;
  return !/\.\s*$/.test(line.slice(0, start));
}

const RUBY_ANCESTRY = new WeakMap<ResolutionContext, Map<string, Set<string>>>();

/**
 * Whether a bare Ruby call written inside a class body can mean `method`: a
 * receiver-less call is a call on `self`, so it reaches the class's own
 * methods, its superclasses', and those of the modules any of them
 * `include`s, `extend`s or `prepend`s — read from source, resolved against
 * the lexical nesting (`class Foo < Base` inside `module RuboCop::Cop` is
 * `RuboCop::Cop::Base`). A call in a module body, a block at the top of a
 * file (a spec, a DSL) or a script is not judged: a module's methods run on
 * whatever includes it, and a block may be evaluated on anything. rubocop's
 * `format(…)` — Kernel's — went to the LSP runtime's `format` 411 times.
 */
function isRubyMethodInScope(method: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const cut = method.qualifiedName.lastIndexOf('::');
  if (cut < 0) return true;
  const here = context
    .getNodesInFile(ref.filePath)
    .filter((n) => (n.kind === 'class' || n.kind === 'module') && n.startLine <= ref.line && n.endLine >= ref.line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
  if (!here || here.kind !== 'class') return true;
  return rubyAncestry(here.qualifiedName, context).has(method.qualifiedName.slice(0, cut));
}

/** A Ruby class's qualified name, those of its superclasses, and of every module mixed into any of them. */
function rubyAncestry(qn: string, context: ResolutionContext): Set<string> {
  let memo = RUBY_ANCESTRY.get(context);
  if (!memo) RUBY_ANCESTRY.set(context, (memo = new Map()));
  const hit = memo.get(qn);
  if (hit) return hit;
  const seen = new Set<string>();
  const queue = [qn];
  while (queue.length > 0 && seen.size < 60) {
    const q = queue.shift()!;
    if (seen.has(q)) continue;
    seen.add(q);
    for (const decl of context.getNodesByQualifiedName(q)) {
      if (decl.language !== 'ruby' || (decl.kind !== 'class' && decl.kind !== 'module')) continue;
      const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
      const outer = q.includes('::') ? q.slice(0, q.lastIndexOf('::')) : '';
      const sup = /^\s*class\s+[\w:]+\s*<\s*(::)?([A-Z][\w:]*)/.exec(lines[decl.startLine - 1] ?? '');
      if (sup) queue.push(rubyConstantQn(sup[2]!, sup[1] ? '' : outer, context));
      for (const line of lines.slice(decl.startLine, decl.endLine)) {
        const mix = /^\s*(?:include|extend|prepend)\s+([A-Z:][\w:]*(?:\s*,\s*[A-Z:][\w:]*)*)/.exec(line);
        if (!mix) continue;
        for (const name of mix[1]!.split(/\s*,\s*/)) {
          queue.push(name.startsWith('::') ? rubyConstantQn(name.slice(2), '', context) : rubyConstantQn(name, q, context));
        }
      }
    }
  }
  memo.set(qn, seen);
  return seen;
}

/** The class or module a constant written inside `scope` names: the nearest enclosing namespace that has it, else the name itself. */
function rubyConstantQn(name: string, scope: string, context: ResolutionContext): string {
  for (let prefix = scope; ; prefix = prefix.includes('::') ? prefix.slice(0, prefix.lastIndexOf('::')) : '') {
    const qn = prefix ? `${prefix}::${name}` : name;
    if (context.getNodesByQualifiedName(qn).some((n) => n.language === 'ruby' && (n.kind === 'class' || n.kind === 'module'))) return qn;
    if (!prefix) return name;
  }
}

const KOTLIN_FILE_SCOPES = new WeakMap<ResolutionContext, Map<string, { pkg: string; imports: Set<string>; stars: Set<string> }>>();
/** Packages every Kotlin file imports without writing it. */
const KOTLIN_DEFAULT_IMPORTS: ReadonlySet<string> = new Set([
  'kotlin', 'kotlin.annotation', 'kotlin.collections', 'kotlin.comparisons', 'kotlin.io', 'kotlin.ranges',
  'kotlin.sequences', 'kotlin.text', 'kotlin.jvm', 'java.lang', 'kotlin.js',
]);
const KOTLIN_ENCLOSING_KINDS: ReadonlySet<string> = new Set([
  'class', 'interface', 'enum', 'struct', 'trait', 'protocol', 'module', 'namespace', 'function', 'method',
]);

/** A Kotlin file's `package` and the names and packages its `import`s bring in. */
function kotlinFileScope(file: string, context: ResolutionContext): { pkg: string; imports: Set<string>; stars: Set<string> } {
  let memo = KOTLIN_FILE_SCOPES.get(context);
  if (!memo) KOTLIN_FILE_SCOPES.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const text = (context.readFile(file) ?? '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/`/g, '');
  const pkg = /^\s*package\s+([\w.]+)/m.exec(text)?.[1] ?? '';
  const imports = new Set<string>();
  const stars = new Set<string>();
  for (const m of text.matchAll(/^\s*import\s+([\w.]+?)(\.\*)?(?:\s+as\s+\w+)?\s*;?\s*(?:\/\/.*)?$/gm)) {
    if (m[2]) stars.add(m[1]!);
    else imports.add(m[1]!);
  }
  const scope = { pkg, imports, stars };
  memo.set(file, scope);
  return scope;
}

/**
 * Whether a top-level Kotlin declaration — a function, an extension function
 * (indexed under its receiver type, `JdbcTransaction::assertEquals`), a
 * property — can be named from the file a call is written in: its own
 * package, an `import` of it, or a star import of its package. A member of a
 * class is not judged here; a lambda's receiver can put any type's members in
 * scope. Exposed's tests call `assertEquals(…)` from kotlin.test and JUnit, or
 * import the JDBC suite's extension; the calls went to the R2DBC suite's
 * extension 3,075 times.
 */
function isKotlinTopLevelVisible(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (n.language !== 'kotlin' || n.filePath === ref.filePath) return true;
  const enclosed = context
    .getNodesInFile(n.filePath)
    .some((o) => o.id !== n.id && KOTLIN_ENCLOSING_KINDS.has(o.kind) && o.startLine <= n.startLine && o.endLine >= n.endLine &&
      (o.startLine < n.startLine || o.endLine > n.endLine));
  if (enclosed) return true;
  const pkg = kotlinFileScope(n.filePath, context).pkg;
  const here = kotlinFileScope(ref.filePath, context);
  return pkg === here.pkg || here.stars.has(pkg) || here.imports.has(pkg ? `${pkg}.${n.name}` : n.name) || KOTLIN_DEFAULT_IMPORTS.has(pkg);
}

const PHP_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'trait', 'interface', 'enum']);
const PHP_SUPERS = new WeakMap<ResolutionContext, Map<string, string[]>>();

/**
 * How a bare PHP method name was written at its call site: `$this->m()` /
 * `self::m()` / `static::m()` are the enclosing class's own (or inherited)
 * methods, `parent::m()` an ancestor's; null for anything else.
 */
function phpSelfReceiver(ref: UnresolvedRef, context: ResolutionContext): 'self' | 'parent' | null {
  if (ref.language !== 'php' || ref.referenceKind !== 'calls' || !/^\w+$/.test(ref.referenceName)) return null;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (!line) return null;
  const name = ref.referenceName;
  if (new RegExp(String.raw`\$this\s*\??->\s*${name}\s*\(|\b(?:self|static)\s*::\s*${name}\s*\(`).test(line)) return 'self';
  if (new RegExp(String.raw`\bparent\s*::\s*${name}\s*\(`).test(line)) return 'parent';
  return null;
}

/**
 * Whether `method` belongs to the class the call is written in, one it
 * extends, or a trait any of them uses — read from source, since the
 * resolver's supertype edges don't exist yet on the first pass, and resolved
 * the way PHP resolves a class name: through the file's `namespace` and `use`
 * imports (aliases included) to one fully qualified class. A parent outside
 * the repository (PHPUnit's TestCase, Orchestra's) ends the chain. Drupal's
 * `$this->assertEquals()` is PHPUnit's; it went to the one in-repo
 * `assertEquals`, a comparator's, 8,832 times.
 */
function isPhpMethodInScope(method: Node, ref: UnresolvedRef, via: 'self' | 'parent', context: ResolutionContext): boolean {
  const cut = method.qualifiedName.lastIndexOf('::');
  if (cut < 0) return true;
  const ownerQn = method.qualifiedName.slice(0, cut);
  const enclosing = context
    .getNodesInFile(ref.filePath)
    .filter((n) => PHP_TYPE_KINDS.has(n.kind) && n.startLine <= ref.line && n.endLine >= ref.line)
    .sort((a, b) => b.startLine - a.startLine)[0];
  // Inside a trait, `$this` is whichever class uses it: Laravel's
  // ValidatesAttributes calls the Validator's `getValue()`.
  if (!enclosing || enclosing.kind === 'trait') return true;
  const up = phpAncestry(via === 'parent' ? phpSupertypeQns(enclosing, context) : [enclosing.qualifiedName], context);
  if (up.qns.has(ownerQn)) return true;
  // A base class may call what a subclass defines (BookStack's Entity calls
  // `$this->chapter()`, a Page method): the owner descends from the caller.
  if (via === 'self' && phpAncestry([ownerQn], context).qns.has(enclosing.qualifiedName)) return true;
  // Past an ancestor outside the repository (Orchestra's TestCase) that
  // ancestor's members are unseen — the repository's traits it uses among
  // them. A trait's method may still be the one meant; an unrelated class's
  // (Drupal's comparator `assertEquals`) never is.
  return up.leavesRepo && context.getNodesByQualifiedName(ownerQn).some((d) => d.kind === 'trait');
}

/**
 * Whether a PHP receiver is named after a class that has `method` in its
 * ancestry: `$page->save()` → Page, which extends Entity; `$newRole->users()`
 * → Role. BookStack's `$role->save()` is not Entity's (Role is a Model).
 */
function phpReceiverReaches(receiver: string, method: Node, context: ResolutionContext): boolean {
  const cut = method.qualifiedName.lastIndexOf('::');
  if (cut < 0) return false;
  const owner = method.qualifiedName.slice(0, cut);
  const last = receiver.split('.').pop()!.replace(/^\$/, '');
  if (!last) return false;
  const words = splitCamelCase(last);
  const names = new Set([last, words[words.length - 1] ?? last].map((w) => w.charAt(0).toUpperCase() + w.slice(1)));
  for (const name of names) {
    for (const decl of context.getNodesByName(name)) {
      if (decl.language !== 'php' || !PHP_TYPE_KINDS.has(decl.kind)) continue;
      if (phpAncestry([decl.qualifiedName], context).qns.has(owner)) return true;
    }
  }
  return false;
}

/** Every type `start` reaches through `extends` and trait `use`, and whether it left the repository on the way. */
function phpAncestry(start: readonly string[], context: ResolutionContext): { qns: Set<string>; leavesRepo: boolean } {
  const qns = new Set<string>();
  const queue = [...start];
  let leavesRepo = false;
  while (queue.length > 0 && qns.size < 80) {
    const qn = queue.shift()!;
    if (qns.has(qn)) continue;
    qns.add(qn);
    const decls = context.getNodesByQualifiedName(qn).filter((d) => d.language === 'php' && PHP_TYPE_KINDS.has(d.kind));
    if (decls.length === 0) leavesRepo = true;
    for (const decl of decls) queue.push(...phpSupertypeQns(decl, context));
  }
  return { qns, leavesRepo };
}

const PHP_FILE_SCOPES = new WeakMap<ResolutionContext, Map<string, { namespace: string; uses: Map<string, string> }>>();

/** A PHP file's `namespace` and its `use A\B\C [as D];` imports, alias → fully qualified name. */
function phpFileScope(file: string, context: ResolutionContext): { namespace: string; uses: Map<string, string> } {
  let memo = PHP_FILE_SCOPES.get(context);
  if (!memo) PHP_FILE_SCOPES.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const text = context.readFile(file) ?? '';
  const namespace = /^\s*namespace\s+([\w\\]+)\s*[;{]/m.exec(text)?.[1] ?? '';
  const uses = new Map<string, string>();
  // File-level imports sit before the first type; a trait `use` inside a class body is not one.
  const header = text.slice(0, text.search(/^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|trait|interface|enum)\s/m) >>> 0 || text.length);
  for (const m of header.matchAll(/^\s*use\s+(?:function\s+|const\s+)?([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm)) {
    const fqn = m[1]!.replace(/^\\/, '');
    uses.set(m[2] ?? fqn.split('\\').pop()!, fqn);
  }
  const scope = { namespace, uses };
  memo.set(file, scope);
  return scope;
}

/** The qualified name (`A\B::C`) a PHP class name written in `file` refers to. */
function phpTypeQn(name: string, file: string, context: ResolutionContext): string {
  let fqn: string;
  if (name.startsWith('\\')) fqn = name.slice(1);
  else {
    const { namespace, uses } = phpFileScope(file, context);
    const [head, ...rest] = name.split('\\');
    const imported = uses.get(head!);
    fqn = imported ? [imported, ...rest].join('\\') : namespace ? `${namespace}\\${name}` : name;
  }
  const at = fqn.lastIndexOf('\\');
  return at < 0 ? fqn : `${fqn.slice(0, at)}::${fqn.slice(at + 1)}`;
}

/** The qualified names a PHP class or trait extends and the traits it uses. */
function phpSupertypeQns(decl: Node, context: ResolutionContext): string[] {
  let memo = PHP_SUPERS.get(context);
  if (!memo) {
    memo = new Map();
    PHP_SUPERS.set(context, memo);
  }
  const hit = memo.get(decl.id);
  if (hit) return hit;
  const names: string[] = [];
  const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
  const head = lines.slice(decl.startLine - 1, decl.startLine + 4).join(' ');
  const extended = /\bextends\s+([^{]*?)(?:\bimplements\b|\{)/.exec(head)?.[1] ?? '';
  for (const m of extended.matchAll(/(\\?[A-Za-z_][\w\\]*)/g)) names.push(m[1]!);
  // `use StringTranslationTrait, MessengerTrait;` at the top of the body —
  // one per line or one list across several (Laravel's Command, Model).
  const bodyLines = lines.slice(decl.startLine, Math.min(decl.endLine, decl.startLine + 80));
  const firstFunction = bodyLines.findIndex((l) => /\bfunction\b/.test(l));
  const body = bodyLines.slice(0, firstFunction < 0 ? bodyLines.length : firstFunction).join('\n');
  for (const used of body.matchAll(/^\s*use\s+([\w\\,\s]+?)\s*[;{]/gm)) {
    for (const t of used[1]!.split(',')) if (t.trim()) names.push(t.trim());
  }
  const qns = names.map((n) => phpTypeQn(n, decl.filePath, context));
  memo.set(decl.id, qns);
  return qns;
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
  /** Names the file imports from outside the project — `use std::task::{Context, Poll}`, `use futures::Stream`. */
  external: Set<string>;
  /** The items the file's project `use`s bind — their leaves, not the paths they walk. */
  bound: Set<string>;
}

const RUST_CRATES = new WeakMap<ResolutionContext, Set<string>>();
const RUST_DEPENDENCIES = new WeakMap<ResolutionContext, Set<string>>();

/**
 * The crates the project's manifests depend on (`[dependencies]`,
 * `[dev-dependencies]`, `[build-dependencies]`, per-target ones), by the name
 * code writes them (`futures_util`), less the project's own.
 */
function rustDependencyCrates(context: ResolutionContext): Set<string> {
  const hit = RUST_DEPENDENCIES.get(context);
  if (hit) return hit;
  const deps = new Set<string>();
  const manifests = ['Cargo.toml', ...[...getCargoWorkspaceCrateMap(context).values()].map((dir) => `${dir}/Cargo.toml`)];
  for (const manifest of new Set(manifests)) {
    const text = context.readFile(manifest) ?? '';
    let inDeps = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim();
      const header = /^\[([^\]]+)\]$/.exec(line);
      if (header) {
        const table = header[1]!.trim();
        // `[dependencies.tokio]` names one dependency in its header.
        const named = /(?:^|\.)(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/.exec(table);
        if (named) deps.add(named[1]!.replace(/-/g, '_'));
        inDeps = /(?:^|\.)(?:dev-|build-)?dependencies$/.test(table);
        continue;
      }
      const key = inDeps ? /^([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1] : undefined;
      if (key) deps.add(key.replace(/-/g, '_'));
    }
  }
  for (const own of rustProjectCrates(context)) deps.delete(own);
  RUST_DEPENDENCIES.set(context, deps);
  return deps;
}

/** The project's own crate names (`tokio`, `tokio_util`), from its Cargo.toml files. */
function rustProjectCrates(context: ResolutionContext): Set<string> {
  const hit = RUST_CRATES.get(context);
  if (hit) return hit;
  const crates = new Set<string>();
  // The manifests are not indexed files: the root's package, and the workspace's members.
  const root = /\[package\][^[]*?\bname\s*=\s*"([^"]+)"/.exec(context.readFile('Cargo.toml') ?? '')?.[1];
  if (root) crates.add(root.replace(/-/g, '_'));
  for (const name of getCargoWorkspaceCrateMap(context).keys()) crates.add(name.replace(/-/g, '_'));
  RUST_CRATES.set(context, crates);
  return crates;
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
  const uses: RustUses = { names: new Set(), globs: new Set(), external: new Set(), bound: new Set() };
  const leaves = (tree: string): string[] => [
    ...[...tree.matchAll(/([A-Za-z_]\w*)\s*(?=[,}]|$|\s+as\b)|\bas\s+([A-Za-z_]\w*)/g)]
      .map((leaf) => leaf[2] ?? leaf[1]!).filter((id) => id !== 'self' && id !== 'as'),
    // `use std::io::{self, Read}` binds `io` too.
    ...[...tree.matchAll(/([A-Za-z_]\w*)\s*::\s*\{[^{}]*\bself\b/g)].map((m) => m[1]!),
  ];
  // Comments first: a doc comment's prose ("…use the Option…") is not a `use`.
  const text = stripCommentsForRegex(context.readFile(filePath) ?? '', 'rust');
  const dependencies = rustDependencyCrates(context);
  for (const m of text.matchAll(/(?:^|[;{}\s])use\s+([^;]{1,2000});/g)) {
    const tree = m[1]!;
    const root = /^\s*(?:::)?([A-Za-z_]\w*)/.exec(tree)?.[1] ?? '';
    // Outside: the standard library or a crate the manifests depend on — not a
    // module of the project's (`mod support { … }` inline in a test).
    const outside = root === 'std' || root === 'core' || root === 'alloc' || (root !== '' && dependencies.has(root));
    // The items it binds: each leaf (`as` aliases by their alias), never the path it walks.
    if (outside) {
      for (const id of leaves(tree)) uses.external.add(id);
      continue;
    }
    for (const id of leaves(tree)) uses.bound.add(id);
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
  // Written through a path on its line (`jsont::SubMatch { … }`, `io::Result<…>`),
  // wherever the reference's column points.
  const pathed = line === undefined ? null
    : (line.startsWith(name, ref.column) && /::\s*$/.test(line.slice(0, ref.column)) ? /((?:[A-Za-z_]\w*\s*::\s*)*)([A-Za-z_]\w*)?\s*::\s*$/.exec(line.slice(0, ref.column))
      : !new RegExp(`(?<![\\w$:])${name}\\b`).test(line) ? new RegExp(`((?:[A-Za-z_]\\w*\\s*::\\s*)*)([A-Za-z_]\\w*)\\s*::\\s*${name}\\b`).exec(line) : null);
  if (pathed) {
    // Through a path: `crate::` / `self::` / `super::` look it up relatively;
    // `io::Result` is the `io` module's — tokio's `runtime/task` alias is not —
    // and a path from std (`std::io::Error`) is std's.
    const seg = pathed[2] ?? '';
    const root = /^([A-Za-z_]\w*)/.exec(pathed[1] ?? '')?.[1] ?? seg;
    // `Self::Error` in a signature is the enclosing impl's (or trait's) own
    // associated type, and `V::Value` an associated type of a generic's bound —
    // never a struct of that name: serde's 334 `Self::Error`s went to
    // `de::value::Error`.
    if (ref.referenceKind === 'references' && (pathed[1] ?? '') === '' && line !== undefined) {
      if (seg === 'Self') return candidate.kind === 'type_alias' && isInEnclosingRustImpl(candidate, ref, context);
      if (isRustGenericParam(seg, ref, context)) return false;
    }
    if ((root === 'std' || root === 'core' || root === 'alloc') && candidate.filePath !== ref.filePath) return false;
    // A project crate's name re-exports as `crate::` does: `clap::Command` is clap_builder's.
    if (seg === '' || seg === 'crate' || seg === 'self' || seg === 'super' || seg === 'Self' || candidate.filePath === ref.filePath ||
        rustProjectCrates(context).has(seg)) return true;
    // `io::Error` under `use std::io;` is std's, whatever `io/` directory the project has.
    const pathUses = rustUsesOf(ref.filePath, context);
    if (pathUses.external.has(seg) && !pathUses.bound.has(seg)) return false;
    return rustModuleName(candidate.filePath) === seg || candidate.filePath.includes(`/${seg}/`) ||
      candidate.qualifiedName.split('::').includes(seg);
  }
  if (candidate.kind === 'enum_member') {
    if (ref.referenceKind === 'references') return false;
    const uses = rustUsesOf(ref.filePath, context);
    const cut = candidate.qualifiedName.lastIndexOf('::');
    const owner = cut >= 0 ? candidate.qualifiedName.slice(0, cut).split('::').pop()! : '';
    return (owner !== '' && uses.globs.has(owner)) || (uses.names.has(name) && uses.names.has(owner));
  }
  if (candidate.filePath === ref.filePath) return true;
  const uses = rustUsesOf(ref.filePath, context);
  // `use std::task::{Context, Poll}`: the file's `Context` is std's, not tokio's
  // `runtime::context::Context`. (A method call `.env(…)` is no imported name.)
  if (uses.external.has(name) && !uses.bound.has(name) && line !== undefined) {
    // Not on its line at all: a later link of a chain written across lines (`Arg::new(…)\n.env(…)`).
    const at = new RegExp(`(?<![\\w$])${name}\\b`).exec(line.slice(Math.max(0, ref.column)));
    if (at && !/\.\s*$/.test(line.slice(0, Math.max(0, ref.column) + at.index))) return false;
  }
  if (!RUST_PRELUDE.has(name)) {
    // Another file's item — a type, a function — is in scope only through a
    // `use` that binds it or a glob over its module: tokio's `Context<'_>` is
    // not `runtime::task::trace`'s `Context` unless the file brings that one
    // in. A method is reached through a value, never a `use`.
    if (TYPE_MEMBER_KINDS.has(candidate.kind) || ref.referenceKind === 'imports' ||
        candidate.kind === 'file' || candidate.kind === 'module' || candidate.kind === 'namespace') return true;
    return uses.bound.has(name) || rustGlobCovers(uses, candidate, ref);
  }
  return uses.names.has(name) || rustGlobCovers(uses, candidate, ref);
}

/** The line of the `impl` / `trait` header above `ref` in its file (0 for none). */
function rustEnclosingImplLine(ref: UnresolvedRef, context: ResolutionContext): number {
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/) ?? [];
  for (let i = ref.line - 1; i >= 0; i--) {
    if (/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(?:impl|trait)\b/.test(lines[i] ?? '')) return i + 1;
  }
  return 0;
}

/** Whether `candidate` is declared in the same `impl` / `trait` block as `ref`, above it. */
function isInEnclosingRustImpl(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const header = rustEnclosingImplLine(ref, context);
  return header > 0 && candidate.filePath === ref.filePath && candidate.startLine >= header && candidate.startLine <= ref.line;
}

/** Whether `name` is a generic type parameter of the function or impl around `ref` (`fn f<V: Visitor>`, `impl<'de, E>`). */
function isRustGenericParam(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (!/^[A-Z]\w*$/.test(name)) return false;
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/) ?? [];
  const from = Math.max(0, rustEnclosingImplLine(ref, context) - 1);
  const text = lines.slice(from, ref.line).join('\n');
  return new RegExp(`<[^<>]*(?:<[^<>]*>[^<>]*)*\\b${name}\\b\\s*(?:[:,>=])`).test(text);
}

/** What only exists inside a type, reachable through a receiver alone. */
const TYPE_MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'property', 'field', 'enum_member']);

/** Per-context memo: `file\0name` → "the file binds this name locally". */
/** Whether `n` lies outside the function that binds the reference's name itself (see jsFunctionLocalScope). */
function isOutsideJsLocal(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  // `const indexName = this.dataSource.namingStrategy.indexName(…)`: a member, whatever the local's name.
  if (ref.referenceKind === 'calls' && bareCallReceiver(ref, context) !== null) return false;
  const scope = jsFunctionLocalScope(ref.referenceName, ref, context);
  return scope !== null && !(n.filePath === ref.filePath && n.startLine >= scope.start && n.startLine <= scope.end);
}

const JS_FN_LOCAL_MEMO = new WeakMap<ResolutionContext, Map<string, { start: number; end: number } | null>>();

/**
 * The lines of the JS/TS function a reference sits in when that function binds
 * the name itself — a parameter, or a `var`/`let`/`const` above the reference.
 * Such a name is the local, never a same-named function declared elsewhere:
 * every lodash helper lives inside `runInContext`, so `baseHas(object, key)`'s
 * `object` and `mixin`'s `object(this.__wrapped__)` reached a `function
 * object() {}` an IIFE declares there. Null when the function does not bind it.
 */
function jsFunctionLocalScope(name: string, ref: UnresolvedRef, context: ResolutionContext): { start: number; end: number } | null {
  if (!JS_FAMILY.has(ref.language) || !/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  let memo = JS_FN_LOCAL_MEMO.get(context);
  if (!memo) JS_FN_LOCAL_MEMO.set(context, (memo = new Map()));
  const key = `${ref.fromNodeId}\0${name}\0${ref.line}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let scope: { start: number; end: number } | null = null;
  const fn = context.getNodeById?.(ref.fromNodeId);
  if (fn && (fn.kind === 'function' || fn.kind === 'method') && fn.startLine <= ref.line && fn.endLine >= ref.line) {
    const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/) ?? [];
    const text = stripCommentsForRegex(lines.slice(fn.startLine - 1, ref.line).join('\n'), 'javascript');
    const { param } = localBindingPatterns(name, 'g');
    const n = name.replace(/\$/g, '\\$');
    // A plain declaration. Destructuring re-binds what a call returns under
    // the same name — `const { t } = useI18n()`, `const { getLabel } =
    // useProps(props)` — which is the same-named function more often than not.
    const declared = new RegExp(`\\b(?:const|let|var)\\s+${n}\\b(?!\\s*[,\\]}])`).test(text);
    // A parameter list — never a control-flow head (`if (openMarkerClose) {`).
    // A return type stays on its line, never a ternary's `: data.slice()` below `filter(canRowExpand)`.
    const parameter = new RegExp(`(?<!\\b(?:if|while|for|switch|with)\\s*)${param.source.replace('(?::[^=;{]*)?', '(?::[^=;{}()\\n]*)?')}`);
    if (declared || parameter.test(text)) scope = { start: fn.startLine, end: fn.endLine };
  }
  memo.set(key, scope);
  return scope;
}

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
  const bareNoMembers = isBareGoCall(ref, context) || isBareRCall(ref, context);
  const solidityBare = isReceiverLessSolidityCall(ref, context);
  const barePhp = isBarePhpCall(ref, context);
  const luaBareCall = (ref.language === 'lua' || ref.language === 'luau') && ref.referenceKind === 'calls' && /^[A-Za-z_]\w*$/.test(ref.referenceName);
  // A type, a value or an import the file binds from a package outside the
  // repository names nothing in it, whatever kind of reference it is.
  if (!bareJs && JS_FAMILY.has(ref.language) && ref.referenceKind !== 'calls' &&
      /^[A-Za-z_$][\w$]*$/.test(ref.referenceName) && isOutOfRepoBinding(ref.referenceName, ref, context)) {
    return null;
  }
  if (bareJs) {
    const storeAction = matchJsStoreBindingCall(ref, context);
    if (storeAction) return storeAction;
    const returned = matchDestructuredCallResult(ref, context);
    if (returned) return returned;
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
  const javaBare = ref.language === 'java' && ref.referenceKind === 'calls' && /^[A-Za-z_$][\w$]*$/.test(ref.referenceName);
  const dartBare = ref.language === 'dart' && ref.referenceKind === 'calls' && /^[A-Za-z_$][\w$]*$/.test(ref.referenceName) && isReceiverLessDartCall(ref, context);
  const kotlinCall = ref.language === 'kotlin' && ref.referenceKind === 'calls' && /^[A-Za-z_$][\w$]*$/.test(ref.referenceName);
  const kotlinBare = kotlinCall && isReceiverLessKotlinCall(ref, context);
  const rubyBare = ref.language === 'ruby' && ref.referenceKind === 'calls' && /^[A-Za-z_]\w*[?!]?$/.test(ref.referenceName);
  const cfmlBare = (ref.language === 'cfml' || ref.language === 'cfscript') && ref.referenceKind === 'calls' && /^[A-Za-z_]\w*$/.test(ref.referenceName);
  const vbReceiver = ref.language === 'vbnet' && (ref.referenceKind === 'calls' || ref.referenceKind === 'instantiates') && /^\w+$/.test(ref.referenceName)
    ? vbReceiverOf(ref, context) : null;
  const objcShape = ref.language === 'objc' && ref.referenceKind === 'calls' && /^[A-Za-z_]\w*:*(?:\w+:)*$/.test(ref.referenceName)
    ? objcCallShape(ref, context) : null;
  const csharpBare = ref.language === 'csharp' && (ref.referenceKind === 'calls' || ref.referenceKind === 'references') && /^[A-Za-z_]\w*$/.test(ref.referenceName);
  const scalaBare = ref.language === 'scala' && ref.referenceKind === 'calls' && /^[A-Za-z_$][\w$]*$/.test(ref.referenceName);
  const rustGoShape = (ref.language === 'rust' || ref.language === 'go') && ref.referenceKind === 'calls' && /^[A-Za-z_]\w*$/.test(ref.referenceName)
    ? rustGoCallShape(ref, context) : null;
  const kotlinStdChain = ref.language === 'kotlin' && ref.referenceKind === 'calls' && KOTLIN_STD_METHODS.has(ref.referenceName)
    ? kotlinChainReceiver(ref, context) : null;
  const swiftShape = ref.language === 'swift' && ref.referenceKind === 'calls' && /^[A-Za-z_]\w*$/.test(ref.referenceName)
    ? swiftCallShape(ref, context) : null;
  const phpSelf = phpSelfReceiver(ref, context);
  const filtered = sameName.filter((n) =>
    !(kotlinStdChain !== null && !isKotlinStdChainTarget(n, kotlinStdChain)) &&
    !(swiftShape && !isSwiftCallTarget(n, swiftShape, ref, context)) &&
    !(rustGoShape && !isRustGoCallTarget(n, rustGoShape)) &&
    !(scalaBare && !isScalaMemberInScope(n, ref, context)) &&
    !(csharpBare && !isCsharpMemberInScope(n, ref, context)) &&
    !(objcShape === 'c-call' && OBJC_MEMBER_KINDS.has(n.kind)) &&
    !(objcShape === 'self-send' && !isObjcSelfSendTarget(n, ref, context)) &&
    !(objcShape === 'super-send' && !isObjcSelfSendTarget(n, ref, context, true)) &&
    !(vbReceiver !== null && !isVbMemberReachable(n, vbReceiver)) &&
    !(rubyBare && n.kind === 'method' && !isRubyMethodInScope(n, ref, context)) &&
    !(cfmlBare && n.kind === 'method' && !isCfmlMethodInScope(n, ref, context)) &&
    !(javaBare && n.kind === 'method' && !isJavaMethodInScope(n, ref, context)) &&
    !(kotlinCall && !isKotlinTopLevelVisible(n, ref, context)) &&
    !(kotlinBare && !isKotlinMemberReachable(n, ref, context)) &&
    !isKotlinNumberBitwise(n, ref) &&
    !(solidityBare && !isSolidityMemberInScope(n, ref, context)) &&
    !(dartBare && isDartMember(n) && !isDartMethodInScope(n, ref, context)) &&
    !(phpSelf && (n.kind !== 'method' || !isPhpMethodInScope(n, ref, phpSelf, context))) &&
    !(pythonShape && !fitsPythonCallShape(n, pythonShape, ref, context)) &&
    !(rustBare && !isRustNameInScope(n, ref, context)) &&
    !(cMacroCall && n.kind !== 'function' && n.kind !== 'method') &&
    !(typeRef && !canNameInTypePosition(n)) &&
    // A Scala type position (`Arbitrary[B]`) never names a method: an
    // `implicit def A: Order[A]` shares its name with half of cats' type
    // parameters. Scala's value references only read a file's own vals.
    // Nor does a kind-projector placeholder (`F[*]`, `G[?]`): cats' 567 `*`
    // type arguments went to an algebra `Sign`'s `*` method.
    !(ref.language === 'scala' && ref.referenceKind === 'references' && /^(?:[A-Z]|[^\w\s]+$)/.test(ref.referenceName) &&
      (n.kind === 'method' || n.kind === 'function')) &&
    // Type/value references retain same-family eligibility: a native namesake
    // must not hide the actual web type. Calls still gate only the winner.
    (!valueRef || sameLanguageFamily(n.language, ref.language)) &&
    n.kind !== 'import' &&
    // A receiver-less JS/TS or Go call cannot reach a member of a type — a
    // method (#1714, #1857), nor a property, field or case: mocha's global
    // `it(…)` bound to an interface's `it` property, `describe(…)` to a
    // command class's `describe` string.
    !((bareJs || bareNoMembers) && TYPE_MEMBER_KINDS.has(n.kind)) &&
    // A bare PHP call is a function call: nothing else is callable without a receiver.
    !(barePhp && n.kind !== 'function') &&
    // Nor is a table's method (`function M.x`, `function M:x`) in Lua, without its table.
    !(luaBareCall && n.kind === 'method') &&
    // A Vue component's own method is `this.m()` inside that component — not
    // `this.$refs['input'].click()` on an element another component renders.
    !(ref.referenceKind === 'calls' && JS_FAMILY.has(ref.language) && isVueComponentMethod(n) && !isThisCallInOwnFile(n, ref, context)) &&
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
    // A C# type name is a type its namespaces can see — ahead of the ranking,
    // so a visible namesake wins where the veto after it would drop the
    // ref: eShop's `WebhookType.OrderPaid` under `using Webhooks.API.Model;`.
    // A bare PHP class name, only its namespace's or the imported one — ahead of
    // the ranking, so koel's `extends Request` under `use App\Http\Requests\API\Request;`
    // is that class, not the first `Request` indexed.
    isPhpClassVisible(n, ref, context) &&
    // A Scala package object's member, only where it is in scope — ahead of
    // the ranking, so cats.laws' `Eq` can be the `cats` package object's.
    !(ref.language === 'scala' && n.language === 'scala' && n.filePath !== ref.filePath &&
      !isScalaPackageObjectMemberVisible(n, ref, context)) &&
    // A nested type, only from inside its owner: AutoMapper's same-file `new
    // Source()` in one test class is not the previous test class's `Source`.
    !(ref.language === 'csharp' && n.language === 'csharp' && CSHARP_TYPE_KINDS.has(n.kind) && /^[A-Za-z_]\w*$/.test(ref.referenceName) &&
      (!isCsharpNestedTypeInScope(n, ref, context) || (n.filePath !== ref.filePath && !isCsharpTypeVisible(n, ref, context)))) &&
    // Preserve import ranking; calls reject the winner without promoting another.
    (!importRef || n.filePath === ref.filePath ||
      !ESM_FAMILY.has(n.language) || !isSealedModule(n.filePath, context)) &&
    // A name the file binds itself (a parameter, a const) shadows every other
    // file's symbol of that name, so a bare call has no cross-file candidate.
    !(bareJs && n.filePath !== ref.filePath && isLocallyBoundJsName(ref.referenceName, ref.filePath, context))
  );
  const candidates = dartBare ? nearestDartMembers(filtered, ref, context)
    : swiftShape && swiftShape.shape !== 'chained' ? nearestSwiftMembers(filtered, ref, context)
    : kotlinBare ? lexicalKotlinMembers(filtered, ref, context) : filtered;

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

  let candidates = keepForRef(context.getNodesByQualifiedName(ref.referenceName));
  // A C# `using X.Y;` names a namespace: one the project declares, else it is
  // the file's own (external) using — never another file's using of that name.
  if (ref.language === 'csharp' && ref.referenceKind === 'imports') {
    const namespaces = candidates.filter((n) => n.kind === 'namespace');
    candidates = namespaces.length > 0 ? preferCallSiteFile(namespaces, ref.filePath).slice(0, 1)
      : candidates.filter((n) => n.kind !== 'import' || n.filePath === ref.filePath);
  }

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
 * A Java / C# type's optional type arguments (one level of nesting) and array
 * ranks, as a regex source: `<L, R>`, `<string, List<int>>`, `[]`, `[,]`.
 */
const TYPE_ARGS = '(?:<[^;=(){}<>]*(?:<[^;=(){}<>]*>[^;=(){}<>]*)*>)?\\s*(?:\\[[\\s,]*\\]\\s*)*';

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
  RUST_CRATES.delete(context);
  RUST_DEPENDENCIES.delete(context);
  LEXICAL_SCOPE_MEMO.delete(context);
  KOTLIN_LAMBDA_RECEIVERS.delete(context);
  SCALA_IMPORTED_SUPERS.delete(context);
  SCALA_PACKAGE_OBJECTS.delete(context);
  LOCAL_DECL_MEMO.delete(context);
  JAVA_SUPERS.delete(context);
  PHP_SUPERS.delete(context);
  DART_SUPERS.delete(context);
  DART_HIERARCHIES.delete(context);
  SWIFT_DECLS.delete(context);
  KOTLIN_RECEIVER_TYPES.delete(context);
  KOTLIN_HIERARCHIES.delete(context);
  KOTLIN_FRAMES.delete(context);
  CPP_NS_MACROS.delete(context);
  CPP_NS_FRAMES.delete(context);
  CPP_NS_ALIASES.delete(context);
  SOLIDITY_SUPERS.delete(context);
  DECLARED_SUPERS.delete(context);
  INHERITED_METHODS.delete(context);
  MEMBER_SHADOWS.delete(context);
  MEMBER_WALKS.delete(context);
  MEMBER_LINES.delete(context);
  SOLIDITY_HIERARCHIES.delete(context);
  MEMBER_TYPE_MEMO.delete(context);
  CSHARP_ALIASES.delete(context);
  SWIFT_HIERARCHIES.delete(context);
  KOTLIN_FILE_SCOPES.delete(context);
  RUBY_ANCESTRY.delete(context);
  CFML_CHAINS.delete(context);
  OBJC_SUPERS.delete(context);
  CSHARP_SUPERS.delete(context);
  CSHARP_STATIC_USINGS.delete(context);
  CSHARP_NAMESPACE_SCOPES.delete(context);
  CSHARP_PROJECT_USINGS.delete(context);
  CSHARP_GLOBAL_USINGS.delete(context);
  CSHARP_ANCESTORS.delete(context);
  PY_FIXTURE_TYPES.delete(context);
  PY_PLUGGED_MODULES.delete(context);
  SCALA_OBJECT_PACKAGES.delete(context);
  GO_EXTERNAL_QUALIFIED.delete(context);
  SCALA_SUPERS.delete(context);
  SCALA_IMPORTS.delete(context);
  ESM_EXPORT_LISTS.delete(context);
  LUA_LOCALS.delete(context);
  LUA_MEMBERS.delete(context);
  JVM_PACKAGES.delete(context);
  MINIFIED_SCRIPTS.delete(context);
  PY_LOCAL_BINDS.delete(context);
  OVERLOAD_SETS.delete(context);
  PHP_FILE_SCOPES.delete(context);
  JAVA_STATIC_IMPORTS.delete(context);
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
        // group = VLANGroup.objects.create(…) — a Django manager call that
        // returns one instance of the model (not `filter`/`all`, a QuerySet).
        new RegExp(`(?:^|;)\\s*${r}\\s*=(?!=)\\s*([A-Z]\\w*)\\.objects\\.(?:create|get|first|last|latest|earliest|get_by_natural_key)\\s*\\(`),
        // lg = Logger(...) — a statement of its own: `prefix=IPNetwork(…),`
        // inside a call's arguments is a keyword argument, not a binding.
        new RegExp(`(?:^|;)\\s*${r}\\s*=(?!=)\\s*([A-Z][\\w.]*)\\s*\\((?![^\\n]*,\\s*$)`),
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
        new RegExp(`\\b([A-Z][\\w.]*)\\s*${TYPE_ARGS}\\s+${r}\\b\\s*[=;,)]`), // Logger lg;  / Pair<L, R> pair / String[] args
        new RegExp(`\\bfor\\s*\\(\\s*(?:final\\s+)?([A-Z][\\w.]*)\\s*${TYPE_ARGS}\\s+${r}\\s*:`), // for (Element el : els)
      ];
    case 'kotlin':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*([A-Z][\\w.]*)\\s*\\(`), // val lg = Logger(...)
        new RegExp(`\\b${r}\\b\\s*:\\s*([A-Z][\\w.]*)`), // val lg: Logger  / param
      ];
    case 'csharp':
      return [
        new RegExp(`\\b${r}\\b\\s*=\\s*new\\s+([A-Za-z_][\\w.]*)`), // = new Logger()
        new RegExp(`\\b([A-Z][\\w.]*)\\s*${TYPE_ARGS}\\??\\s+${r}\\b\\s*[=;,)]`), // Logger lg;  / List<string> names / JProperty? p
        new RegExp(`\\bforeach\\s*\\(\\s*([A-Z][\\w.]*)\\s*${TYPE_ARGS}\\??\\s+${r}\\s+in\\b`), // foreach (JProperty p in props)
      ];
    case 'objc':
      return [
        // FMResultSet *rs = …  /  NSString * _Nullable name;  /  a block's ^(FMResultSet *rs)
        new RegExp(`\\b([A-Z]\\w*)\\s*(?:<[^<>;]*>\\s*)?\\*\\s*(?:(?:_Nullable|_Nonnull|__strong|__weak|__unsafe_unretained|const)\\s+)*${r}\\b(?!\\s*\\()`),
        // a method parameter: - (void)read:(nullable FMResultSet *)rs
        new RegExp(`\\(\\s*(?:(?:nullable|nonnull|__kindof)\\s+)*([A-Z]\\w*)\\s*(?:<[^<>)]*>\\s*)?\\*[^)]*\\)\\s*${r}\\b`),
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

/** Languages whose fields and properties declare their type where the class declares them. */
const MEMBER_TYPED_LANGUAGES: ReadonlySet<string> = new Set(['csharp', 'java', 'kotlin', 'swift']);
const MEMBER_CLASS_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'interface', 'enum', 'record']);
const MEMBER_TYPE_MEMO = new WeakMap<ResolutionContext, Map<string, string | null>>();
/** Words that can stand where a declaration's type does without being one. */
const MEMBER_TYPE_NON_TYPES: ReadonlySet<string> = new Set([
  'return', 'new', 'case', 'throw', 'else', 'in', 'out', 'ref', 'params', 'await', 'yield', 'is', 'as', 'using',
  'var', 'val', 'goto', 'nameof', 'typeof', 'sizeof', 'default', 'when', 'where', 'get', 'set', 'init',
  'class', 'interface', 'enum', 'struct', 'record', 'object', 'namespace', 'package', 'import', 'extends',
  'implements', 'fun', 'static', 'final', 'abstract', 'sealed', 'override', 'virtual', 'delegate', 'event',
]);

/**
 * The type a C# / Java / Kotlin receiver has as a field or property of the
 * class around the call — `private readonly JsonWriter _innerWriter;`,
 * `public JsonReader Reader { get; }`, `private val sink: BufferedSink` — or
 * null when the class declares no such member or the calling method binds
 * the name itself. Only the class's own lines are read, never a method body
 * or a nested type. Newtonsoft's `_innerWriter.WriteValue(…)` inside
 * TraceJsonWriter went to TraceJsonWriter's own `WriteValue` by name.
 */
function inferMemberReceiverType(receiver: string, ref: UnresolvedRef, context: ResolutionContext): string | null {
  const name = receiver.replace(/^(?:this|self)\./, '');
  if (!/^[A-Za-z_]\w*$/.test(name)) return null;
  const inFile = context.getNodesInFile(ref.filePath).filter((n) => n.language === ref.language);
  let cls: Node | undefined;
  let fn: Node | undefined;
  for (const n of inFile) {
    if (n.startLine > ref.line || n.endLine < ref.line) continue;
    if (MEMBER_CLASS_KINDS.has(n.kind) && (!cls || n.startLine >= cls.startLine)) cls = n;
    else if ((n.kind === 'method' || n.kind === 'function') && (!fn || n.startLine >= fn.startLine)) fn = n;
  }
  if (!cls) return null;
  const found = memberTypeThroughHierarchy(cls, name, context);
  if (!found) return null;
  // A lambda parameter, `var` local, `out` variable or `foreach` binding in
  // the calling method shadows the field, and the local inference that ran
  // first cannot type those.
  return fn && bindsNameItself(fn, name, context) ? null : found;
}

const MEMBER_SHADOWS = new WeakMap<ResolutionContext, Map<string, boolean>>();
const MEMBER_WALKS = new WeakMap<ResolutionContext, Map<string, string | null>>();

/** Whether a C# / Java / Kotlin function body binds `name` itself — a `var`/`val`, an `out` or loop variable, a lambda parameter. */
function bindsNameItself(fn: Node, name: string, context: ResolutionContext): boolean {
  let memo = MEMBER_SHADOWS.get(context);
  if (!memo) MEMBER_SHADOWS.set(context, (memo = new Map()));
  const key = `${fn.id}|${name}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const lines = context.getFileLines?.(fn.filePath) ?? context.readFile(fn.filePath)?.split(/\r?\n/) ?? [];
  const body = lines.slice(fn.startLine - 1, fn.endLine).join('\n');
  const r = name.replace(/\$/g, '\\$');
  const binds = new RegExp(`\\b(?:var|val|let|out\\s+[\\w.<>?]+|foreach\\s*\\(\\s*[\\w.<>?,\\s]+?)\\s+${r}\\b|\\bfor\\s*\\([^;)]*\\s${r}\\s*:|\\b${r}\\s*=>|[(,]\\s*${r}\\s*(?:,[^()]*)?\\)\\s*=>|\\b${r}\\s*(?:,[^{}]*)?->`).test(body);
  memo.set(key, binds);
  return binds;
}

/**
 * The type `cls` declares a member `name` with, or one of its supertypes
 * does — the class's own members first, then those it inherits (a base
 * class's `internal readonly JsonSerializer Serializer;`), each inherited
 * class carrying what its type parameters stand for in the class the walk
 * came from (`: IntegrationTest<DatabaseInitializer>`).
 */
function memberTypeThroughHierarchy(cls: Node, name: string, context: ResolutionContext): string | null {
  let memo = MEMBER_WALKS.get(context);
  if (!memo) MEMBER_WALKS.set(context, (memo = new Map()));
  const key = `${cls.id}|${name}`;
  if (memo.has(key)) return memo.get(key)!;
  let result: string | null = null;
  const seen = new Set<string>();
  const queue: Array<{ type: Node; args: Map<string, string> }> = [{ type: cls, args: new Map() }];
  while (queue.length > 0 && seen.size < 8) {
    const { type, args } = queue.shift()!;
    if (seen.has(type.id)) continue;
    seen.add(type.id);
    const found = classMemberType(type, name, context);
    if (found) {
      if (type === cls) {
        result = found;
        break;
      }
      // A member typed by the declaring class's own type parameter
      // (`protected TFixture Fixture { get; }`) is the argument the subclass
      // gave it, else its bound — with neither, only `object`'s members.
      const given = args.get(found);
      if (given) {
        result = given;
        break;
      }
      const bound = typeParameterBoundIn(found, [type], context);
      result = bound === undefined ? found : bound ?? 'object';
      break;
    }
    for (const sup of classHeadSupertypes(type, context)) {
      const given = headTypeArguments(type, sup, context).map((a) => args.get(a) ?? a);
      for (const decl of context.getNodesByName(sup)) {
        if (decl.language !== type.language || !MEMBER_CLASS_KINDS.has(decl.kind)) continue;
        const params = declaredTypeParameters(decl, context);
        queue.push({ type: decl, args: new Map(params.map((p, i) => [p, given[i] ?? ''] as [string, string]).filter(([, a]) => a !== '')) });
      }
    }
  }
  memo.set(key, result);
  return result;
}

/** The first `<…>` of a declaration's head, split at its top-level commas. */
function angleArguments(text: string): string[] {
  const open = text.indexOf('<');
  if (open < 0) return [];
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text.slice(open + 1)) {
    if (ch === '<') depth++;
    else if (ch === '>' && depth-- === 0) break;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((a) => a.trim());
}

/** The type parameters a class declares: `TDbContextFixture` for `class IntegrationTest<TDbContextFixture>`. */
function declaredTypeParameters(decl: Node, context: ResolutionContext): string[] {
  const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
  const head = lines.slice(decl.startLine - 1, decl.startLine + 3).join(' ');
  const at = new RegExp(`\\b${decl.name}\\s*<`).exec(head);
  if (!at) return [];
  return angleArguments(head.slice(at.index)).map((p) => /([A-Za-z_]\w*)\s*(?:extends\b.*|:.*)?$/.exec(p.replace(/^(?:in|out|reified)\s+/, ''))?.[1] ?? '');
}

/** The type arguments a class's head gives a supertype, as simple names: `DatabaseInitializer` for `: IntegrationTest<ParameterizedQueries.DatabaseInitializer>`. */
function headTypeArguments(cls: Node, sup: string, context: ResolutionContext): string[] {
  const lines = context.getFileLines?.(cls.filePath) ?? context.readFile(cls.filePath)?.split(/\r?\n/) ?? [];
  const head = lines.slice(cls.startLine - 1, cls.startLine + 8).join(' ').split('{')[0]!;
  const at = new RegExp(`(?:[:,]|\\bextends|\\bimplements)\\s*(?:[\\w.]+\\.)?${sup}\\s*<`).exec(head);
  if (!at) return [];
  return angleArguments(head.slice(at.index)).map((a) => a.replace(/<[\s\S]*$/, '').split('.').pop()!.trim());
}

/**
 * The supertypes a class declaration names in its own head, for the
 * languages whose heads say it plainly: Pascal `TX = class(TBase, IFoo)`,
 * Python `class X(Base):`, Ruby `class X < Base`, PHP / TS / JS `extends
 * Base`, and the Java-family heads.
 */
const DECLARED_SUPERS = new WeakMap<ResolutionContext, Map<string, string[]>>();
const INHERITED_METHODS = new WeakMap<ResolutionContext, Map<string, Node | null>>();

function declaredSupertypes(cls: Node, context: ResolutionContext): string[] {
  let memo = DECLARED_SUPERS.get(context);
  if (!memo) DECLARED_SUPERS.set(context, (memo = new Map()));
  const hit = memo.get(cls.id);
  if (hit) return hit;
  const supers = readDeclaredSupertypes(cls, context);
  memo.set(cls.id, supers);
  return supers;
}

function readDeclaredSupertypes(cls: Node, context: ResolutionContext): string[] {
  switch (cls.language) {
    case 'java': case 'csharp': case 'kotlin': return classHeadSupertypes(cls, context);
    case 'dart': return dartSupertypesOf(cls.name, context);
    case 'swift': return swiftDeclOf(cls.name, context).supers;
    case 'objc': return objcSupertypesOf(cls.name, context);
    case 'scala': return scalaSupertypesOf(cls.name, context);
    default: break;
  }
  const lines = context.getFileLines?.(cls.filePath) ?? context.readFile(cls.filePath)?.split(/\r?\n/) ?? [];
  const head = lines.slice(cls.startLine - 1, cls.startLine + 2).join(' ');
  const names = (text: string | undefined): string[] =>
    text ? [...text.matchAll(/([A-Za-z_][\w.:\\]*)/g)].map((m) => m[1]!.split(/::|\.|\\/).pop()!).filter((w) => !/^(?:metaclass|object)$/.test(w)) : [];
  switch (cls.language) {
    case 'pascal': return names(/=\s*class\s*\(([^)]*)\)/i.exec(head)?.[1]);
    case 'python': return names(/\bclass\s+\w+\s*\(([^)]*)\)/.exec(head)?.[1]?.replace(/\w+\s*=\s*[\w.]+/g, ''));
    case 'ruby': return names(/\bclass\s+[\w:]+\s*<\s*([\w:]+)/.exec(head)?.[1]);
    case 'php': case 'typescript': case 'tsx': case 'javascript': case 'jsx':
      return names(/\bextends\s+([\w.\\]+)/.exec(head)?.[1]);
    default: return [];
  }
}

/** A method named `name` on a supertype of the given classes, nearest first. */
function inheritedClassMethod(classes: Node[], name: string, context: ResolutionContext): Node | null {
  if (classes.length === 0) return null;
  let memo = INHERITED_METHODS.get(context);
  if (!memo) INHERITED_METHODS.set(context, (memo = new Map()));
  const key = `${classes.map((c) => c.id).join(',')}|${name}`;
  if (memo.has(key)) return memo.get(key)!;
  const found = findInheritedClassMethod(classes, name, context);
  memo.set(key, found);
  return found;
}

function findInheritedClassMethod(classes: Node[], name: string, context: ResolutionContext): Node | null {
  const seen = new Set<string>(classes.map((c) => c.id));
  let frontier = classes;
  for (let depth = 0; depth < 5 && frontier.length > 0; depth++) {
    const next: Node[] = [];
    for (const cls of frontier) {
      for (const sup of declaredSupertypes(cls, context)) {
        for (const decl of context.getNodesByName(sup)) {
          if (decl.language !== cls.language || !isMethodOwnerKind(decl) || seen.has(decl.id)) continue;
          seen.add(decl.id);
          const method = context.getNodesInFile(decl.filePath).find((n) => n.kind === 'method' && n.name === name &&
            n.qualifiedName.slice(0, Math.max(0, n.qualifiedName.lastIndexOf('::'))).split(/::|\./).pop() === decl.name);
          if (method) return method;
          next.push(decl);
        }
      }
    }
    frontier = next;
  }
  return null;
}

/** The simple names a Java / C# / Kotlin class declaration's head extends or implements. */
function classHeadSupertypes(cls: Node, context: ResolutionContext): string[] {
  const lines = context.getFileLines?.(cls.filePath) ?? context.readFile(cls.filePath)?.split(/\r?\n/) ?? [];
  let depth = 0;
  let head = '';
  for (const ch of lines.slice(cls.startLine - 1, cls.startLine + 8).join(' ').replace(/\/\/[^\n]*|\/\*.*?\*\//g, ' ')) {
    if (ch === '{' && depth === 0) break;
    if (ch === '<' || ch === '(') depth++;
    else if (ch === '>' || ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) head += ch;
  }
  const clause = /\b(?:extends|implements)\b([\s\S]*)$/.exec(head)?.[1] ??
    /\b(?:class|interface|struct|record|object)\s+\w+[^:]*:([\s\S]*)$/.exec(head)?.[1] ?? '';
  return [...clause.replace(/\bwhere\b[\s\S]*$/, '').matchAll(/([A-Z]\w*)\s*(?=,|$|\bimplements\b)/g)].map((m) => m[1]!);
}

/**
 * The type a class declares a member `name` with, read from the lines at its
 * body's own brace depth (or its header, for a primary constructor's
 * parameters) — deeper ones are method, accessor and indexer bodies or
 * nested types.
 */
function classMemberType(cls: Node, name: string, context: ResolutionContext): string | null {
  let memo = MEMBER_TYPE_MEMO.get(context);
  if (!memo) {
    memo = new Map();
    MEMBER_TYPE_MEMO.set(context, memo);
  }
  const key = `${cls.id}|${name}`;
  if (memo.has(key)) return memo.get(key)!;
  const r = name.replace(/\$/g, '\\$');
  const pattern = cls.language === 'kotlin' || cls.language === 'swift'
    ? new RegExp(`\\b(?:val|var|let)\\s+${r}\\s*:\\s*([A-Z][\\w.]*)`)
    : new RegExp(`(?:^|[\\s(,])([A-Za-z_][\\w.]*)\\s*${TYPE_ARGS}\\??\\s+${r}\\s*(?:[=;,)]|\\{)`);
  let found: string | null = null;
  for (const { text, depth } of classMemberLines(cls, context)) {
    if (!text.includes(name)) continue;
    const m = pattern.exec(text);
    // Inside parentheses at member depth is a method's parameter list; only
    // the header's (a primary constructor's) declares members.
    const inParens = m !== null && depth === 1 &&
      (text.slice(0, m.index).match(/\(/g)?.length ?? 0) > (text.slice(0, m.index).match(/\)/g)?.length ?? 0);
    if (m && !inParens && !MEMBER_TYPE_NON_TYPES.has(m[1]!)) {
      found = normalizeInferredTypeName(m[1]!);
      break;
    }
  }
  memo.set(key, found);
  return found;
}

const MEMBER_LINES = new WeakMap<ResolutionContext, Map<string, Array<{ text: string; depth: number }>>>();

/**
 * A class's own member-declaration lines — those at its body's brace depth,
 * or its header (a primary constructor's parameters) — with comments and
 * string contents dropped; method, accessor and indexer bodies and nested
 * types are deeper and left out. Read once per class.
 */
function classMemberLines(cls: Node, context: ResolutionContext): Array<{ text: string; depth: number }> {
  let memo = MEMBER_LINES.get(context);
  if (!memo) MEMBER_LINES.set(context, (memo = new Map()));
  const hit = memo.get(cls.id);
  if (hit) return hit;
  const lines = context.getFileLines?.(cls.filePath) ?? context.readFile(cls.filePath)?.split(/\r?\n/) ?? [];
  const out: Array<{ text: string; depth: number }> = [];
  let depth = 0;
  let inComment = false;
  for (let line = cls.startLine; line <= cls.endLine; line++) {
    let raw = lines[line - 1] ?? '';
    if (inComment) {
      const close = raw.indexOf('*/');
      if (close < 0) continue;
      raw = raw.slice(close + 2);
      inComment = false;
    }
    let text = raw.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""').replace(/\/\*.*?\*\//g, ' ').replace(/\/\/.*$/, '');
    const open = text.indexOf('/*');
    if (open >= 0) {
      text = text.slice(0, open);
      inComment = true;
    }
    if (depth <= 1 && text.trim() !== '') out.push({ text, depth });
    for (const ch of text) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  memo.set(cls.id, out);
  return out;
}

/**
 * What a Java / C# / Kotlin type parameter of the class or method around a
 * call is bounded by: `ExceptionContext` for `T` in `class Test<T extends
 * ExceptionContext & Serializable>` / `where T : ExceptionContext` / `<T :
 * ExceptionContext>`, null when it is a type parameter with no named bound,
 * undefined when it is not a type parameter there at all.
 */
function typeParameterBound(typeName: string, ref: UnresolvedRef, context: ResolutionContext): string | null | undefined {
  const around = context.getNodesInFile(ref.filePath).filter((n) => n.startLine <= ref.line && n.endLine >= ref.line &&
    (MEMBER_CLASS_KINDS.has(n.kind) || n.kind === 'method' || n.kind === 'function'));
  return typeParameterBoundIn(typeName, around, context);
}

/** {@link typeParameterBound}, over the heads of the given declarations. */
function typeParameterBoundIn(typeName: string, decls: Node[], context: ResolutionContext): string | null | undefined {
  if (!/^[A-Z]\w*$/.test(typeName)) return undefined;
  const t = typeName;
  let declared = false;
  for (const n of decls) {
    const lines = context.getFileLines?.(n.filePath) ?? context.readFile(n.filePath)?.split(/\r?\n/) ?? [];
    const head = lines.slice(n.startLine - 1, n.startLine + 5).join(' ').split('{')[0]!;
    const bound = new RegExp(`[<,]\\s*(?:in\\s+|out\\s+|reified\\s+)?${t}\\s*(?:extends|:)\\s*([A-Z][\\w.]*)`).exec(head)?.[1] ??
      new RegExp(`\\bwhere\\s+${t}\\s*:\\s*([A-Z][\\w.]*)`).exec(head)?.[1];
    if (bound) return bound.split('.').pop()!;
    if (new RegExp(`[<,]\\s*(?:in\\s+|out\\s+|reified\\s+)?${t}\\s*[,>]`).test(head)) declared = true;
  }
  return declared ? null : undefined;
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
    // A pytest test's parameter is what its fixture returns: flaskbb's
    // `cli_runner.invoke(…)` is click's `CliRunner`, not the project's one `invoke`.
    if (!inferredType && ref.language === 'python' && dotMatch) inferredType = pythonFixtureReturnType(objectOrClass!, ref, context);
    if (!inferredType && MEMBER_TYPED_LANGUAGES.has(ref.language) && dotMatch) {
      inferredType = nmTimedT('mc-member', ref, () => inferMemberReceiverType(objectOrClass!, ref, context));
      // A field of a built-in type (`string _name`, `int count`) has no project method.
      if (inferredType && /^[a-z]/.test(inferredType)) return null;
    }
    // A type parameter is its bound; with none, only `Object`'s methods.
    if (inferredType && MEMBER_TYPED_LANGUAGES.has(ref.language) &&
        !context.getNodesByName(inferredType).some(isMethodOwnerKind)) {
      const bound = typeParameterBound(inferredType, ref, context);
      if (bound === null) return null;
      if (bound !== undefined) inferredType = bound;
    }
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
      if (typedMatch && ref.language === 'kotlin') {
        // `medium and 0xff` on an Int: the standard library's member, not a project `Int.and(Long)`.
        const target = context.getNodeById?.(typedMatch.targetNodeId);
        if (target && isKotlinNumberBitwise(target, ref)) return null;
      }
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
      // The receiver's declared type is one the project doesn't declare —
      // `List<Roshambo> list`, `String s`, `val sb = StringBuilder()` — so the
      // method is that outside type's. gson's `list.add(…)` went to a project
      // list wrapper's `add`, commons-lang's `s.length()` to a writer's.
      // (Only a type name — `java.util.List`, not a call chain like Python's
      // `Device.objects.create(…)` the initializer pattern also captures.)
      const typeName = inferredType.split('.').pop()!;
      if (/^[A-Z]/.test(typeName) &&
          !context.getNodesByName(typeName).some((n) => isMethodOwnerKind(n) && sameLanguageFamily(n.language, ref.language))) {
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
    let classCandidates = preferCallSiteFile(
      context.getNodesByName(objectOrClass!).filter(isMethodOwnerKind),
      ref.filePath,
    );
    // A C# class the call's namespaces can see before one they can't:
    // serilog's `Some.InformationEvent()` in Serilog.Tests is its own
    // Support namespace's `Some`, not the performance tests'.
    if (ref.language === 'csharp' && classCandidates.length > 1) {
      const typeRef = { ...ref, referenceName: objectOrClass! };
      const visible = classCandidates.filter((c) => c.language !== 'csharp' || isCsharpTypeVisible(c, typeRef, context));
      classCandidates = [...visible, ...classCandidates.filter((c) => !visible.includes(c))];
    }

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
    // A class method the named class inherits — Horse's `THorse.Get(…)` is
    // THorseCore's, three `class(…)` heads up — before any guess by name.
    const inherited = inheritedClassMethod(classCandidates.filter((c) => c.language === ref.language), methodName!, context);
    if (inherited) return { original: ref, targetNodeId: inherited.id, confidence: 0.8, resolvedBy: 'qualified-name' };
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

  // A receiver written as a type name the project doesn't declare
  // (`Exception.Create(…)` in Delphi, `Collections.sort(…)`) is a type from
  // outside it: a same-named method of some project type is a guess. horse's
  // `Exception.Create` went to its own `EHorseException::Create` 44 times.
  // A C# using alias names its type: `using Assert = Newtonsoft.Json.Tests.XUnitAssert;`.
  const aliased = ref.language === 'csharp' ? csharpUsingAlias(objectOrClass!, ref, context) : null;
  if (aliased) {
    return resolveMethodOnType(aliased, methodName!, ref, context, 0.9, 'instance-method', undefined);
  }

  // In C# and Java a capitalized receiver the class around it doesn't declare
  // is a type — a project property of that name elsewhere (a test object's
  // `DateTime`) does not make `DateTime.Parse(…)` the project's.
  const typesOnly = ref.language === 'csharp' || ref.language === 'java' || ref.language === 'rust';
  if (namesExternalType(objectOrClass!, ref.language) &&
      !context.getNodesByName(objectOrClass!).some((n) => sameLanguageFamily(n.language, ref.language) &&
        (!typesOnly || isMethodOwnerKind(n) || n.kind === 'enum' || n.kind === 'namespace' || n.kind === 'module' ||
          n.kind === 'trait' || n.kind === 'type_alias'))) {
    return null;
  }
  // Rust `task::spawn(…)` / `io::stdout()`: a function through a module path —
  // never a method some type of that name owns.
  if (ref.language === 'rust' && match === colonMatch && /^[a-z_][\w]*(?:::[a-z_]\w*)*$/.test(objectOrClass!)) {
    return null;
  }
  // `string.Equals(…)`, `object.ReferenceEquals(…)`: a C# keyword type.
  if (ref.language === 'csharp' && /^(?:string|object|int|long|short|byte|bool|char|double|float|decimal|uint|ulong|ushort|sbyte)$/.test(objectOrClass!)) {
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
    let targetMethods = sameLanguageMethods.length > 0 ? sameLanguageMethods : methods;
    // A receiver the file imports is another module's value: never a method
    // declared in the calling file. expo-camera's `CameraManager.isAvailableAsync()`
    // (`import CameraManager from './ExpoCameraManager'`) went to `CameraView`'s
    // own static `isAvailableAsync` — the method making the call.
    // Ruling the caller's file out may reject a guess; it must never
    // manufacture one — the one method left is then no likelier than before.
    let narrowed = false;
    if (JS_FAMILY.has(ref.language) && isImportBinding(objectOrClass!, ref, context)) {
      const kept = targetMethods.filter((m) => m.filePath !== ref.filePath);
      narrowed = kept.length !== targetMethods.length;
      targetMethods = kept;
    }
    // Ruling these out must not leave a lone other `destroy` to guess at.
    {
      const kept = targetMethods.filter((m) => !(DISPATCHED_ACTIONS.has(m.name) &&
        DISPATCHED_OWNER.test(m.qualifiedName.slice(0, Math.max(0, m.qualifiedName.lastIndexOf('::'))).split(/::|\./).pop()!)) &&
        !isKotlinNumberBitwise(m, ref));
      narrowed ||= kept.length !== targetMethods.length;
      targetMethods = kept;
    }
    // Production code never calls into a test suite: a guess from
    // rest_framework/renderers.py's `view.reverse_action(…)` is not a test's
    // `DummyView`. The test's methods were never in the running.
    if (!isTestPath(ref.filePath)) targetMethods = targetMethods.filter((m) => !isTestPath(m.filePath));
    // A Vue component's own method is reached as `this.m()` inside it —
    // never as `e.preventDefault()` on an event, nor `this.editor.setValue()`
    // on something the component holds. A template ref
    // (`this.$refs.form.validate()`) names a child this cannot tell apart.
    if (JS_FAMILY.has(ref.language)) {
      const kept = targetMethods.filter((m) => !isVueComponentMethod(m) || (objectOrClass === 'this' && m.filePath === ref.filePath));
      narrowed ||= kept.length !== targetMethods.length;
      targetMethods = kept;
    }

    // If only one same-language method with this name exists, use it —
    // except in Ruby, where nothing types a receiver: there the one method
    // must also belong to something the receiver is named after
    // (`web_push_request.legacy_encrypt` → WebPushRequest). rubocop's
    // `node.loc` on a rubocop-ast node went to the one `loc` in the project
    // 1,201 times; lobsters' `value.to_s` to a short-id class's.
    if (targetMethods.length === 1 && !narrowed && targetMethods[0]!.language === ref.language &&
        // A test double is only what a test names — as in the scoring below:
        // allauth's `resp.json()` on a Django test response is not the one
        // `json` of its `MockedResponse`.
        !isUnnamedTestDouble(targetMethods[0]!, objectOrClass!, ref, context) &&
        !((ref.language === 'lua' || ref.language === 'luau') && isLuaLibraryCall(objectOrClass!, methodName!, ref, targetMethods[0]!)) &&
        // Rust / Go / Kotlin / C#: a standard-library method name on an
        // untyped receiver (`sym.map(…)`, `w.Header().Get(…)`,
        // `reader.Value.ToString()`) is the library type's.
        !(stdMethodNames(ref.language)?.has(methodName!) &&
          !/^(?:self|Self|this|base)$/.test(objectOrClass!) && !receiverNamesOwner(receiverLink(objectOrClass!), targetMethods[0]!, context)) &&
        !(UNTYPED_RECEIVER_LANGUAGES.has(ref.language) && !/^(?:self|self\.class|this|super|weak_?self|strong_?self)$/i.test(objectOrClass!) &&
          !sharesReceiverWord(objectOrClass!, targetMethods[0]!) &&
          !(ref.language === 'objc' && objcReceiverReaches(objectOrClass!, targetMethods[0]!, context)) &&
          !(ref.language === 'php' && phpReceiverReaches(objectOrClass!, targetMethods[0]!, context)))) {
      return {
        original: ref,
        targetNodeId: targetMethods[0]!.id,
        confidence: 0.7,
        resolvedBy: 'instance-method',
      };
    }

    // Multiple methods: score by receiver name word overlap with class name
    if (targetMethods.length > 1) {
      // What the receiver is named after is its last link: `builder.tokeniser`
      // is a Tokeniser, `table.Columns` no kind of table.
      const receiverWords = splitCamelCase(receiverLink(objectOrClass!));
      const head = receiverWords[receiverWords.length - 1]?.toLowerCase();
      let bestMatch: typeof targetMethods[0] | undefined;
      let bestScore = 0;

      // Same-file candidates first, so a score tie (`score > bestScore` keeps
      // the first seen) resolves to the call site's own file rather than the
      // first-indexed duplicate (#1079).
      const std = stdMethodNames(ref.language)?.has(methodName!) && !/^(?:self|Self|this|base)$/.test(objectOrClass!);
      for (const method of preferCallSiteFile(targetMethods, ref.filePath)) {
        if (std && !receiverNamesOwner(receiverLink(objectOrClass!), method, context)) continue;
        // The owner type's own name — not its namespace (`eShop.ClientApp…`
        // shares `Client` with every `httpClient`) nor the method's.
        const cut = method.qualifiedName.lastIndexOf('::');
        const classWords = cut > 0 ? splitCamelCase(method.qualifiedName.slice(0, cut).split(/::|\./).pop()!) : [];
        let score = receiverWords.filter(w =>
          classWords.some(cw => cw.toLowerCase() === w.toLowerCase())
        ).length;
        // A test double is only what a test constructs or names — never a
        // guess from `response.json()` (mealie's `_FakeHTTPResponse`) in a
        // file that never mentions it.
        if (TEST_DOUBLE_OWNER.test(classWords.join(' ')) && !receiverWords.some((w) => TEST_DOUBLE_OWNER.test(w)) &&
            !(context.readFile(ref.filePath) ?? '').includes(method.qualifiedName.slice(0, cut).split(/::|\./).pop()!)) continue;
        // The receiver's head noun naming the owner's: `bookPage` is a Page
        // before it is anything of a Book's.
        if (head !== undefined && head === classWords[classWords.length - 1]?.toLowerCase()) score += 1;
        // Bonus for same language
        if (method.language === ref.language) score += 1;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = method;
        }
      }

      // A wrapper handing its call on — BookStack's `FileStorage::delete` doing
      // `$storage->delete($path)`, `CommentRepo::delete` doing
      // `$comment->delete()` — names the caller's own class only by a shared
      // word. The guess is the caller itself, so there is no guess.
      if (bestMatch && bestScore >= 2 && bestMatch.id !== ref.fromNodeId) {
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

/** A method a Vue Options API component declares for itself (`index::handleLogin` in `index.vue`). */
function isVueComponentMethod(n: Node): boolean {
  return n.kind === 'method' && n.filePath.endsWith('.vue') && n.qualifiedName === `${path.posix.basename(n.filePath, '.vue')}::${n.name}`;
}

/** Is `ref` written as `this.<name>(` in the file that declares `n`? */
function isThisCallInOwnFile(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (n.filePath !== ref.filePath) return false;
  const line = (context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/))?.[ref.line - 1] ?? '';
  return new RegExp(String.raw`\bthis\s*\??\.\s*${n.name.replace(/\$/g, '\\$')}\s*\(`).test(line);
}

/** Is the root of a member call's receiver (`CameraManager` in `CameraManager.x`) one of the file's imports? */
function isImportBinding(receiver: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const root = receiver.split('.')[0]!;
  return context.getImportMappings?.(ref.filePath, ref.language)?.some((m) => m.localName === root) === true;
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

/**
 * A bare call through a name destructured from a call's result — a composable
 * or custom hook, `const { getDefaultActivityRoute } = useDefaultActivity()`
 * (mealie), `const { login } = useAuth()` — is the function the callee returns
 * under that key: one declared in the callee's own body, else a top-level one
 * of the callee's module (returned as `{ getDefaultActivityRoute, … }`). The
 * callee is resolved through the file's imports (or found in the same file),
 * and its source must return the key; a later declaration of the name at the
 * call's scope shadows the binding. The local binding otherwise ruled out
 * every cross-file candidate, so the call resolved to nothing.
 */
function matchDestructuredCallResult(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const source = context.readFile(ref.filePath);
  if (!source || !/\b(?:const|let|var)\s*\{/.test(source)) return null;
  const name = ref.referenceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = source.split('\n');
  const before = lines.slice(0, ref.line - 1).concat(lines[ref.line - 1]?.slice(0, ref.column) ?? '').join('\n');
  const code = blankStringContents(stripCommentsForRegex(before, 'typescript'));
  const binding = /\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g;
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
    let key: string | null = null;
    for (const part of m[1]!.split(',')) {
      const [k, v] = part.split(':').map((x) => x.trim().replace(/\s*=.*$/, ''));
      if ((v ?? k) === ref.referenceName && /^[A-Za-z_$][\w$]*$/.test(k ?? '')) key = k!;
    }
    if (!key) continue;
    if (!stackAt(m.index!).every((pos, i) => callScope[i] === pos)) continue;
    const rest = code.slice(m.index! + m[0].length);
    if (new RegExp(`\\b(?:const|let|var|function|class)\\s+(?:${name}\\b|\\{[^}]*\\b${name}\\b)`).test(rest)) return null;
    const calleeName = m[2]!;
    const imported = context.resolveImport?.({ ...ref, referenceName: calleeName, referenceKind: 'calls' });
    // Through the import; else the same file's; else the one function of that
    // name in the project (an alias the import resolver can't follow, like
    // Nuxt's `~/composables/…`) — the returned key is checked below either way.
    const holders = context.getNodesByName(calleeName).filter((n) =>
      (n.kind === 'function' || n.kind === 'constant' || n.kind === 'variable') && sameLanguageFamily(n.language, ref.language));
    const callee = (imported && context.getNodeById?.(imported.targetNodeId)) ??
      holders.find((n) => n.filePath === ref.filePath) ??
      (holders.length === 1 ? holders[0] : undefined);
    if (!callee || !sameLanguageFamily(callee.language, ref.language)) return null;
    const calleeText = (context.getFileLines?.(callee.filePath) ?? context.readFile(callee.filePath)?.split('\n') ?? [])
      .slice(callee.startLine - 1, callee.endLine).join('\n');
    if (!new RegExp(`\\breturn\\s*\\{[^]*?\\b${key}\\b`).test(calleeText)) return null;
    const callable = (n: Node) => n.kind === 'function' || n.kind === 'method' || n.kind === 'constant' || n.kind === 'variable';
    const inFile = context.getNodesInFile(callee.filePath);
    const inner = inFile.filter((n) => n.name === key && callable(n) && n.id !== callee.id && rangeWithin(n, callee) &&
      !inFile.some((f) => f.id !== callee.id && f.id !== n.id && (f.kind === 'function' || f.kind === 'method') &&
        rangeWithin(f, callee) && rangeWithin(n, f) && !sameRange(f, n)));
    const top = inner.length > 0 ? inner : inFile.filter((n) => n.name === key && callable(n) && !n.qualifiedName.includes('::') &&
      !inFile.some((f) => (f.kind === 'function' || f.kind === 'method') && f.id !== n.id && rangeWithin(n, f) && !sameRange(f, n)));
    const target = top.sort((a, b) => Number(b.kind === 'function') - Number(a.kind === 'function'))[0];
    if (!target) return null;
    return { original: ref, targetNodeId: target.id, confidence: 0.85, resolvedBy: 'instance-method' };
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
 * infer a property type. Framework resolution runs before this guard. Vue,
 * Svelte and Astro files keep resolving them: there `api.groupReports.getAll()`
 * reaches its API client class far more often than a wrong namesake. */
export function isUnresolvedJsMemberCall(ref: UnresolvedRef): boolean {
  return ref.referenceKind === 'calls' && JS_TS.has(ref.language) &&
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
/**
 * Whether a receiver written as `Name` is a type in `language`'s conventions.
 * Not in Go (an exported package variable is `FormPost`), nor C / C++ / Rust
 * (their type paths use `::`); in Pascal every identifier is capitalized, so
 * only Delphi's type prefixes (`TFoo`, `EFoo`, `IFoo`) and `Exception` count —
 * `AWebRequest` / `LRequest` are a parameter and a local.
 */
function namesExternalType(receiver: string, language: string): boolean {
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(receiver)) return false;
  if (language === 'pascal') return /^(?:[TEI][A-Z]\w*|Exception)$/.test(receiver);
  // Rust: `Vec::new()`, `String::from(…)`, `Default::default()` — but `Self::` is the impl's own type,
  // and a SCREAMING_CASE receiver (`REQ_ID.scope(…)`) a static.
  if (language === 'rust') return receiver !== 'Self' && /[a-z]/.test(receiver);
  return !['go', 'c', 'cpp', 'cuda', 'metal'].includes(language);
}

/**
 * Languages whose receivers nothing types, where a unique method name alone
 * is no evidence: CFML's `server.keyExists()` is the struct member function,
 * not the one component method named `keyExists`; Objective-C's
 * `image.respondsToSelector:` is NSObject's, not a proxy class's override;
 * PHP's `$request->has()` is the framework request's, not a settings
 * service's.
 */
const UNTYPED_RECEIVER_LANGUAGES: ReadonlySet<string> = new Set(['ruby', 'cfml', 'cfscript', 'objc', 'php']);

/**
 * Lua's standard and host libraries: a call through one of these tables is
 * the library's, never the one project method that shares its name (busted's
 * `assert.truthy` went to a condition helper 987 times, `string.find` to a
 * picker's `find`, Neovim's `vim.split` to a build module's).
 */
const LUA_LIBRARY_TABLES: ReadonlySet<string> = new Set([
  'string', 'table', 'math', 'io', 'os', 'coroutine', 'debug', 'utf8', 'package', 'bit', 'bit32', 'jit', 'ffi',
  'vim', 'ngx', 'assert', 'spy', 'stub', 'mock', 'love',
]);
/** Lua string methods, reached with `s:find(…)` on any string. */
const LUA_STRING_METHODS: ReadonlySet<string> = new Set([
  'find', 'match', 'gmatch', 'gsub', 'sub', 'format', 'upper', 'lower', 'len', 'rep', 'byte', 'reverse',
]);

/**
 * Whether a Lua call is a library's rather than `candidate`: through a library
 * table the project doesn't patch itself (kong's globalpatches do define
 * `ngx.sleep`), or a string method on a value.
 */
function isLuaLibraryCall(receiver: string, method: string, ref: UnresolvedRef, candidate: Node): boolean {
  const root = receiver.split(/[.:]/)[0]!;
  if (LUA_LIBRARY_TABLES.has(root)) return candidate.qualifiedName.split(/::|\./)[0] !== root;
  return LUA_STRING_METHODS.has(method) && ref.referenceName.endsWith(`:${method}`);
}

/**
 * Whether a receiver is named after the owner of `method`, case aside: the
 * receiver's last segment is the owner's name (`cbsecurity` → CBSecurity), or
 * they share a word of three letters or more (`web_push_request` →
 * WebPushRequest, `executor1` → Executor, `decodedImage` → UIImage).
 */
function sharesReceiverWord(receiver: string, method: Node): boolean {
  const cut = method.qualifiedName.lastIndexOf('::');
  if (cut < 0) return false;
  const ownerQn = method.qualifiedName.slice(0, cut);
  const flat = (w: string) => w.replace(/[^A-Za-z0-9]/g, '').replace(/\d+$/, '').toLowerCase();
  if (flat(receiver.split('.').pop()!) === flat(ownerQn.split(/::|\./).pop()!)) return true;
  // Two-letter words are class prefixes (`SD`, `NS`, `UI`), not names.
  const owner = new Set(splitCamelCase(ownerQn).map(flat).filter((w) => w.length > 2));
  return splitCamelCase(receiver).some((w) => owner.has(flat(w)));
}

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
  const javaBare = ref.language === 'java' && ref.referenceKind === 'calls' && /^[A-Za-z_$][\w$]*$/.test(ref.referenceName);
  const dartBare = ref.language === 'dart' && ref.referenceKind === 'calls' && /^[A-Za-z_$][\w$]*$/.test(ref.referenceName) && isReceiverLessDartCall(ref, context);
  const kotlinCall = ref.language === 'kotlin' && ref.referenceKind === 'calls' && /^[A-Za-z_$][\w$]*$/.test(ref.referenceName);
  const kotlinBare = kotlinCall && isReceiverLessKotlinCall(ref, context);
  const rubyBare = ref.language === 'ruby' && ref.referenceKind === 'calls' && /^[A-Za-z_]\w*[?!]?$/.test(ref.referenceName);
  const cfmlBare = (ref.language === 'cfml' || ref.language === 'cfscript') && ref.referenceKind === 'calls' && /^[A-Za-z_]\w*$/.test(ref.referenceName);
  const vbReceiver = ref.language === 'vbnet' && (ref.referenceKind === 'calls' || ref.referenceKind === 'instantiates') && /^\w+$/.test(ref.referenceName)
    ? vbReceiverOf(ref, context) : null;
  const objcShape = ref.language === 'objc' && ref.referenceKind === 'calls' && /^[A-Za-z_]\w*:*(?:\w+:)*$/.test(ref.referenceName)
    ? objcCallShape(ref, context) : null;
  const csharpBare = ref.language === 'csharp' && (ref.referenceKind === 'calls' || ref.referenceKind === 'references') && /^[A-Za-z_]\w*$/.test(ref.referenceName);
  const scalaBare = ref.language === 'scala' && ref.referenceKind === 'calls' && /^[A-Za-z_$][\w$]*$/.test(ref.referenceName);
  const rustGoShape = (ref.language === 'rust' || ref.language === 'go') && ref.referenceKind === 'calls' && /^[A-Za-z_]\w*$/.test(ref.referenceName)
    ? rustGoCallShape(ref, context) : null;
  const kotlinStdChain = ref.language === 'kotlin' && ref.referenceKind === 'calls' && KOTLIN_STD_METHODS.has(ref.referenceName)
    ? kotlinChainReceiver(ref, context) : null;
  const swiftShape = ref.language === 'swift' && ref.referenceKind === 'calls' && /^[A-Za-z_]\w*$/.test(ref.referenceName)
    ? swiftCallShape(ref, context) : null;
  const phpSelf = phpSelfReceiver(ref, context);
  // Names are case-sensitive in every language but a handful: Rust's
  // `Bytes` is not the method `bytes`, Python's builtin `dir(…)` not a class
  // `Dir`, halo's `type RsbuildConfig` not its local `rsbuildConfig`, a Java
  // `Node` not a `node()`. Only PHP, Pascal/Delphi, CFML, COBOL and VB.NET
  // resolve a name without regard to case, which is what this fallback's
  // lowercase index is for.
  const bareR = isBareRCall(ref, context);
  const solidityBare = isReceiverLessSolidityCall(ref, context);
  const callableCandidates = candidates.filter((n) => callableKinds.has(n.kind) && !(typeRef && !canNameInTypePosition(n)) &&
    !(bareR && n.kind === 'method') &&
    !(solidityBare && !isSolidityMemberInScope(n, ref, context)) &&
    // `new …MockData()` makes an instance of a type; a method is never what it names.
    !(ref.referenceKind === 'instantiates' && n.kind === 'method') &&
    !(rustBare && !isRustNameInScope(n, ref, context)) &&
    !(!CASE_INSENSITIVE_LANGUAGES.has(ref.language) && n.name !== ref.referenceName) &&
    !(pythonShape && !fitsPythonCallShape(n, pythonShape, ref, context)) &&
    !(javaBare && n.kind === 'method' && !isJavaMethodInScope(n, ref, context)) &&
    !(dartBare && isDartMember(n) && !isDartMethodInScope(n, ref, context)) &&
    !(kotlinCall && !isKotlinTopLevelVisible(n, ref, context)) &&
    !(kotlinBare && !isKotlinMemberReachable(n, ref, context)) &&
    !isKotlinNumberBitwise(n, ref) &&
    !(rubyBare && n.kind === 'method' && !isRubyMethodInScope(n, ref, context)) &&
    !(cfmlBare && n.kind === 'method' && !isCfmlMethodInScope(n, ref, context)) &&
    !(vbReceiver !== null && !isVbMemberReachable(n, vbReceiver)) &&
    !(objcShape === 'c-call' && OBJC_MEMBER_KINDS.has(n.kind)) &&
    !(objcShape === 'self-send' && !isObjcSelfSendTarget(n, ref, context)) &&
    !(objcShape === 'super-send' && !isObjcSelfSendTarget(n, ref, context, true)) &&
    !(csharpBare && !isCsharpMemberInScope(n, ref, context)) &&
    !(scalaBare && !isScalaMemberInScope(n, ref, context)) &&
    !(rustGoShape && !isRustGoCallTarget(n, rustGoShape)) &&
    !(kotlinStdChain !== null && !isKotlinStdChainTarget(n, kotlinStdChain)) &&
    !(swiftShape && !isSwiftCallTarget(n, swiftShape, ref, context)) &&
    !(phpSelf && (n.kind !== 'method' || !isPhpMethodInScope(n, ref, phpSelf, context))))
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
      (TYPE_MEMBER_KINDS.has(finalCandidates[0]!.kind) ||
        (finalCandidates[0]!.filePath !== ref.filePath && isLocallyBoundJsName(ref.referenceName, ref.filePath, context)))) &&
    !(JS_FAMILY.has(ref.language) && isOutOfRepoBinding(ref.referenceName, ref, context)) &&
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
  const result = gateLanguageMatch(matchReferenceInner(ref, context), ref, context);
  // `this.container.classList.toggle()` inside `toggle()`, `window.$events
  // .listen()` inside `listen()`, Scala's `requestToArmeria(request).execute()`
  // inside `execute()`: a member of what the receiver is, which is the calling
  // method only through a TS/JS field of the caller's own type.
  if (result && result.targetNodeId === ref.fromNodeId && isCollapsedNonRecursion(ref, context)) return null;
  // A name the calling JS/TS function binds itself shadows the file's own:
  // lodash's `mixin(object, …)` calling `object(this.__wrapped__)` is its
  // parameter, whichever strategy (fuzzy included) found a `function object`.
  if (result && JS_LOCAL_REF_KINDS.has(ref.referenceKind)) {
    const target = context.getNodeById?.(result.targetNodeId);
    // (A target of another name is what the local was followed to: `const
    // selected = useStore(s => s.reset); selected()` is the store's `reset`.)
    if (target && target.name === ref.referenceName && isOutsideJsLocal(target, ref, context)) return null;
  }
  // C has no methods, and C code cannot call a C++ one: hiredis' function
  // pointer `c->funcs->read(c, buf, …)` is no Qt adapter's `read`.
  if (result && ref.language === 'c' && ref.referenceKind === 'calls' &&
      context.getNodeById?.(result.targetNodeId)?.kind === 'method') return null;
  // A type never inherits from itself: cats' `trait BigDecimalInstances extends
  // cats.kernel.instances.BigDecimalInstances` and `trait AllOps … with
  // Bifoldable.AllOps` name another type of their own name.
  if (result && result.targetNodeId === ref.fromNodeId && isInheritanceRef(ref)) return otherSupertypeNamed(ref, context);
  // Nor does a value's initializer call the value: sttp's `val response =
  // basicRequest.get(…).response(asStringAlways)` is a request's `response`.
  if (result && result.targetNodeId === ref.fromNodeId && ref.referenceKind === 'calls' &&
      VALUE_KINDS.has(context.getNodeById?.(ref.fromNodeId)?.kind ?? '')) return null;
  return result ? retargetSelfOverload(result, ref, context) : result;
}

/**
 * The supertype an inheritance ref names when the name is the declaring
 * type's own: another type of that name — the one the written qualifier
 * (`cats.kernel.instances.`, `Bifoldable.`) leads to, by its owner and its
 * file's package. Null unless exactly one fits.
 */
function otherSupertypeNamed(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const name = ref.referenceName.split(/::|\./).pop()!;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split(/\r?\n/)[ref.line - 1] ?? '';
  const written = new RegExp(`^\\s*((?:[\\w$]+\\.)+)${name.replace(/\$/g, '\\$')}\\b`).exec(line.slice(Math.max(0, ref.column)));
  const qualifier = written ? written[1]!.slice(0, -1) : '';
  const candidates = context.getNodesByName(name).filter((n) =>
    n.id !== ref.fromNodeId && isSupertypeTarget(n) && sameLanguageFamily(n.language, ref.language) &&
    (qualifier === '' || ownerPathOf(n, context) === qualifier || ownerPathOf(n, context).endsWith(`.${qualifier}`)));
  return candidates.length === 1 ? { original: ref, targetNodeId: candidates[0]!.id, confidence: 0.8, resolvedBy: 'qualified-name' } : null;
}

/** A declaration's dotted owner path — its file's package clauses, then its enclosing types (`cats.kernel.instances`, `cats.Bifoldable`). */
function ownerPathOf(n: Node, context: ResolutionContext): string {
  const text = context.readFile(n.filePath) ?? '';
  const pkg = [...text.matchAll(/^\s*package\s+([\w.]+)\s*;?\s*$/gm)].map((m) => m[1]!).join('.');
  const cut = n.qualifiedName.lastIndexOf('::');
  const owners = cut > 0 ? n.qualifiedName.slice(0, cut).replace(/::/g, '.') : '';
  return [pkg, owners].filter((p) => p !== '' && !(pkg !== '' && p === owners && owners.startsWith(pkg))).join('.');
}

/** Reference kinds a bare JS/TS local can be: a call, a value, a construction. */
const JS_LOCAL_REF_KINDS: ReadonlySet<string> = new Set(['calls', 'references', 'function_ref', 'instantiates']);

/** Node kinds that hold a value rather than run code. */
const VALUE_KINDS: ReadonlySet<string> = new Set(['variable', 'constant', 'field', 'property']);

/** Languages whose methods overload by arity. */
const OVERLOADING_LANGUAGES: ReadonlySet<string> = new Set(['csharp', 'java', 'kotlin', 'swift', 'cpp', 'scala', 'dart', 'vbnet']);

/**
 * A call a method makes to its own name, with arguments its own parameters
 * cannot take, is to another overload of it: Newtonsoft's
 * `DeserializeXNode(value)` body `return DeserializeXNode(value, null);`
 * bound to itself, so the two-argument overload never saw the one-argument
 * one among its callers. The same-owner overload the argument count fits.
 */
type Arity = { min: number; max: number } | null;
/** Per context: node id → its same-owner overloads with their arities (null: none). */
const OVERLOAD_SETS = new WeakMap<ResolutionContext, Map<string, { name: string; own: Arity; siblings: Array<{ id: string; arity: Arity }> } | null>>();

function retargetSelfOverload(result: ResolvedRef, ref: UnresolvedRef, context: ResolutionContext): ResolvedRef {
  if (ref.referenceKind !== 'calls' || !OVERLOADING_LANGUAGES.has(ref.language)) return result;
  // C++ overload sets (templates, SFINAE tags, a `data()` on any container) are
  // only trusted for a method's call to itself.
  if (ref.language === 'cpp' && result.targetNodeId !== ref.fromNodeId) return result;
  let memo = OVERLOAD_SETS.get(context);
  if (!memo) OVERLOAD_SETS.set(context, (memo = new Map()));
  let set = memo.get(result.targetNodeId);
  if (set === undefined) {
    set = overloadSetOf(result.targetNodeId, context);
    memo.set(result.targetNodeId, set);
  }
  // Only an overload set has a sibling to move to.
  if (!set || set.own === null) return result;
  const args = cppParenListAfter(ref.filePath, ref.line, Math.max(0, ref.column), set.name, context);
  if (args === null) return result;
  const argc = args.trim() === '' ? 0 : splitCppTopLevel(args).length;
  if (argc >= set.own.min && argc <= set.own.max) return result;
  const fits = set.siblings.filter((s) => s.arity !== null && argc >= s.arity.min && argc <= s.arity.max);
  return fits.length === 1 ? { ...result, targetNodeId: fits[0]!.id } : result;
}

/** A method's same-owner overloads and every one's arity, read from its declaration. */
function overloadSetOf(id: string, context: ResolutionContext): { name: string; own: Arity; siblings: Array<{ id: string; arity: Arity }> } | null {
  const self = context.getNodeById?.(id);
  if (!self || (self.kind !== 'method' && self.kind !== 'function')) return null;
  const name = self.name;
  const owner = self.qualifiedName.slice(0, Math.max(0, self.qualifiedName.lastIndexOf('::')));
  const siblings = (context.getNodesInFileNamed?.(self.filePath, name) ?? context.getNodesInFile(self.filePath).filter((n) => n.name === name))
    .filter((n) => n.id !== self.id && (n.kind === 'method' || n.kind === 'function') &&
      n.qualifiedName.slice(0, Math.max(0, n.qualifiedName.lastIndexOf('::'))) === owner);
  if (siblings.length === 0) return null;
  const arity = (n: Node): Arity => {
    const list = cppParenListAfter(n.filePath, n.startLine, 0, name, context);
    if (list === null) return null;
    const params = splitCppTopLevel(list).filter((p) => p !== '' && p !== 'void');
    const pack = (p: string) => /\.\.\.|\bparams\s|\bvararg\s/.test(p.replace(/<[^<>]*>/g, ''));
    const min = params.filter((p) => !/=/.test(p) && !pack(p)).length;
    return { min, max: params.some(pack) ? Infinity : params.length };
  };
  return { name, own: arity(self), siblings: siblings.map((n) => ({ id: n.id, arity: arity(n) })) };
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

  // `import java.lang.reflect.Field;` — the file's `Field` is the JDK's, never
  // a project class of that name (gson's production code bound it to a test's
  // nested `ParameterizedTypesTest.Field`).
  if ((ref.language === 'java' || ref.language === 'kotlin') && ref.referenceKind !== 'imports' &&
      isJavaOutsideImport(ref.referenceName.split('.')[0]!, ref, context)) {
    return null;
  }

  // A symbolic name in a Scala type is a type (`F ~> G`) or a kind-projector
  // placeholder (`Either[A, *]`) — never an operator method, by any strategy.
  if (ref.language === 'scala' && ref.referenceKind === 'references' && /^[^\w\s]+$/.test(ref.referenceName)) {
    const types = context.getNodesByName(ref.referenceName).filter((n) => n.language === 'scala' && (SCALA_TYPE_KINDS.has(n.kind) || n.kind === 'type_alias'));
    const chosen = types.length > 1 ? preferCallSiteFile(types, ref.filePath) : types;
    return chosen.length === 1 ? { original: ref, targetNodeId: chosen[0]!.id, confidence: 0.8, resolvedBy: 'exact-match' } : null;
  }

  // A bare Lua call through a `local` alias reaches what the alias names.
  if ((ref.language === 'lua' || ref.language === 'luau') && ref.referenceKind === 'calls' && /^[A-Za-z_]\w*$/.test(ref.referenceName)) {
    const aliased = luaAliasTarget(ref, context);
    if (aliased !== undefined) return aliased;
    // `ipairs(t)` is Lua's, unless the file defines its own: telescope's 122
    // `for _, v in ipairs(…)` went to a linked list's `ipairs` method.
    if (LUA_GLOBAL_FUNCTIONS.has(ref.referenceName) &&
        !context.getNodesInFile(ref.filePath).some((n) => n.name === ref.referenceName && n.kind === 'function')) return null;
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
        // Another module's function is called bare only through `-import(Mod,
        // [f/N])` (or from a `.hrl` a module includes): cowboy's
        // `-import(req_SUITE, [do_get/3])` went to compress_SUITE's `do_get/3`.
        const imported = erlangImportedModule(am[1]!, am[2]!, ref, context);
        if (imported !== undefined) {
          const chosen = candidates.find((n) => n.qualifiedName.startsWith(`${imported}::`));
          return chosen ? { original: ref, targetNodeId: chosen.id, confidence: 0.9, resolvedBy: 'exact-match' } : null;
        }
        if (!/\.hrl$/.test(ref.filePath)) {
          const included = candidates.filter((n) => /\.hrl$/.test(n.filePath));
          if (included.length === 0) return null;
          candidates.splice(0, candidates.length, ...included);
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

  // 5. A C / C++ name qualified by a namespace the project opens with a macro
  // (`fmt::format` — `FMT_BEGIN_NAMESPACE`), which the index cannot see.
  if ((ref.language === 'cpp' || ref.language === 'c') && ref.referenceName.includes('::')) {
    return matchCppMacroNamespaced(ref, context);
  }

  return null;
}

const SOLIDITY_SUPERS = new WeakMap<ResolutionContext, Map<string, string[]>>();
const SOLIDITY_HIERARCHIES = new WeakMap<ResolutionContext, WeakMap<UnresolvedRef, Set<string>>>();
const SOLIDITY_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'struct', 'module', 'trait']);

/** What a Solidity contract, interface or library inherits: `contract Governor is Context, ERC165(…), IGovernor {`. */
function soliditySupertypesOf(name: string, context: ResolutionContext): string[] {
  let memo = SOLIDITY_SUPERS.get(context);
  if (!memo) SOLIDITY_SUPERS.set(context, (memo = new Map()));
  const hit = memo.get(name);
  if (hit) return hit;
  const supers: string[] = [];
  for (const decl of context.getNodesByName(name)) {
    if (decl.language !== 'solidity' || !SOLIDITY_TYPE_KINDS.has(decl.kind)) continue;
    const lines = context.getFileLines?.(decl.filePath) ?? context.readFile(decl.filePath)?.split(/\r?\n/) ?? [];
    let depth = 0;
    let head = '';
    for (const ch of lines.slice(decl.startLine - 1, decl.startLine + 10).join(' ').replace(/\/\/[^\n]*|\/\*.*?\*\//g, ' ')) {
      if (ch === '{' && depth === 0) break;
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0) head += ch;
    }
    const clause = /\bis\b([\s\S]*)$/.exec(head)?.[1] ?? '';
    for (const m of clause.matchAll(/([A-Za-z_]\w*)\s*(?=,|$)/g)) supers.push(m[1]!);
  }
  memo.set(name, supers);
  return supers;
}

/**
 * Whether a bare Solidity call can reach method `n`: a function of the
 * contract around the call or of one it inherits, or a free function.
 * OpenZeppelin's `_msgSender()` in Governor (a Context) went to
 * ERC2771Context's override 83 times.
 */
function isSolidityMemberInScope(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (n.kind !== 'method' || n.language !== 'solidity') return true;
  const cut = n.qualifiedName.lastIndexOf('::');
  if (cut <= 0) return true;
  const owner = n.qualifiedName.slice(0, cut).split('::').pop()!;
  let memo = SOLIDITY_HIERARCHIES.get(context);
  if (!memo) SOLIDITY_HIERARCHIES.set(context, (memo = new WeakMap()));
  let names = memo.get(ref);
  if (!names) {
    names = new Set<string>();
    const queue = context.getNodesInFile(ref.filePath)
      .filter((c) => SOLIDITY_TYPE_KINDS.has(c.kind) && c.startLine <= ref.line && c.endLine >= ref.line)
      .map((c) => c.name);
    while (queue.length > 0 && names.size < 60) {
      const name = queue.shift()!;
      if (names.has(name)) continue;
      names.add(name);
      queue.push(...soliditySupertypesOf(name, context));
    }
    memo.set(ref, names);
  }
  return names.has(owner);
}

/** Whether a Solidity call is written with no receiver (`_msgSender()`, not `token._msgSender()`). */
function isReceiverLessSolidityCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.language !== 'solidity' || ref.referenceKind !== 'calls' || !/^[A-Za-z_]\w*$/.test(ref.referenceName)) return false;
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split('\n')[ref.line - 1];
  if (!line) return false;
  const m = new RegExp(`(?<![\\w$])${ref.referenceName}\\s*\\(`).exec(line);
  return !!m && !/\.\s*$/.test(line.slice(0, m.index));
}

/** The module an Erlang file `-import`s `name/arity` from, or undefined. */
function erlangImportedModule(name: string, arity: string, ref: UnresolvedRef, context: ResolutionContext): string | undefined {
  const source = context.readFile(ref.filePath);
  if (!source || !source.includes('-import')) return undefined;
  const fn = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const m of source.matchAll(/^-import\(\s*'?([A-Za-z_][\w@]*)'?\s*,\s*\[([^\]]*)\]\s*\)\s*\./gm)) {
    if (new RegExp(`(?:^|[\\s,])'?${fn}'?\\s*/\\s*${arity}\\b`).test(m[2]!)) return m[1]!;
  }
  return undefined;
}

const CPP_NS_MACROS = new WeakMap<ResolutionContext, { openers: Map<string, string[]>; openerFns: Set<string>; closers: Map<string, number>; aliases: Map<string, string> }>();
const CPP_NS_FRAMES = new WeakMap<ResolutionContext, Map<string, Array<{ start: number; end: number; path: string[] }>>>();
/** A closing macro's body: `}` / `} }`, maybe beside a pragma macro (`PYBIND11_WARNING_POP }`). */
const CPP_CLOSER_BODY = /^(?:[A-Za-z_]\w*\s+)*\}(?:\s*\})*\s*;?$/;
const CPP_NS_ALIASES = new WeakMap<ResolutionContext, Map<string, string>>();

/** The project's namespace aliases: `namespace py = pybind11;`. */
function cppNamespaceAliases(context: ResolutionContext): Map<string, string> {
  const hit = CPP_NS_ALIASES.get(context);
  if (hit) return hit;
  const aliases = new Map<string, string>();
  for (const file of context.getAllFiles()) {
    if (!/\.(?:h|hh|hpp|hxx|inl|c|cc|cpp|cxx)$/i.test(file)) continue;
    const source = context.readFile(file);
    if (!source || !source.includes('namespace')) continue;
    for (const m of source.matchAll(/^[ \t]*namespace[ \t]+([A-Za-z_]\w*)[ \t]*=[ \t]*(?:::)?([A-Za-z_][\w:]*)[ \t]*;/gm)) {
      if (!aliases.has(m[1]!)) aliases.set(m[1]!, m[2]!);
    }
  }
  CPP_NS_ALIASES.set(context, aliases);
  return aliases;
}

/**
 * The project's namespace-opening macros — `#define FMT_BEGIN_NAMESPACE
 * namespace fmt { inline namespace v12 {`, `#define RAPIDJSON_NAMESPACE_BEGIN
 * namespace RAPIDJSON_NAMESPACE {` (through `#define RAPIDJSON_NAMESPACE
 * rapidjson`) — as the namespace path each opens (inline namespaces are
 * transparent), and the closing macros as how many scopes each closes.
 */
function cppNamespaceMacros(context: ResolutionContext): { openers: Map<string, string[]>; openerFns: Set<string>; closers: Map<string, number>; aliases: Map<string, string> } {
  const hit = CPP_NS_MACROS.get(context);
  if (hit) return hit;
  const openers = new Map<string, string[]>();
  // `#define PYBIND11_NAMESPACE_BEGIN(name) namespace name {`, used as `PYBIND11_NAMESPACE_BEGIN(detail)`.
  const openerFns = new Set<string>();
  const closers = new Map<string, number>();
  const aliases = new Map<string, string>();
  const bodies: Array<[string, string]> = [];
  for (const file of context.getAllFiles()) {
    if (!/\.(?:h|hh|hpp|hxx|h\+\+|inl|ipp|tcc)$/i.test(file)) continue;
    const raw = context.readFile(file);
    if (!raw || !raw.includes('#') || !raw.includes('define')) continue;
    const source = stripCommentsForRegex(raw.replace(/\\\r?\n/g, ' '), 'cpp');
    for (const m of source.matchAll(/^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)(\(\s*([A-Za-z_]\w*)?\s*\))?[ \t]+([^\n]*)$/gm)) {
      const body = m[4]!.trim();
      if (m[2] !== undefined) {
        // (a trailing pragma macro — `PYBIND11_WARNING_PUSH` — rides along)
        if (m[3] && new RegExp(`^namespace\\s+${m[3]}\\s*\\{[\\w\\s]*$`).test(body)) openerFns.add(m[1]!);
        else if (CPP_CLOSER_BODY.test(body)) closers.set(m[1]!, (body.match(/\}/g) ?? []).length);
        continue;
      }
      if (/^[A-Za-z_]\w*$/.test(body)) aliases.set(m[1]!, body);
      else if (CPP_CLOSER_BODY.test(body)) closers.set(m[1]!, (body.match(/\}/g) ?? []).length);
      // An inline namespace (transparent, and often named by a macro call) is skipped.
      else if (/^(?:inline\s+namespace\s+[^{}]*\{\s*|namespace\s+[A-Za-z_]\w*\s*\{\s*)+[\w\s]*$/.test(body)) bodies.push([m[1]!, body]);
    }
  }
  for (const [name, body] of bodies) {
    if (openers.has(name)) continue;
    const path = [...body.replace(/inline\s+namespace\s+[^{}]*\{/g, '').matchAll(/namespace\s+([A-Za-z_]\w*)/g)]
      .map((m) => aliases.get(m[1]!) ?? m[1]!);
    if (path.length > 0) openers.set(name, path);
  }
  const macros = { openers, openerFns, closers, aliases };
  CPP_NS_MACROS.set(context, macros);
  return macros;
}

/** The line ranges of a C / C++ file each namespace macro opens, with the namespace path it opens. */
function cppMacroNamespaceFrames(file: string, context: ResolutionContext): Array<{ start: number; end: number; path: string[] }> {
  let memo = CPP_NS_FRAMES.get(context);
  if (!memo) {
    memo = new Map();
    CPP_NS_FRAMES.set(context, memo);
  }
  const hit = memo.get(file);
  if (hit) return hit;
  const frames: Array<{ start: number; end: number; path: string[] }> = [];
  const { openers, openerFns, closers, aliases } = cppNamespaceMacros(context);
  if (openers.size > 0 || openerFns.size > 0) {
    const lines = context.getFileLines?.(file) ?? context.readFile(file)?.split(/\r?\n/) ?? [];
    const open: Array<{ start: number; path: string[] }> = [];
    lines.forEach((text, i) => {
      const m = /^[ \t]*([A-Z_][A-Z0-9_]*)(?:\(\s*([A-Za-z_]\w*)?\s*\))?[ \t]*;?[ \t]*(?:\/\/.*|\/\*.*\*\/[ \t]*)?\r?$/.exec(text);
      const token = m?.[1];
      if (!token) return;
      const arg = m[2];
      const path = arg !== undefined && openerFns.has(token) ? [aliases.get(arg) ?? arg] : arg === undefined ? openers.get(token) : undefined;
      if (path) open.push({ start: i + 1, path });
      else if (closers.has(token) && open.length > 0) frames.push({ ...open.pop()!, end: i + 1 });
    });
    for (const frame of open) frames.push({ ...frame, end: lines.length });
  }
  memo.set(file, frames);
  return frames;
}

/**
 * Resolve `fmt::format` / `fmt::detail::to_unsigned` to the declaration a
 * namespace macro puts there: a node named `format` (qualified `format` or
 * `detail::to_unsigned` in the index, which cannot see the macro) inside a
 * `FMT_BEGIN_NAMESPACE` … `FMT_END_NAMESPACE` range. On fmt, 1,728
 * `fmt::format(…)` calls resolved to nothing.
 */
function matchCppMacroNamespaced(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  let target = ref.referenceName.replace(/^::/, '');
  const head = target.slice(0, target.indexOf('::'));
  const alias = cppNamespaceAliases(context).get(head);
  // `py::str` under `namespace py = pybind11;` is `pybind11::str`.
  if (alias) target = alias + target.slice(head.length);
  const name = target.slice(target.lastIndexOf('::') + 2);
  if (!/^[A-Za-z_~]\w*$/.test(name)) return null;
  const matches: Node[] = [];
  for (const n of context.getNodesByName(name)) {
    if (n.language !== 'cpp' && n.language !== 'c') continue;
    if (!['function', 'method', 'class', 'struct', 'enum', 'type_alias', 'union', 'variable', 'constant'].includes(n.kind)) continue;
    const prefix = cppMacroNamespaceFrames(n.filePath, context)
      .filter((f) => f.start <= n.startLine && f.end >= n.startLine)
      .sort((a, b) => a.start - b.start)
      .flatMap((f) => f.path);
    const effective = prefix.length > 0 ? `${prefix.join('::')}::${n.qualifiedName}` : alias ? n.qualifiedName : '';
    if (effective === target) matches.push(n);
  }
  // A declaration outside the tests over one in them; among an overload set,
  // the one the call's arguments fit: `fmt::format("{}", v)` is format.h's
  // `format(format_string, T&&...)`, not color.h's `format(const text_style&, …)`.
  const args = matches.length > 1 && ref.referenceKind === 'calls' ? cppCallArguments(ref, name, context) : null;
  let best: Node | null = null;
  let bestScore = -Infinity;
  for (const n of matches) {
    const score = (isTestPath(n.filePath) ? -10 : 0) + (args ? cppOverloadFit(n, name, args, context) : 0);
    if (score > bestScore) { best = n; bestScore = score; }
  }
  return best ? { original: ref, targetNodeId: best.id, confidence: 0.8, resolvedBy: 'qualified-name' } : null;
}

/** Split `a, f(b, c), d<e, f>` at its top-level commas. */
function splitCppTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      cur += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '}' || (ch === '>' && text[i - 1] !== '-')) depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The balanced `( … )` after `name` from `line`/`column` of `file` (up to a dozen lines), or null. */
function cppParenListAfter(file: string, line: number, column: number, name: string, context: ResolutionContext): string | null {
  const lines = context.getFileLines?.(file) ?? context.readFile(file)?.split(/\r?\n/) ?? [];
  const text = lines.slice(line - 1, line + 11).join('\n');
  const at = new RegExp(`\\b${name.replace(/[~]/g, '\\$&')}\\s*(?:<[^<>()]*>)?\\s*\\(`).exec(text.slice(column));
  if (!at) return null;
  const open = column + at.index + at[0].length - 1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

function cppCallArguments(ref: UnresolvedRef, name: string, context: ResolutionContext): string[] | null {
  const list = cppParenListAfter(ref.filePath, ref.line, Math.max(0, ref.column), name, context);
  return list === null ? null : splitCppTopLevel(list);
}

/** How well a call's arguments fit an overload's parameters: arity, and a string literal's first slot. */
function cppOverloadFit(n: Node, name: string, args: string[], context: ResolutionContext): number {
  if (n.kind !== 'function' && n.kind !== 'method') return -1;
  const list = cppParenListAfter(n.filePath, n.startLine, 0, name, context);
  if (list === null) return 0;
  const params = splitCppTopLevel(list).filter((p) => p !== 'void');
  // A pack is `T&&... args`, not the `...` inside `format_string<T...>`.
  const isPack = (p: string): boolean => {
    let flat = p;
    for (let prev = ''; prev !== flat;) { prev = flat; flat = flat.replace(/<[^<>]*>/g, ''); }
    return flat.includes('...');
  };
  const variadic = params.some(isPack);
  const required = params.filter((p) => !isPack(p) && !/=/.test(p)).length;
  let score = 0;
  if (args.length < required || (!variadic && args.length > params.length)) score -= 3;
  // Each string literal against its parameter: a string type by name over a
  // template parameter that might be one (`const S&`), and a narrow literal
  // never a wide parameter (`fmt::join(v, ", ")` is not xchar.h's `wstring_view`).
  for (let i = 0; i < args.length && i < params.length; i++) {
    const arg = args[i]!;
    const param = params[i]!;
    if (isPack(param)) break;
    if (!/^(?:u8|u|U|L)?"|^FMT_STRING\s*\(/.test(arg)) continue;
    const wideArg = /^L"/.test(arg);
    const wideParam = /\bw(?:string|char_t|format|string_view)|wchar_t/.test(param);
    if (wideArg !== wideParam && /string|char|Char|format/.test(param)) score -= 2;
    else score += /string|char|Char|\bstr\b/.test(param) ? 3 : /^(?:const\s+)?[A-Z]\w{0,2}\s*[&*]{0,2}\s*\w*$/.test(param) ? 1 : -2;
  }
  return score;
}
