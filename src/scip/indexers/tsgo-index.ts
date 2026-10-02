/**
 * A SCIP indexer for TS/JS on TypeScript 7's native compiler (tsgo), through
 * its API (`typescript/unstable/sync`, TypeScript ≥ 7.1). The typescript
 * adapter runs it as its own process when that API is installed:
 *
 *   node tsgo-index.js <typescript package dir> <output> <root> [--only <listfile>] [--refs <listfile>] [<tsconfig>...]
 *
 * It writes exactly what the merge reads (see compact.ts) and nothing more: a
 * reference at the callee name of every call and `new` in a project file, and
 * the definition of every callee the project declares — plus, at the sites
 * `--refs` lists (the lines of codegraph's `references` edges: path, line), a reference
 * for every identifier on that line — whatever its text, since an import alias
 * (`Node as SyntaxNode`) names its target differently — which the merge judges
 * those edges by. A symbol is named after
 * its first declaration — its file and the named declarations enclosing it — so
 * an overload maps to its first signature, a declaration reached from two
 * projects is one symbol, and the name survives edits elsewhere in the file.
 *
 * Projects are opened one at a time in a single process. A file is indexed by
 * the deepest project containing it (its own tsconfig resolves its imports), or
 * — when that project never loads it — by the first project that does. Every
 * definition lands in its file's document whichever project referenced it. A
 * project that fails to open is reported on stderr (RUN_WARNING) and its files
 * stay heuristic-only. Repo files no project indexed (outside every tsconfig, or
 * a repo with none) are indexed last, together, in one inferred program.
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { ROLE_DEFINITION, ScipImplementation, ScipOccurrence, encodeDocument, encodeMetadata, escapeIdentifier as esc } from '../reader';
import { MAX_SOURCE_FILE_SIZE_BYTES } from '../../file-limits';
import { RUN_WARNING } from './index';
import { repoFiles } from './repo-files';
import { packageVersion, SOURCE } from './typescript';

/** SCIP `PositionEncoding.UTF16CodeUnitOffsetFromLineStart`: the API's positions index JS strings. */
const POSITION_ENCODING_UTF16 = 2;
/** Files indexed between drops of the client-side AST cache. */
const CACHE_FILES = 1000;
/** Compiler options for files outside every tsconfig — what an editor infers for a loose file. */
const INFERRED_OPTIONS = {
  allowJs: true, jsx: 1 /* Preserve */, module: 99 /* ESNext */, moduleResolution: 100 /* Bundler */, target: 99 /* ESNext */,
  allowImportingTsExtensions: true, resolveJsonModule: true, skipLibCheck: true, noEmit: true,
};
const DECLARATION_FILE = /\.d\.[cm]?ts$/;

// The slice of the (unstable, untyped here) API this indexer uses.
interface TsNode {
  kind: number;
  pos: number;
  end: number;
  text?: string;
  name?: TsNode;
  expression?: TsNode;
  parent?: TsNode;
  // class/interface heritage: clauses → types → the base's name (Identifier, QualifiedName.right, PropertyAccess.name)
  heritageClauses?: Iterable<{ types: Iterable<TsNode> }>;
  typeName?: TsNode;
  right?: TsNode;
  members?: Iterable<TsNode>;
  forEachChild(visit: (n: TsNode) => unknown): unknown;
}
interface TsSourceFile extends TsNode {
  text: string;
  getOrCreateNodeAtIndex(index: number): TsNode | undefined;
}
interface TsSymbol {
  id: number;
  name: string;
  escapedName: string;
  getMembers(): ReadonlyMap<string, TsSymbol>;
  flags: number;
  checkFlags: number;
  declarations?: readonly { path: string; index: number; kind: number }[];
}
interface TsProject {
  configFileName: string;
  program: { getSourceFileNames(): readonly string[]; getSourceFile(file: string): TsSourceFile | undefined };
  checker: { getSymbolAtPosition(file: string, positions: readonly number[]): (TsSymbol | undefined)[]; getAliasedSymbol(s: TsSymbol): TsSymbol };
}
interface TsSnapshot {
  getProjects(): readonly TsProject[];
  operation: { createdPrograms?: readonly { project: TsProject }[] };
  dispose(): void;
}
interface TsApi {
  createSnapshot(params: {
    openProjects?: string[]; closeProjects?: string[];
    createPrograms?: { rootFiles: string[]; compilerOptions: Record<string, unknown> }[];
  }): TsSnapshot;
  clearSourceFileCache(): void;
  close(): void;
}
interface Loaded {
  api: TsApi;
  SyntaxKind: Record<string, number>;
  SymbolFlags: Record<'Alias' | 'Class' | 'Interface' | 'Function' | 'Method' | 'Variable' | 'Property' | 'Enum' | 'TypeAlias' | 'EnumMember', number>;
  CheckFlags: Record<'Synthetic', number>;
  skipTrivia(text: string, pos: number): number;
  version: string;
}

