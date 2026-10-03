/**
 * Salam Framework Resolver
 *
 * A Salam package can be reached under two spellings. Every standard-library
 * package and symbol carries an English name and a Persian one
 * (`@en "sqlite"` / `@fa "اس کیو لایت"`), and Persian source calls
 * `اس کیو لایت.باز(...)` where English source calls `sqlite.Open(...)`. The
 * extractor stores the aliases as `@fa "..."` decorators, and the generic name
 * matcher only knows a node by its canonical name, so an aliased reference
 * would otherwise resolve to nothing.
 *
 * This resolver builds a per-project index of package spellings and of each
 * package's top-level members, then resolves:
 *
 *   - `alias.Member` / `pkg::Member` — a member of a package named by either
 *     spelling, whether or not the file imports it explicitly (`str` is
 *     available everywhere).
 *   - a bare `imports` reference to a package alias — the package's module node.
 *
 *   - `alias.Member` where `alias` is a file import (`import sm "semantic/semantic.salam"`).
 *     A package spans every file in its directory that declares it, so the
 *     member is looked up in the target file's whole package, nearest file first.
 *   - `f().method` / `pkg::f().method` — a method called on a variable that was
 *     initialised by a call (`g := graph.New()`; Salam has no constructors, so
 *     this is how most values are made). The variable's type is what `f`
 *     declares it returns, and the edge exists only if that type has the method.
 *   - `Type.method` — a method on a receiver whose type the extractor knew
 *     (a parameter, an annotation, a struct literal or a cast).
 *   - `Enum.Member` — a member read off an enum (`Color.Red`).
 */

import type { Node } from '../../types';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { resolveImportPath } from '../import-resolver';

const ARABIC_SCRIPT = /[؀-ۿ]/;
const ALIAS_DECORATOR = /^@[A-Za-z0-9_]+ "(.*)"$/;

const MEMBER_KINDS = [
  'function', 'constant', 'variable', 'struct', 'enum', 'interface', 'type_alias', 'component',
] as const;

interface SalamIndex {
  /** Any spelling of a package name → canonical package names. */
  spellings: Map<string, string[]>;
  /** Canonical package name → its module nodes (one per file). */
  modules: Map<string, Node[]>;
  /** Canonical package name → member spelling → top-level nodes. */
  members: Map<string, Map<string, Node[]>>;
}

const indexes = new WeakMap<ResolutionContext, SalamIndex>();

/**
 * The compiler treats a space, a ZWNJ and their absence as the same in a
 * Persian name, and Arabic yeh/kaf as Persian yeh/kaf, so index and look up by
 * this folded key.
 */
export function foldName(s: string): string {
  return s.replace(/[\s\u200C]/g, '').replace(/[\u064A\u06CC]/g, '\u06CC').replace(/[\u0643\u06A9]/g, '\u06A9');
}

