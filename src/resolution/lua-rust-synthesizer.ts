/**
 * Source-derived LuaJIT → Rust FFI links. A LuaJIT call through a proven FFI
 * receiver (`require("ffi")`, `ffi.C`, `ffi.load(...)`, their aliases, and a
 * library another module loads and hands out) links by exact symbol to the
 * one Rust C-ABI export with that symbol. Two exports with one symbol link
 * neither. No project symbol, library filename or module name is built in.
 */
import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { loadGrammarsForLanguages } from '../extraction/grammars';
import type { LuaAnalysis, LuaCall } from './lua-ffi-analysis';
import type { RustFfiExport } from './rust-ffi-exports';
import { cachedLuaAnalysis, cachedRustExports, pruneStoredAnalyses } from './bridge-analysis-cache';

interface Site { call: LuaCall; source: Node; file: string }
const callable = (node: Node): boolean => node.kind === 'function' || node.kind === 'method';

/** Only a file holding the literal "ffi" (quoted or long-bracketed) can prove an FFI receiver. */
export const FFI_LITERAL = /(["'])ffi\1|\[(=*)\[\r?\n?ffi\]\2\]/;
/** Only a file naming one of these attributes can declare an export the analysis recognizes. */
export const EXPORT_LITERAL = /\b(?:no_mangle|export_name)\b/;

/** Whether the project holds a Lua file that can prove an FFI receiver and a Rust file that can export a symbol. */
export function luaRustBridgeOpen(ctx: ResolutionContext): boolean {
  let lua = false;
  let rust = false;
  for (const fileNode of (ctx.iterateNodesByKind?.('file') ?? ctx.getNodesByKind('file'))) {
    if (lua && rust) break;
    if (fileNode.language === 'lua' && !lua) lua = FFI_LITERAL.test(ctx.readFile(fileNode.filePath) ?? '');
    else if (fileNode.language === 'rust' && !rust) rust = EXPORT_LITERAL.test(ctx.readFile(fileNode.filePath) ?? '');
  }
  return lua && rust;
}

/**
 * The last segment of any `require` name resolving to `file`: the file's
 * name, and for an `init.lua` its directory's name and `init` itself.
 */
function moduleTails(file: string): string[] {
  const parts = file.replace(/\.lua$/, '').split('/');
  return parts.length > 1 && parts.at(-1) === 'init' ? [parts.at(-2)!, 'init'] : [parts.at(-1)!];
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What a file must hold to name, in `require`, a module whose name ends with
 * `tail`: `require` reads only a string literal, so one whose text ends with
 * the tail after a `.`, a `/` or nothing (`"game.core"`, `'core'`,
 * `[[game/core]]`). A tail an escape sequence could spell matches every file.
 */
export function requireNamePattern(tail: string): RegExp {
  if (/[\x00-\x1f"'\\]/.test(tail)) return /(?:)/;
  const name = escapeRegExp(tail);
  return new RegExp(`"(?:(?:[^"\\\\\\r\\n]|\\\\[\\s\\S])*[./])?${name}"|'(?:(?:[^'\\\\\\r\\n]|\\\\[\\s\\S])*[./])?${name}'|` +
    `\\[(=*)\\[(?:\\r?\\n)?(?:[\\s\\S]*?[./])?${name}\\]\\1\\]`);
}

/** What a file the analysis could not read contributes: no facts. */
const unreadLua = (): LuaAnalysis => ({ calls: [], functions: [], exportedLibraries: [], exportedLoaders: [], cdefSymbols: {}, partial: true });

/**
 * The pass never throws: one that did would take every other pass's
 * synthesized edges with it, so a failure here costs only this pass's.
 */
export async function luaRustBridgeEdges(_queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  try {
    return await bridgeEdges(ctx, onYield);
  } catch {
    return [];
  }
}

async function bridgeEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const luaSources = new Map<string, { fileNode: Node; source: string }>();
  const rustSources = new Map<string, string>();
  for (const fileNode of (ctx.iterateNodesByKind?.('file') ?? ctx.getNodesByKind('file'))) {
    if (fileNode.language !== 'lua' && fileNode.language !== 'rust') continue;
    const source = ctx.readFile(fileNode.filePath);
    if (source === null) continue;
    if (fileNode.language === 'lua') luaSources.set(fileNode.filePath, { fileNode, source });
    else if (EXPORT_LITERAL.test(source)) rustSources.set(fileNode.filePath, source);
  }
  // An edge needs a Lua file that can prove an FFI receiver and a Rust file that can export a symbol.
  if (!rustSources.size || ![...luaSources.values()].some(({ source }) => FFI_LITERAL.test(source))) return [];
  await loadGrammarsForLanguages(['lua', 'rust']);
  const started = Date.now();
  /** The stored analyses this pass uses; every other entry is pruned once it has run. */
  const live = new Set<string>();

  const exportsBySymbol = new Map<string, RustFfiExport[]>();
  for (const [file, source] of rustSources) {
    let exports: RustFfiExport[] = [];
    try { ({ exports } = await cachedRustExports(ctx, file, source, live)); } catch { /* a file the scan can't read exports nothing */ }
    for (const exp of exports) exportsBySymbol.set(exp.symbolName, [...(exportsBySymbol.get(exp.symbolName) ?? []), exp]);
    await onYield();
  }
  const rustNode = (exp: RustFfiExport): Node | undefined => {
    const nodes = ctx.getNodesInFile(exp.filePath).filter(n => n.language === 'rust' && callable(n) &&
      n.name === exp.name && n.startLine === exp.line && n.startColumn === exp.column);
    return nodes.length === 1 ? nodes[0] : undefined;
  };

  const sites: Site[] = [];
  const luaFiles = new Map<string, LuaAnalysis>();
  const analyzeLuaFile = (file: string): void => {
    const { fileNode, source } = luaSources.get(file)!;
    let analysis: LuaAnalysis;
    try { analysis = cachedLuaAnalysis(ctx, file, source, live); } catch { analysis = unreadLua(); }
    luaFiles.set(file, analysis);
    // A function's node starts where it does, whatever its name: `M["send"] = function` is named `send`.
    const byPosition = new Map<string, Node[]>();
    for (const node of ctx.getNodesInFile(file).filter(callable)) {
      const key = `${node.startLine}:${node.startColumn}`;
      byPosition.set(key, [...(byPosition.get(key) ?? []), node]);
    }
    const symbols = new Map<number, Node>();
    for (const fn of analysis.functions) {
      const nodes = byPosition.get(`${fn.line}:${fn.column}`) ?? [];
      if (nodes.length === 1) symbols.set(fn.startIndex, nodes[0]!);
    }
    const parents = new Map(analysis.functions.map(fn => [fn.startIndex, fn.parentStartIndex]));
    for (const call of analysis.calls) {
      // A call in a function no node stands for, like a closure passed as an
      // argument, counts for the nearest enclosing function one does, as the
      // extractor's own calls do, and at chunk level for the file.
      let owner = call.functionStartIndex;
      while (owner !== undefined && !symbols.has(owner)) owner = parents.get(owner);
      sites.push({ call, source: owner === undefined ? fileNode : symbols.get(owner)!, file });
    }
  };
  // Every Lua file counts toward whether a module name is unique, analyzed or not.
  const moduleFiles = new Map<string, string | null>();
  const resolveLuaModule = (name: string): string | null => {
    if (moduleFiles.has(name)) return moduleFiles.get(name)!;
    const base = name.replace(/\./g, '/');
    const suffixes = [`${base}.lua`, `${base}/init.lua`];
    const matches = [...luaSources.keys()].filter(file => suffixes.some(suffix => file === suffix || file.endsWith('/' + suffix)));
    const found = matches.length === 1 ? matches[0]! : null;
    moduleFiles.set(name, found); return found;
  };
  /**
   * The symbol a call through another module reaches: `cdefs.clib.router_new()` where that module
   * returns a library as `clib`, or `api.load().run()` where its `load` returns one.
   */
  const throughModule = (call: LuaCall): string | undefined => {
    if (!call.importedModule || call.resolvedCallee === undefined) return undefined;
    const file = resolveLuaModule(call.importedModule);
    const module = file ? luaFiles.get(file) : undefined;
    if (!module) return undefined;
    const path = call.resolvedCallee;
    const dot = path.lastIndexOf('.');
    const [prefix, symbol] = dot < 0 ? ['', path] : [path.slice(0, dot), path.slice(dot + 1)];
    if (!symbol || symbol.endsWith('()')) return undefined;
    if (module.exportedLibraries.includes(prefix)) return symbol;
    return prefix.endsWith('()') && module.exportedLoaders.includes(prefix.slice(0, -2)) ? symbol : undefined;
  };

  // A call reaches Rust only through an FFI receiver, which only a file holding
  // the literal "ffi" proves, or through a module that hands out a library,
  // which only a file that can name that module in `require` (or the module
  // itself) calls. So the pass analyzes the files holding "ffi", then each
  // round the files that can name a module found to hand out a library, until
  // a round finds no new one.
  let pending = [...luaSources].filter(([, { source }]) => FFI_LITERAL.test(source)).map(([file]) => file);
  const named = new Set<string>();
  while (pending.length) {
    for (const file of pending) {
      analyzeLuaFile(file);
      await onYield();
    }
    const tails = [...luaFiles].filter(([, analysis]) => analysis.exportedLibraries.length || analysis.exportedLoaders.length)
      .flatMap(([file]) => moduleTails(file)).filter(tail => !named.has(tail));
    tails.forEach(tail => named.add(tail));
    const names = tails.map(requireNamePattern);
    pending = [...luaSources]
      .filter(([file, { source }]) => !luaFiles.has(file) && names.some(name => name.test(source)))
      .map(([file]) => file);
  }

  // cdef declarations are global to a LuaJIT state; an asm label renames the linked symbol.
  const declared = new Map<string, Set<string>>();
  for (const analysis of luaFiles.values()) {
    for (const [name, symbols] of Object.entries(analysis.cdefSymbols)) {
      const all = declared.get(name) ?? new Set<string>();
      symbols.forEach(symbol => all.add(symbol));
      declared.set(name, all);
    }
  }
  const linkedSymbol = (name: string): string | undefined => {
    const symbols = declared.get(name);
    return !symbols ? name : symbols.size === 1 ? [...symbols][0] : undefined; // conflicting declarations
  };
  const edges: Edge[] = [];
  for (const site of sites) {
    const called = site.call.ffiSymbol ?? throughModule(site.call);
    const symbol = called && linkedSymbol(called);
    if (!symbol) continue;
    const matches = exportsBySymbol.get(symbol) ?? [];
    if (matches.length !== 1) continue; // identical exports in separate native libraries
    const exp = matches[0]!;
    const native = rustNode(exp);
    if (!native) continue;
    edges.push({ source: site.source.id, target: native.id, kind: 'calls', line: site.call.line, column: site.call.column,
      provenance: 'heuristic', metadata: { synthesizedBy: 'lua-rust-ffi', nativeSymbol: exp.symbolName, registeredAt: `${exp.filePath}:${exp.line}` } });
    if ((edges.length & 127) === 0) await onYield();
  }
  pruneStoredAnalyses(ctx, live);
  if (process.env.CODEGRAPH_SYNTH_TIMINGS) {
    console.error(`[synth-timing] luaRustBridge: rust ${rustSources.size} files, lua ${luaFiles.size}/${luaSources.size} files, ` +
      `${edges.length} edges in ${Date.now() - started}ms`);
  }
  return edges;
}
