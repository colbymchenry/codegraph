/**
 * A SCIP indexer for TS/JS on TypeScript 7's native compiler (tsgo), through
 * its API (`typescript/unstable/sync`, TypeScript ≥ 7.1). The typescript
 * adapter runs it as its own process when that API is installed:
 *
 *   node tsgo-index.js <typescript package dir> <output> <root> <tsconfig>...
 *
 * It writes exactly what the merge reads (see compact.ts) and nothing more: a
 * reference at the callee name of every call and `new` in a project file, and
 * the definition of every callee the project declares. A symbol is named after
 * its first declaration (file + node index), so an overload maps to its first
 * signature, and a declaration reached from two projects is one symbol.
 *
 * Projects are opened one at a time in a single process. A file is indexed by
 * the deepest project containing it (its own tsconfig resolves its imports), or
 * — when that project never loads it — by the first project that does. Every
 * definition lands in its file's document whichever project referenced it. A
 * project that fails to open is reported on stderr (RUN_WARNING) and its files
 * stay heuristic-only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { ROLE_DEFINITION, ScipOccurrence, encodeDocument, encodeMetadata } from '../reader';
import { RUN_WARNING } from './index';
import { packageVersion } from './typescript';

/** SCIP `PositionEncoding.UTF16CodeUnitOffsetFromLineStart`: the API's positions index JS strings. */
const POSITION_ENCODING_UTF16 = 2;
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** Files indexed between drops of the client-side AST cache. */
const CACHE_FILES = 1000;