async function load(tsDir: string, root: string): Promise<Loaded> {
  // An ES module package; the CommonJS build turns this into require(), which loads ESM on Node ≥ 20.19 / 22.12.
  const mod = (sub: string): Promise<Record<string, unknown>> => import(path.join(tsDir, sub));
  const [sync, ast, scanner] = await Promise.all([mod('dist/api/sync/api.js'), mod('dist/ast/index.js'), mod('dist/ast/scanner.js')]);
  const version = packageVersion(tsDir) ?? 'unknown';
  // The API is unstable: fail with a clear message rather than index wrongly.
  const missing = [[sync, 'API'], [sync, 'SymbolFlags'], [sync, 'CheckFlags'], [ast, 'SyntaxKind'], [scanner, 'skipTrivia']]
    .filter(([m, k]) => !(m as Record<string, unknown>)[k as string]).map(([, k]) => k);
  if (missing.length) throw new Error(`TypeScript ${version} at ${tsDir} lacks ${missing.join(', ')} — its API changed; set scip.typescript.cmd to use scip-typescript`);
  const API = sync.API as new (o: { cwd: string }) => TsApi;
  return {
    api: new API({ cwd: root }),
    SyntaxKind: ast.SyntaxKind as Record<string, number>,
    SymbolFlags: sync.SymbolFlags as Loaded['SymbolFlags'],
    CheckFlags: sync.CheckFlags as Loaded['CheckFlags'],
    skipTrivia: scanner.skipTrivia as Loaded['skipTrivia'],
    version,
  };
}

/** 0-based starts of each line, split exactly like the merge splits text (`\r?\n`). */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * `only` (repo-relative paths) indexes just those files — the partial run of an
 * incremental reindex, whose documents replace theirs in the installed index.
 * Only projects owning one of them are opened.
 */