function aliasesOf(node: Node): string[] {
  const out: string[] = [];
  for (const d of node.decorators ?? []) {
    const m = ALIAS_DECORATOR.exec(d);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

function nodesOfKind(context: ResolutionContext, kind: Node['kind']): Iterable<Node> {
  return context.iterateNodesByKind ? context.iterateNodesByKind(kind) : context.getNodesByKind(kind);
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function buildIndex(context: ResolutionContext): SalamIndex {
  const index: SalamIndex = { spellings: new Map(), modules: new Map(), members: new Map() };

  for (const mod of nodesOfKind(context, 'module')) {
    if (mod.language !== 'salam') continue;
    pushTo(index.modules, mod.name, mod);
    for (const spelling of [mod.name, ...aliasesOf(mod)].map(foldName)) {
      const canon = index.spellings.get(spelling);
      if (!canon) index.spellings.set(spelling, [mod.name]);
      else if (!canon.includes(mod.name)) canon.push(mod.name);
    }
  }

  for (const kind of MEMBER_KINDS) {
    for (const node of nodesOfKind(context, kind)) {
      if (node.language !== 'salam') continue;
      const parts = node.qualifiedName.split('::');
      if (parts.length !== 2) continue;
      const pkg = parts[0]!;
      if (!index.modules.has(pkg)) continue;
      let byName = index.members.get(pkg);
      if (!byName) {
        byName = new Map();
        index.members.set(pkg, byName);
      }
      for (const spelling of [node.name, ...aliasesOf(node)].map(foldName)) pushTo(byName, spelling, node);
    }
  }

  for (const nodes of index.modules.values()) nodes.sort((a, b) => a.filePath.localeCompare(b.filePath));
  for (const byName of index.members.values()) {
    for (const nodes of byName.values()) nodes.sort((a, b) => a.filePath.localeCompare(b.filePath));
  }
  return index;
}

function getIndex(context: ResolutionContext): SalamIndex {
  let index = indexes.get(context);
  if (!index) {
    index = buildIndex(context);
    indexes.set(context, index);
  }
  return index;
}

function dirOf(filePath: string): string {
  const i = filePath.lastIndexOf('/');
  return i >= 0 ? filePath.slice(0, i) : '';
}

/**
 * `alias.Member` through a file import: the package the imported file declares
 * spans its directory, so search that package and prefer the imported file's
 * own directory. A file without a `package` line is its own package.
 */
function findViaFileAlias(
  ref: UnresolvedRef,
  alias: string,
  member: string,
  index: SalamIndex,
  context: ResolutionContext,
): Node | undefined {
  const imp = context.getImportMappings(ref.filePath, 'salam').find((i) => i.localName === alias);
  if (!imp) return undefined;
  const target = resolveImportPath(imp.source, ref.filePath, 'salam', context);
  if (!target) return undefined;
  const inFile = context.getNodesInFile(target);
  const mod = inFile.find((n) => n.kind === 'module');
  const candidates = mod
    ? (index.members.get(mod.name)?.get(foldName(member)) ?? [])
    : inFile.filter((n) => n.name === member && n.qualifiedName === n.name && n.isExported);
  if (candidates.length === 0) return undefined;
  const targetDir = dirOf(target);
  const near = candidates.filter((n) => dirOf(n.filePath) === targetDir);
  return pickMember(near.length > 0 ? near : candidates, ref);
}

/** `pkg.Member` / `pkg::Member` where `pkg` is any spelling of a package name. */
function findViaPackage(
  ref: UnresolvedRef,
  pkg: string,
  member: string,
  index: SalamIndex,
): Node | undefined {
  const canons = index.spellings.get(foldName(pkg));
  if (!canons) return undefined;
  for (const canon of canons) {
    const nodes = index.members.get(canon)?.get(foldName(member));
    if (!nodes || nodes.length === 0) continue;
    const target = pickMember(nodes, ref);
    if (target) return target;
  }
  return undefined;
}

/** A member reached through a file alias or a package spelling. */
function findQualified(
  ref: UnresolvedRef,
  pkg: string,
  member: string,
  index: SalamIndex,
  context: ResolutionContext,
): { node: Node; via: 'import' | 'framework' } | undefined {
  const viaFile = findViaFileAlias(ref, pkg, member, index, context);
  if (viaFile) return { node: viaFile, via: 'import' };
  const viaPkg = findViaPackage(ref, pkg, member, index);
  return viaPkg ? { node: viaPkg, via: 'framework' } : undefined;
}

/** The function a bare call names: this file first, then its directory, then a unique name. */
function findBareFunction(name: string, ref: UnresolvedRef, context: ResolutionContext): Node | undefined {
  const fns = context.getNodesByName(name).filter((n) => n.language === 'salam' && n.kind === 'function');
  if (fns.length === 0) return undefined;
  const sameFile = fns.find((n) => n.filePath === ref.filePath);
  if (sameFile) return sameFile;
  const dir = dirOf(ref.filePath);
  const sameDir = fns.filter((n) => dirOf(n.filePath) === dir);
  if (sameDir.length === 1) return sameDir[0];
  return fns.length === 1 ? fns[0] : undefined;
}

/** The member `member` of the enum named `enumName`: this file first, then unique. */
function enumMember(
  enumName: string,
  member: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): Node | undefined {
  const tail = `::${enumName}::${member}`;
  const found = context
    .getNodesByName(member)
    .filter(
      (n) =>
        n.language === 'salam' &&
        n.kind === 'enum_member' &&
        (n.qualifiedName === `${enumName}::${member}` || n.qualifiedName.endsWith(tail)),
    );
  const sameFile = found.filter((n) => n.filePath === ref.filePath);
  if (sameFile.length > 0) return sameFile[0];
  const dir = dirOf(ref.filePath);
  const sameDir = found.filter((n) => dirOf(n.filePath) === dir);
  if (sameDir.length === 1) return sameDir[0];
  return found.length === 1 ? found[0] : undefined;
}

/** Methods named `method` declared on `type` (`Type::method`), nearest first. */
function methodsOnType(
  type: string,
  method: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): Node[] {
  const tail = `::${type}::${method}`;
  const found = context
    .getNodesByName(method)
    .filter(
      (n) =>
        n.language === 'salam' &&
        n.kind === 'method' &&
        !n.isAbstract &&
        (n.qualifiedName === `${type}::${method}` || n.qualifiedName.endsWith(tail)),
    );
  const dir = dirOf(ref.filePath);
  return found.sort((a, b) => {
    const rank = (n: Node) => (n.filePath === ref.filePath ? 0 : dirOf(n.filePath) === dir ? 1 : 2);
    return rank(a) - rank(b) || a.filePath.localeCompare(b.filePath);
  });
}

function splitQualified(name: string): { pkg: string; member: string } | null {
  const colon = name.indexOf('::');
  if (colon > 0) return { pkg: name.slice(0, colon), member: name.slice(colon + 2) };
  const dot = name.indexOf('.');
  if (dot > 0) return { pkg: name.slice(0, dot), member: name.slice(dot + 1) };
  return null;
}

/** Prefer callables for calls, types for instantiations, else the first. */
function pickMember(nodes: Node[], ref: UnresolvedRef): Node | undefined {
  const want: string[] =
    ref.referenceKind === 'calls'
      ? ['function']
      : ref.referenceKind === 'instantiates'
        ? ['struct', 'component']
        : [];
  return nodes.find((n) => want.includes(n.kind)) ?? nodes[0];
}

export const salamResolver: FrameworkResolver = {
  name: 'salam',
  languages: ['salam'],

  detect(context: ResolutionContext): boolean {
    return context.getAllFiles().some((f) => f.endsWith('.salam'));
  },

  // Persian spellings name no node the pre-filter knows; let them through.
  claimsReference(name: string): boolean {
    return ARABIC_SCRIPT.test(name);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language !== 'salam') return null;
    const index = getIndex(context);
    const name = ref.referenceName;

    if (ref.referenceKind === 'imports') {
      const canons = index.spellings.get(foldName(name));
      const mod = canons?.map((c) => index.modules.get(c)?.[0]).find((m) => m !== undefined);
      if (!mod) return null;
      return { original: ref, targetNodeId: mod.id, confidence: 0.85, resolvedBy: 'framework' };
    }

    // `f().method` / `pkg::f().method`
    const chain = /^(.+)\(\)\.([^.()]+)$/.exec(name);
    if (chain) return resolveFactoryChain(ref, chain[1]!, chain[2]!, index, context);

    const q = splitQualified(name);
    if (!q) return null;
    const hit = findQualified(ref, q.pkg, q.member, index, context);
    if (hit) {
      return { original: ref, targetNodeId: hit.node.id, confidence: 0.9, resolvedBy: hit.via };
    }

    // `Enum.Member`
    if (ref.referenceKind === 'references') {
      const member = enumMember(q.pkg, q.member, ref, context);
      if (member) {
        return { original: ref, targetNodeId: member.id, confidence: 0.9, resolvedBy: 'framework' };
      }
    }

    // `Type.method` on a receiver typed at extraction
    if (ref.referenceKind === 'calls' && /^[^.:]+\.[^.:]+$/.test(name)) {
      const methods = methodsOnType(q.pkg, q.member, ref, context);
      const target = methods.length === 1 || methods[0]?.filePath === ref.filePath ? methods[0] : undefined;
      if (target) {
        return { original: ref, targetNodeId: target.id, confidence: 0.85, resolvedBy: 'instance-method' };
      }
    }
    return null;
  },
};

/**
 * `inner().method`: the receiver's type is what `inner` declares it returns.
 * No edge unless `inner` is found, has a recorded return type, and that type
 * declares `method` — a wrong guess stays silent.
 */
function resolveFactoryChain(
  ref: UnresolvedRef,
  inner: string,
  method: string,
  index: SalamIndex,
  context: ResolutionContext,
): ResolvedRef | null {
  const q = splitQualified(inner);
  const callee = q ? findQualified(ref, q.pkg, q.member, index, context)?.node : findBareFunction(inner, ref, context);
  const ret = callee?.returnType;
  if (!callee || !ret) return null;
  const methods = methodsOnType(ret, method, ref, context);
  const calleeDir = dirOf(callee.filePath);
  const target = methods.find((n) => dirOf(n.filePath) === calleeDir) ?? (methods.length === 1 ? methods[0] : undefined);
  if (!target) return null;
  return { original: ref, targetNodeId: target.id, confidence: 0.85, resolvedBy: 'instance-method' };
}