// The slice of the (unstable, untyped here) API this indexer uses.
interface TsNode {
  kind: number;
  pos: number;
  end: number;
  name?: TsNode;
  expression?: TsNode;
  parent?: TsNode;
  forEachChild(visit: (n: TsNode) => unknown): unknown;
}
interface TsSourceFile extends TsNode {
  text: string;
  getOrCreateNodeAtIndex(index: number): TsNode | undefined;
}
interface TsSymbol {
  id: number;
  name: string;
  flags: number;
  checkFlags: number;
  declarations?: readonly { path: string; index: number }[];
}
interface TsProject {
  configFileName: string;
  program: { getSourceFileNames(): readonly string[]; getSourceFile(file: string): TsSourceFile | undefined };
  checker: { getSymbolAtPosition(file: string, positions: readonly number[]): (TsSymbol | undefined)[]; getAliasedSymbol(s: TsSymbol): TsSymbol };
}
interface TsSnapshot { getProjects(): readonly TsProject[]; dispose(): void }
interface TsApi {
  createSnapshot(params: { openProjects?: string[]; closeProjects?: string[] }): TsSnapshot;
  clearSourceFileCache(): void;
  close(): void;
}
interface Loaded {
  api: TsApi;
  SyntaxKind: Record<string, number>;
  SymbolFlags: Record<'Alias' | 'Class' | 'Function' | 'Method' | 'Variable' | 'Property', number>;
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

/** A SCIP identifier: plain when it can be, else backtick-quoted. */
const esc = (s: string) => (/^[\w+$-]+$/.test(s) ? s : '`' + s.replace(/`/g, '``') + '`');

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

export async function indexProjects(tsDir: string, output: string, root: string, configs: string[]): Promise<{ warnings: string[]; documents: number }> {
  const ts = await load(tsDir, root);
  const K = ts.SyntaxKind;
  const F = ts.SymbolFlags;
  const C = ts.CheckFlags;
  const CALLEE_HOLDERS = new Set([K.CallExpression, K.NewExpression]);
  const NAMES = new Set([K.Identifier, K.PrivateIdentifier]);
  const UNWRAP = new Set([K.NonNullExpression, K.ParenthesizedExpression]);

  const rootPrefix = root.endsWith('/') ? root : `${root}/`;
  const inRepo = (p: string) => p.startsWith(rootPrefix) && !p.includes('/node_modules/');
  const rel = (p: string) => p.slice(rootPrefix.length);

  /** repo-relative path → the occurrences of its document (files indexed, plus files holding definitions) */
  const docs = new Map<string, ScipOccurrence[]>();
  const docOf = (file: string) => {
    let occ = docs.get(file);
    if (!occ) docs.set(file, (occ = []));
    return occ;
  };
  const indexed = new Set<string>();
  const defined = new Set<string>();
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
  const open = (config: string): TsProject | null => {
    try {
      snapshot?.dispose();
      snapshot = ts.api.createSnapshot({ openProjects: [config], ...(previous && previous !== config ? { closeProjects: [previous] } : {}) });
      const project = snapshot.getProjects().find(p => p.configFileName === config);
      if (!project) throw new Error('not loaded');
      return project;
    } catch (err) {
      warnings.push(`${rel(config)}: can't open the project (${err instanceof Error ? err.message : String(err)})`);
      return null;
    } finally {
      previous = config;
    }
  };

  /** Indexes the files of `config`'s program that `want` accepts; returns the other repo files it loaded. */
  const indexIn = (config: string, want: (file: string) => boolean): string[] => {
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
     * The declarations a callee stands for: its first one (an overload's first
     * signature), or — for a member of a union/intersection type, a synthetic
     * symbol whose declarations are every constituent's — the first per
     * constituent, since the call may reach any of them.
     */
    const targetsOf = (t: TsSymbol): Decl[] => {
      const decls = t.declarations ?? [];
      if (!(t.checkFlags & C.Synthetic)) return decls.slice(0, 1);
      const seen = new Set<string>();
      return decls.filter(d => {
        const parent = nodeOf(d)?.node?.parent;
        const key = `${d.path}\0${parent?.pos ?? d.index}`;
        return !seen.has(key) && seen.add(key);
      });
    };

    /** The SCIP symbols of a callee; for project declarations, also records the definition. */
    const symbolsOf = (s: TsSymbol, isNew: boolean): string[] => {
      let t = s;
      if (s.flags & F.Alias) {
        let a = aliases.get(s.id);
        if (!a) aliases.set(s.id, (a = checker.getAliasedSymbol(s)));
        t = a;
      }
      const suffix = t.flags & F.Class ? '#'
        : isNew ? null // `new` of a non-class value: nothing codegraph models
        : t.flags & (F.Function | F.Method) ? '().'
        : t.flags & (F.Variable | F.Property) ? '.' // a function-valued binding; the merge keeps it only if it maps to a callable
        : null;
      if (!suffix) return [];
      return targetsOf(t).map(decl => {
        if (!inRepo(decl.path)) return `tsgo npm . . ${esc(t.name)}${suffix}`;
        const file = rel(decl.path);
        const symbol = `tsgo . . . ${esc(file)}/${decl.index}/${esc(t.name)}${suffix}`;
        if (defined.has(symbol)) return symbol;
        defined.add(symbol);
        // Defined at the declaration's name (its start when it has none, e.g. `export default class {`).
        // Always defined somewhere: a project symbol without a definition would read as external.
        const at = nodeOf(decl);
        let range = { startLine: 0, startCol: 0, endLine: 0, endCol: 0 };
        if (at?.node) {
          const { sf, node } = at;
          const start = ts.skipTrivia(sf.text, (node.name ?? node).pos);
          range = span(decl.path, sf.text, start, node.name ? node.name.end : start);
        }
        docOf(file).push({ range, symbol, roles: ROLE_DEFINITION });
        return symbol;
      });
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
      const visit = (n: TsNode): undefined => {
        if (CALLEE_HOLDERS.has(n.kind) && n.expression) {
          let e: TsNode | undefined = n.expression;
          while (e && UNWRAP.has(e.kind)) e = e.expression;
          if (e && e.kind === K.PropertyAccessExpression) e = e.name;
          if (e && NAMES.has(e.kind)) sites.push({ start: ts.skipTrivia(sf.text, e.pos), end: e.end, isNew: n.kind === K.NewExpression });
        }
        n.forEachChild(visit);
        return undefined;
      };
      sf.forEachChild(visit);
      const occ = docOf(rel(f));
      const symbols = sites.length ? checker.getSymbolAtPosition(f, sites.map(s => s.start)) : [];
      symbols.forEach((s, i) => {
        const site = sites[i]!;
        if (!s) return;
        const range = span(f, sf.text, site.start, site.end);
        for (const symbol of new Set(symbolsOf(s, site.isNew))) occ.push({ range, symbol, roles: 0 });
      });
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
  const loadedBy = new Map<string, string>();
  for (const config of configs) {
    const dir = path.dirname(config);
    for (const f of indexIn(config, f => owner(f) === dir)) if (!loadedBy.has(f)) loadedBy.set(f, config);
  }
  const leftovers = new Map<string, Set<string>>();
  for (const [f, config] of loadedBy) {
    if (indexed.has(rel(f))) continue;
    let set = leftovers.get(config);
    if (!set) leftovers.set(config, (set = new Set()));
    set.add(f);
  }
  for (const [config, set] of leftovers) indexIn(config, f => set.has(f));
  (snapshot as TsSnapshot | null)?.dispose(); // assigned inside open()
  ts.api.close();

  // Only indexed files are documents: a definition in a file no project loaded
  // can't happen (the declaring file is in the program that referenced it).
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
      fs.writeSync(fd, encodeDocument({ relativePath: file, language: 'typescript', positionEncoding: POSITION_ENCODING_UTF16, occurrences }, symbolBytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { warnings, documents: indexed.size };
}

if (require.main === module) {
  const [tsDir, output, root, ...configs] = process.argv.slice(2);
  if (!tsDir || !output || !root || configs.length === 0) {
    process.stderr.write('usage: tsgo-index <typescript package dir> <output> <root> <tsconfig>...\n');
    process.exit(2);
  }
  indexProjects(path.resolve(tsDir), path.resolve(output), path.resolve(root), configs.map(c => path.resolve(root, c)))
    .then(({ warnings, documents }) => {
      for (const w of warnings) process.stderr.write(`${RUN_WARNING}${w}\n`);
      if (documents === 0) {
        process.stderr.write('no project could be indexed\n');
        process.exit(1);
      }
    })
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    });
}