export async function indexProjects(
  tsDir: string, output: string, root: string, configs: string[], only?: ReadonlySet<string>,
  /** repo-relative path → 1-based lines: where to emit references (see the header) */
  refs?: ReadonlyMap<string, ReadonlySet<number>>
): Promise<{ warnings: string[]; documents: number }> {
  const ts = await load(tsDir, root);
  const K = ts.SyntaxKind;
  const F = ts.SymbolFlags;
  const C = ts.CheckFlags;
  const CALLEE_HOLDERS = new Set([K.CallExpression, K.NewExpression]);
  const TYPE_DECLS = new Set([K.ClassDeclaration, K.ClassExpression, K.InterfaceDeclaration]);
  /** Descriptor suffix of each named declaration that can enclose another (see `named`). */
  const CONTAINER_SUFFIX = new Map<number, string>([
    ...[K.ClassDeclaration, K.ClassExpression, K.InterfaceDeclaration, K.EnumDeclaration].map(k => [k!, '#'] as const),
    [K.ModuleDeclaration!, '/'],
    ...[K.FunctionDeclaration, K.FunctionExpression, K.MethodDeclaration, K.MethodSignature, K.GetAccessor, K.SetAccessor].map(k => [k!, '().'] as const),
    ...[K.VariableDeclaration, K.PropertyDeclaration, K.PropertySignature, K.PropertyAssignment].map(k => [k!, '.'] as const),
  ]);
  /** Bodies whose declarations are local: no other file can call into them. */
  const FUNCTION_LIKE = new Set([K.FunctionDeclaration, K.FunctionExpression, K.ArrowFunction, K.MethodDeclaration, K.Constructor, K.GetAccessor, K.SetAccessor]);
  const NAMES = new Set([K.Identifier, K.PrivateIdentifier]);
  const UNWRAP = new Set([K.NonNullExpression, K.ParenthesizedExpression]);

  const rootPrefix = root.endsWith('/') ? root : `${root}/`;
  const inRepo = (p: string) => p.startsWith(rootPrefix) && !p.includes('/node_modules/');
  const rel = (p: string) => p.slice(rootPrefix.length);

  /** repo-relative path → the occurrences of its document (files indexed, plus files holding definitions) */
  const docs = new Map<string, ScipOccurrence[]>();
  /** repo-relative path → its types' and members' implementation relationships */
  const implementations = new Map<string, ScipImplementation[]>();
  const docOf = (file: string) => {
    let occ = docs.get(file);
    if (!occ) docs.set(file, (occ = []));
    return occ;
  };
  const indexed = new Set<string>();
  const defined = new Set<string>();
  const names = new Map<string, string>();
  /** symbol → the declaration (path + node index) that named it first */
  const claimed = new Map<string, string>();
  const lines = new Map<string, number[]>();
  const starts = (file: string, text: string) => {
    let s = lines.get(file);
    if (!s) lines.set(file, (s = lineStarts(text)));
    return s;
  };
  const span = (file: string, text: string, start: number, end: number) => {
    const s = starts(file, text);
    const line = lineOf(s, start);
    const endLine = lineOf(s, end);
    return { startLine: line, startCol: start - s[line]!, endLine, endCol: end - s[endLine]! };
  };
  const warnings: string[] = [];

  // A file belongs to the deepest project containing it — its own tsconfig's
  // paths/options resolve its imports (a root config without `include` claims
  // everything, but a nested `tests/tsconfig.json` is the one written for tests/).
  const ownerDirs = configs.map(c => path.dirname(c)).sort((a, b) => b.length - a.length);
  const owner = (file: string) => ownerDirs.find(d => file.startsWith(`${d}/`));

  let snapshot: TsSnapshot | null = null;
  let previous: string | null = null;
  /** A tsconfig's project, or (a list of files) an inferred program rooted at them. */
  const open = (target: string | string[]): TsProject | null => {
    const close = previous && previous !== target ? { closeProjects: [previous] } : {};
    try {
      snapshot?.dispose();
      let project: TsProject | undefined;
      if (typeof target === 'string') {
        snapshot = ts.api.createSnapshot({ openProjects: [target], ...close });
        project = snapshot.getProjects().find(p => p.configFileName === target);
      } else {
        snapshot = ts.api.createSnapshot({ ...close, createPrograms: [{ rootFiles: target, compilerOptions: INFERRED_OPTIONS }] });
        project = snapshot.operation.createdPrograms?.[0]?.project;
      }
      if (!project) throw new Error('not loaded');
      return project;
    } catch (err) {
      const what = typeof target === 'string' ? rel(target) : `${target.length} file(s) outside every tsconfig`;
      warnings.push(`${what}: can't open the project (${err instanceof Error ? err.message : String(err)})`);
      return null;
    } finally {
      previous = typeof target === 'string' ? target : null;
    }
  };

  /** Indexes the files of `config`'s program (see open) that `want` accepts; returns the other repo files it loaded. */
  const indexIn = (config: string | string[], want: (file: string) => boolean): string[] => {
    const project = open(config);
    if (!project) return [];
    const others: string[] = [];
    const { program, checker } = project;
    const files = new Map<string, TsSourceFile | undefined>();
    const sourceFile = (f: string) => {
      if (!files.has(f)) files.set(f, program.getSourceFile(f));
      return files.get(f);
    };
    const aliases = new Map<number, TsSymbol>();

    type Decl = NonNullable<TsSymbol['declarations']>[number];
    const nodeOf = (d: Decl) => {
      const sf = sourceFile(d.path);
      return sf && { sf, node: sf.getOrCreateNodeAtIndex(d.index) };
    };

    /**
     * The declaration a symbol is named after: its first — except that a type
     * (`#`) is named after its class/interface declaration, not a value merged
     * into it (vscode's `const IFoo = createDecorator<IFoo>()` beside `interface IFoo`).
     */
    const primary = (t: TsSymbol, suffix: string): Decl | undefined => {
      const decls = t.declarations ?? [];
      return (suffix === '#' && decls.find(d => TYPE_DECLS.has(d.kind))) || decls[0];
    };

    /**
     * The declarations a callee stands for: its first one (an overload's first
     * signature), or — for a member of a union/intersection type, a synthetic
     * symbol whose declarations are every constituent's — the first per
     * constituent, since the call may reach any of them.
     */
    const targetsOf = (t: TsSymbol, suffix: string): Decl[] => {
      const decls = t.declarations ?? [];
      if (!(t.checkFlags & C.Synthetic)) return decls.length ? [primary(t, suffix)!] : [];
      const seen = new Set<string>();
      return decls.filter(d => {
        const parent = nodeOf(d)?.node?.parent;
        const key = `${d.path}\0${parent?.pos ?? d.index}`;
        return !seen.has(key) && seen.add(key);
      });
    };

    const resolve = (s: TsSymbol) => {
      if (!(s.flags & F.Alias)) return s;
      let a = aliases.get(s.id);
      if (!a) aliases.set(s.id, (a = checker.getAliasedSymbol(s)));
      return a;
    };

    /**
     * The SCIP symbol for `t` declared at `decl`; for a project declaration also
     * records its definition. External ones carry their package path and node
     * index, so two same-named declarations never read as one symbol.
     */
    const named = (t: TsSymbol, decl: Decl, suffix: string): string => {
      if (!inRepo(decl.path)) {
        const nm = decl.path.lastIndexOf('/node_modules/');
        const where = nm >= 0 ? decl.path.slice(nm + '/node_modules/'.length) : path.basename(decl.path);
        return `tsgo npm . . ${esc(where)}/${decl.index}/${esc(t.name)}${suffix}`;
      }
      // One name per declaration, however it is reached: the declaration's own kind decides
      // the suffix (a method reached through a union's synthetic property is still `().`).
      if (suffix !== '#') suffix = CONTAINER_SUFFIX.get(decl.kind) ?? suffix;
      const cacheKey = `${decl.path}\0${decl.index}\0${suffix}`;
      const cached = names.get(cacheKey);
      if (cached) return cached;
      const file = rel(decl.path);
      const at = nodeOf(decl);
      // Named by where it is declared — the chain of named declarations around it,
      // as scip-typescript does — so a symbol keeps its name while edits elsewhere
      // shift node indexes: an index built partly from an earlier run still links up.
      let chain = '';
      if (at?.node) {
        for (let n = at.node.parent; n; n = n.parent) {
          const s = CONTAINER_SUFFIX.get(n.kind);
          const nm = n.name?.text;
          if (s && nm) chain = `${esc(nm)}${s}${chain}`;
        }
      } else {
        chain = `${decl.index}/`; // no node to name it by: unique within this run at least
      }
      let symbol = `tsgo . . . ${esc(file)}/${chain}${esc(t.name)}${suffix}`;
      // Two declarations the chain can't tell apart (a `function input()` in each of two
      // anonymous callbacks): the second is named by its node index instead of colliding.
      const declKey = `${decl.path}\0${decl.index}`;
      const owner = claimed.get(symbol);
      if (owner === undefined) claimed.set(symbol, declKey);
      else if (owner !== declKey) symbol = `tsgo . . . ${esc(file)}/${chain}${decl.index}/${esc(t.name)}${suffix}`;
      names.set(cacheKey, symbol);
      if (defined.has(symbol)) return symbol;
      defined.add(symbol);
      // Defined at the declaration's name (its start when it has none, e.g. `export default class {`).
      // Always defined somewhere: a project symbol without a definition would read as external.
      let range = { startLine: 0, startCol: 0, endLine: 0, endCol: 0 };
      if (at?.node) {
        const { sf, node } = at;
        const start = ts.skipTrivia(sf.text, (node.name ?? node).pos);
        range = span(decl.path, sf.text, start, node.name ? node.name.end : start);
      }
      docOf(file).push({ range, symbol, roles: ROLE_DEFINITION });
      return symbol;
    };
    const first = (t: TsSymbol, suffix: string) => { const d = primary(t, suffix); return d ? named(t, d, suffix) : null; };

    /** The SCIP symbols of a callee. */
    const symbolsOf = (s: TsSymbol, isNew: boolean): string[] => {
      const t = resolve(s);
      const suffix = t.flags & F.Class ? '#'
        : isNew ? null // `new` of a non-class value: nothing codegraph models
        : t.flags & (F.Function | F.Method) ? '().'
        : t.flags & (F.Variable | F.Property) ? '.' // a function-valued binding; the merge keeps it only if it maps to a callable
        : null;
      if (!suffix) return [];
      return targetsOf(t, suffix).map(decl => named(t, decl, suffix));
    };

    /**
     * The SCIP symbols of a referenced name: its type (`#`: class, interface, enum,
     * alias) and/or its value — both for a name that is both (`interface IFoo` merged
     * with `const IFoo`), since codegraph may have linked either.
     */
    const referencedAs = (s: TsSymbol): string[] => {
      const t = resolve(s);
      const out: string[] = [];
      if (t.flags & (F.Class | F.Interface | F.Enum | F.TypeAlias)) {
        const d = primary(t, '#');
        if (d) out.push(named(t, d, '#'));
        // A global interface the project augments (`declare global { interface Window … }`, in
        // any number of files): the lib declaration names it, but codegraph's nodes are the project's.
        if (d && !inRepo(d.path)) for (const own of t.declarations ?? []) if (inRepo(own.path) && TYPE_DECLS.has(own.kind)) out.push(named(t, own, '#'));
      }
      const v = t.flags & F.Class ? null : t.flags & (F.Function | F.Method) ? '().' : t.flags & (F.Variable | F.Property | F.EnumMember) ? '.' : null;
      if (v) {
        const decls = t.checkFlags & C.Synthetic ? targetsOf(t, v)
          : (t.declarations ?? []).filter(d => d.kind !== K.InterfaceDeclaration && d.kind !== K.TypeAliasDeclaration).slice(0, 1);
        for (const d of decls) out.push(named(t, d, v));
      }
      return out;
    };

    /** Where a heritage entry names its base (Identifier, QualifiedName.right, PropertyAccess.name). */
    const heritageName = (text: string, t: TsNode): number | null => {
      const n = t.typeName ?? t.expression;
      const leaf = n && (n.kind === K.Identifier ? n : n.right ?? n.name);
      return leaf && leaf.kind === K.Identifier ? ts.skipTrivia(text, leaf.pos) : null;
    };

    /** A member's suffix, for relationships: methods and properties (a property may hold a function). */
    const memberSuffix = (t: TsSymbol) => (t.flags & F.Method ? '().' : t.flags & F.Property ? '.' : null);
    const members = new Map<number, ReadonlyMap<string, TsSymbol>>();
    const membersOf = (t: TsSymbol) => {
      let m = members.get(t.id);
      if (!m) members.set(t.id, (m = t.getMembers()));
      return m;
    };
    /** A class/interface's own bases, from its declarations' heritage clauses. */
    const basesOfCache = new Map<number, TsSymbol[]>();
    const basesOf = (t: TsSymbol): TsSymbol[] => {
      let out = basesOfCache.get(t.id);
      if (out) return out;
      basesOfCache.set(t.id, (out = []));
      for (const d of t.declarations ?? []) {
        const at = nodeOf(d);
        const positions: number[] = [];
        for (const clause of at?.node?.heritageClauses ?? []) {
          for (const h of clause.types) { const p = heritageName(at!.sf.text, h); if (p !== null) positions.push(p); }
        }
        if (positions.length === 0) continue;
        for (const b of checker.getSymbolAtPosition(d.path, positions)) if (b) out.push(resolve(b));
      }
      return out;
    };
    /** The member `name` a type declares or inherits (nearest base first). */
    const memberOf = (t: TsSymbol, name: string, seen = new Set<number>()): TsSymbol | undefined => {
      if (seen.has(t.id)) return undefined;
      seen.add(t.id);
      const own = membersOf(t).get(name);
      if (own) return own;
      for (const b of basesOf(t)) { const m = memberOf(b, name, seen); if (m) return m; }
      return undefined;
    };

    for (const f of program.getSourceFileNames()) {
      if (!inRepo(f) || !SOURCE.test(f) || indexed.has(rel(f))) continue;
      if (!want(f)) {
        others.push(f);
        continue;
      }
      const sf = sourceFile(f);
      if (!sf) continue;
      indexed.add(rel(f));
      const sites: { start: number; end: number; isNew: boolean }[] = [];
      /** identifiers at codegraph's reference sites in this file (refs) */
      const fileRefs = refs?.get(rel(f));
      const refSites: { start: number; end: number }[] = [];
      /** classes/interfaces with bases: positions of their name, each base's name, each member's name */
      const types: { at: number; bases: number[]; members: number[] }[] = [];
      const baseName = (t: TsNode) => heritageName(sf.text, t);
      /** the file's named declarations outside function bodies (see below): positions of their names */
      const declared: number[] = [];
      let local = 0; // function bodies we are inside
      const visit = (n: TsNode): undefined => {
        if (!local && CONTAINER_SUFFIX.has(n.kind) && n.kind !== K.ModuleDeclaration && n.name && NAMES.has(n.name.kind)) {
          declared.push(ts.skipTrivia(sf.text, n.name.pos));
        }
        if (TYPE_DECLS.has(n.kind) && n.name && n.heritageClauses) {
          const bases: number[] = [];
          for (const clause of n.heritageClauses) for (const t of clause.types) { const at = baseName(t); if (at !== null) bases.push(at); }
          const mem: number[] = [];
          for (const m of n.members ?? []) if (m.name && NAMES.has(m.name.kind)) mem.push(ts.skipTrivia(sf.text, m.name.pos));
          if (bases.length) types.push({ at: ts.skipTrivia(sf.text, n.name.pos), bases, members: mem });
        }
        if (CALLEE_HOLDERS.has(n.kind) && n.expression) {
          let e: TsNode | undefined = n.expression;
          while (e && UNWRAP.has(e.kind)) e = e.expression;
          if (e && e.kind === K.PropertyAccessExpression) e = e.name;
          if (e && NAMES.has(e.kind)) sites.push({ start: ts.skipTrivia(sf.text, e.pos), end: e.end, isNew: n.kind === K.NewExpression });
        }
        // Not a declaration's own name: that is its definition, and `f(x) {` would read as a call to itself.
        if (fileRefs && n.kind === K.Identifier && n.parent?.name !== n) {
          const start = ts.skipTrivia(sf.text, n.pos);
          if (fileRefs.has(lineOf(starts(f, sf.text), start) + 1)) refSites.push({ start, end: n.end });
        }
        const body = FUNCTION_LIKE.has(n.kind);
        if (body) local++;
        n.forEachChild(visit);
        if (body) local--;
        return undefined;
      };
      sf.forEachChild(visit);
      const occ = docOf(rel(f));
      // One round trip per file: call sites first, then the types' names, bases and members.
      const positions = sites.map(s => s.start);
      for (const t of types) positions.push(t.at, ...t.bases, ...t.members);
      positions.push(...refSites.map(r => r.start));
      positions.push(...declared);
      const symbols = positions.length ? checker.getSymbolAtPosition(f, positions) : [];
      sites.forEach((site, i) => {
        const s = symbols[i];
        if (!s) return;
        const range = span(f, sf.text, site.start, site.end);
        for (const symbol of new Set(symbolsOf(s, site.isNew))) occ.push({ range, symbol, roles: 0 });
      });
      // Type → base and member → the base's member of the same name: what `implements`/`extends`
      // edges and calls through an interface are judged by.
      let i = sites.length;
      const rels: ScipImplementation[] = [];
      for (const t of types) {
        const self = symbols[i++];
        const bases = t.bases.map(() => symbols[i++]).filter((b): b is TsSymbol => !!b).map(resolve)
          .filter(b => b.flags & (F.Class | F.Interface));
        const mems = t.members.map(() => symbols[i++]);
        const selfName = self && first(self, '#');
        if (!selfName) continue;
        for (const b of bases) {
          const target = first(b, '#');
          if (target) rels.push({ symbol: selfName, target });
          for (const m of mems) {
            const suffix = m && memberSuffix(m);
            const bm = suffix ? memberOf(b, m!.escapedName) : undefined;
            const bSuffix = bm && memberSuffix(bm);
            const from = bSuffix ? first(m!, suffix!) : null;
            const to = from && first(bm!, bSuffix!);
            if (from && to) rels.push({ symbol: from, target: to });
          }
        }
      }
      if (rels.length) implementations.set(rel(f), rels);
      const callees = new Set(sites.map(c => c.start)); // already referenced, as the callee
      for (const r of refSites) {
        const s = symbols[i++];
        if (!s || callees.has(r.start)) continue;
        const range = span(f, sf.text, r.start, r.end);
        for (const symbol of new Set(referencedAs(s))) occ.push({ range, symbol, roles: 0 });
      }
      // Define everything another file could call, not just what was referenced: a
      // partial run replaces this document while unchanged files still call into it,
      // and a changed file may start calling what nothing called before. (A local is
      // only reachable from its own file, which is re-indexed whenever it changes.)
      for (const d of symbols.slice(i)) {
        const suffix = d && (d.flags & (F.Class | F.Interface) ? '#' : d.flags & (F.Function | F.Method) ? '().' : d.flags & (F.Variable | F.Property) ? '.' : null);
        if (suffix) first(d!, suffix);
      }
      // Fetched ASTs stay cached client-side; on a large project that's gigabytes.
      // Drop them (and our line tables) now and then — a file needed again is refetched.
      if (indexed.size % CACHE_FILES === 0) {
        ts.api.clearSourceFileCache();
        files.clear();
        lines.clear();
      }
    }
    ts.api.clearSourceFileCache(); // this project's ASTs; the next project fetches its own
    lines.clear();
    return others;
  };

  // Each project indexes its own files; a file its owner never loaded (excluded
  // there, or the owner failed to open) goes to the first project that did load it.
  const wanted = (f: string) => !only || only.has(rel(f));
  const owners = only ? new Set([...only].map(f => owner(path.join(root, f)))) : null;
  const loadedBy = new Map<string, string>();
  for (const config of configs) {
    const dir = path.dirname(config);
    if (owners && !owners.has(dir)) continue; // owns none of the listed files
    for (const f of indexIn(config, f => wanted(f) && owner(f) === dir)) if (!loadedBy.has(f)) loadedBy.set(f, config);
  }
  // A listed file no opened project loaded (its owner excludes it): look in the others.
  for (const config of only ? configs.filter(c => !owners!.has(path.dirname(c))) : []) {
    if ([...only!].every(f => indexed.has(f) || loadedBy.has(path.join(root, f)))) break;
    for (const f of indexIn(config, () => false)) if (!loadedBy.has(f)) loadedBy.set(f, config);
  }
  const leftovers = new Map<string, Set<string>>();
  for (const [f, config] of loadedBy) {
    if (indexed.has(rel(f)) || !wanted(f)) continue;
    let set = leftovers.get(config);
    if (!set) leftovers.set(config, (set = new Set()));
    set.add(f);
  }
  for (const [config, set] of leftovers) indexIn(config, f => set.has(f));
  // What no project indexed — outside every tsconfig, or a repo with none — as one inferred program.
  const small = (f: string) => { try { return fs.statSync(path.join(root, f)).size <= MAX_SOURCE_FILE_SIZE_BYTES; } catch { return false; } };
  const orphans = (only ? [...only] : repoFiles(root))
    .filter(f => SOURCE.test(f) && !DECLARATION_FILE.test(f) && !indexed.has(f) && small(f)).map(f => path.join(root, f));
  if (orphans.length) {
    const set = new Set(orphans);
    indexIn(orphans, f => set.has(f));
  }
  (snapshot as TsSnapshot | null)?.dispose(); // assigned inside open()
  ts.api.close();

  // Indexed files are documents; every file a reference lands in defines its target itself.
  const fd = fs.openSync(output, 'w');
  try {
    fs.writeSync(fd, encodeMetadata({ toolName: 'tsgo-index', toolVersion: ts.version, projectRoot: pathToFileURL(root).href }));
    const bytes = new Map<string, Buffer>();
    const symbolBytes = (s: string) => {
      let b = bytes.get(s);
      if (!b) bytes.set(s, (b = Buffer.from(s)));
      return b;
    };
    for (const [file, occurrences] of docs) {
      if (!indexed.has(file)) continue;
      fs.writeSync(fd, encodeDocument({
        relativePath: file, language: 'typescript', positionEncoding: POSITION_ENCODING_UTF16, occurrences,
        implementations: implementations.get(file),
      }, symbolBytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { warnings, documents: indexed.size };
}

/** A `--refs` list as path → lines. */
function readRefs(file: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    const [p, line] = l.split('\t');
    if (!p || !line) continue;
    let lines = out.get(p);
    if (!lines) out.set(p, (lines = new Set()));
    lines.add(Number(line));
  }
  return out;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const onlyAt = args.indexOf('--only');
  const onlyList = onlyAt >= 0 ? args.splice(onlyAt, 2)[1] : undefined;
  const refsAt = args.indexOf('--refs');
  const refsList = refsAt >= 0 ? args.splice(refsAt, 2)[1] : undefined;
  const [tsDir, output, root, ...configs] = args;
  if (!tsDir || !output || !root || (onlyAt >= 0 && !onlyList) || (refsAt >= 0 && !refsList)) {
    process.stderr.write('usage: tsgo-index <typescript package dir> <output> <root> [--only <file with one path per line>] [--refs <file with path<TAB>line lines>] [<tsconfig>...]\n');
    process.exit(2);
  }
  const only = onlyList ? new Set(fs.readFileSync(onlyList, 'utf8').split('\n').filter(Boolean)) : undefined;
  indexProjects(path.resolve(tsDir), path.resolve(output), path.resolve(root), configs.map(c => path.resolve(root, c)), only, refsList ? readRefs(refsList) : undefined)
    .then(({ warnings, documents }) => {
      for (const w of warnings) process.stderr.write(`${RUN_WARNING}${w}\n`);
      if (documents === 0 && !only) {
        process.stderr.write('no project could be indexed\n');
        process.exit(1);
      }
    })
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    });
}
