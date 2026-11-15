/**
 * Source-derived LuaJIT → Rust bridge. A call through a proven FFI receiver
 * links by exact symbol to the one Rust C-ABI export with that symbol. A
 * literal operation forwarded through Lua and Rust wrappers links to the
 * handler its `match` arm selects, and the call into the shared export is
 * kept as a transport-only reference: following its dispatcher as an
 * ordinary call would make every operation reach every arm. No project
 * symbol, library filename or operation name is built in.
 */
import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { loadGrammarsForLanguages } from '../extraction/grammars';
import { createRustBridgeIdentity } from './rust-bridge-identity';
import type { LuaAnalysis, LuaCall } from './lua-ffi-analysis';
import { cachedLuaAnalysis, cachedRustAnalysis, cachedRustModules, pruneStoredAnalyses } from './bridge-analysis-cache';
import {
  resolveRustFfiDispatch, findRustDispatchingExports,
  type RustFunctionSummary, type RustFfiExport, type RustFfiDispatchRoute, type RustFfiFileAnalysis,
} from './rust-ffi-analysis';

interface Site { call: LuaCall; source: Node; analysis: LuaAnalysis; file: string }
interface Channel { native: Node; routes: RustFfiDispatchRoute[]; parameter: number }
const callable = (node: Node): boolean => node.kind === 'function' || node.kind === 'method';

/**
 * A call credited to an enclosing function forwards only that function's own
 * parameters: one of the closure's own, or of a function between the two, is
 * no parameter of the function credited.
 */
function creditedTo(call: LuaCall, owner: number | undefined): LuaCall {
  const args = call.args.map(({ parameterIndex: _own, capturedParameter, ...arg }) =>
    capturedParameter && capturedParameter.owner === owner ? { ...arg, parameterIndex: capturedParameter.index } : arg);
  return { ...call, args };
}

function rustNode(ctx: ResolutionContext, fn: RustFunctionSummary): Node | undefined {
  const nodes = ctx.getNodesInFile(fn.filePath).filter(n => n.language === 'rust' && callable(n) &&
    n.name === fn.name && n.startLine === fn.line && n.startColumn === fn.column);
  return nodes.length === 1 ? nodes[0] : undefined;
}

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

/** What a file the analysis could not read contributes: no facts, never stored. */
const unreadLua = (): LuaAnalysis => ({ calls: [], functions: [], exportedFunctions: {}, exportedLibraries: [], exportedLoaders: [], cdefSymbols: {}, partial: true });
const unreadRust = (filePath: string): RustFfiFileAnalysis => ({ filePath, functions: [], exports: [], calls: [], dispatches: [],
  potentialDispatchParameters: {}, potentialDispatchPaths: [], macroContracts: [], macroDefinitions: [], partial: true });

/**
 * The Rust a route can pass through: the files declaring an export, then each
 * round the files that define, by name, a function an analyzed function the
 * exports reach forwards a value to, dispatches to, or invokes a macro of. A
 * function no forwarded value reaches can't carry an operation.
 */
async function analyzeRust(ctx: ResolutionContext, sources: Map<string, string>, live: Set<string>, onYield: MaybeYield): Promise<RustFfiFileAnalysis[]> {
  const analyses = new Map<string, RustFfiFileAnalysis>();
  /** Names whose definitions a route may pass through, and those already looked for in the unread files. */
  const sought = new Set<string>();
  const searched = new Set<string>();
  const reached = new Set<string>();
  let pending = [...sources].filter(([, source]) => EXPORT_LITERAL.test(source)).map(([file]) => file);
  while (pending.length) {
    for (const file of pending) {
      let analysis: RustFfiFileAnalysis;
      try { analysis = await cachedRustAnalysis(ctx, file, sources.get(file)!, live); } catch { analysis = unreadRust(file); }
      analyses.set(file, analysis);
      await onYield();
    }
    const all = [...analyses.values()];
    const exported = new Set(all.flatMap(analysis => analysis.exports.map(exp => exp.functionId)));
    const named = new Map<string, Set<string>>();
    const add = (id: string, name: string): void => { if (name) named.set(id, (named.get(id) ?? new Set()).add(name)); };
    for (const analysis of all) {
      for (const call of analysis.calls) if (call.argumentPossibilities.some(origins => origins.length)) {
        add(call.fromFunctionId, call.targetName);
        for (const proof of call.invocationProofs ?? []) if (proof.macro) add(call.fromFunctionId, proof.macro.name.split('::').pop()!);
        for (const requirement of call.requiredCallbacks ?? []) add(call.fromFunctionId, requirement.targetName);
      }
      for (const dispatch of analysis.dispatches) add(dispatch.functionId, dispatch.targetName);
      for (const arm of analysis.potentialDispatchPaths) add(arm.functionId, arm.name);
    }
    // Reach, by name, from the exports through the files read so far.
    for (;;) {
      const frontier = all.flatMap(analysis => analysis.functions).filter(fn => !reached.has(fn.id) && (exported.has(fn.id) || sought.has(fn.name)));
      if (!frontier.length) break;
      for (const fn of frontier) {
        reached.add(fn.id);
        for (const name of named.get(fn.id) ?? []) sought.add(name);
      }
    }
    const fresh = [...sought].filter(name => !searched.has(name));
    fresh.forEach(name => searched.add(name));
    if (!fresh.length) break;
    const definition = new RegExp(`\\b(?:fn|macro_rules!)\\s*(?:${fresh.map(escapeRegExp).join('|')})\\b`);
    pending = [...sources].filter(([file, source]) => !analyses.has(file) && definition.test(source)).map(([file]) => file);
  }
  return [...analyses.values()];
}

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
    else rustSources.set(fileNode.filePath, source);
  }
  // An edge needs a Lua file that can prove an FFI receiver and a Rust file that can export a symbol.
  if (![...luaSources.values()].some(({ source }) => FFI_LITERAL.test(source))) return [];
  if (![...rustSources.values()].some(source => EXPORT_LITERAL.test(source))) return [];
  await loadGrammarsForLanguages(['lua', 'rust']);
  const live = new Set<string>();
  const started = Date.now();
  const rustFiles = await analyzeRust(ctx, rustSources, live, onYield);
  const rustMs = Date.now() - started;
  const functions = new Map(rustFiles.flatMap(f => f.functions).map(f => [f.id, f]));
  const exportsBySymbol = new Map<string, RustFfiExport[]>();
  for (const exp of rustFiles.flatMap(f => f.exports)) {
    const entries = exportsBySymbol.get(exp.symbolName) ?? [];
    entries.push(exp);
    exportsBySymbol.set(exp.symbolName, entries);
  }
  const routing = Date.now();
  const resolveOwner = createRustBridgeIdentity(ctx, (file, source) => cachedRustModules(ctx, file, source, live));
  const routes = resolveRustFfiDispatch(rustFiles, resolveOwner);
  const dispatching = findRustDispatchingExports(rustFiles, resolveOwner);
  const routesByExport = new Map<string, RustFfiDispatchRoute[]>();
  for (const route of routes) {
    const entries = routesByExport.get(route.export.functionId) ?? [];
    entries.push(route);
    routesByExport.set(route.export.functionId, entries);
  }
  const routesMs = Date.now() - routing;

  const sites: Site[] = [];
  const luaFiles = new Map<string, { analysis: LuaAnalysis; symbols: Map<number, Node> }>();
  const analyzeLuaFile = (file: string): void => {
    const { fileNode, source } = luaSources.get(file)!;
    let analysis: LuaAnalysis;
    try { analysis = cachedLuaAnalysis(ctx, file, source, live); } catch { analysis = unreadLua(); }
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
    luaFiles.set(file, { analysis, symbols });
    const parents = new Map(analysis.functions.map(fn => [fn.startIndex, fn.parentStartIndex]));
    for (const call of analysis.calls) {
      // A call in a function no node stands for, like a closure passed as an
      // argument, counts for the nearest enclosing function one does, as the
      // extractor's own calls do, and at chunk level for the file.
      let owner = call.functionStartIndex;
      while (owner !== undefined && !symbols.has(owner)) owner = parents.get(owner);
      const source = owner === undefined ? fileNode : symbols.get(owner)!;
      sites.push({ call: owner === call.functionStartIndex ? call : creditedTo(call, owner), source, analysis, file });
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

  // Routes everything the analyzed files prove: the edges, and the files of the
  // functions that carry an operation into a dispatching export.
  const route = async (): Promise<{ edges: Edge[]; carrierFiles: Set<string> }> => {
    // cdef declarations are global to a LuaJIT state; an asm label renames the linked symbol.
    const declared = new Map<string, Set<string>>();
    for (const { analysis } of luaFiles.values()) {
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
    /**
     * The symbol a call through another module reaches: `cdefs.clib.router_new()` where that module
     * returns a library as `clib`, or `api.load().run()` where its `load` returns one.
     */
    const throughModule = (call: LuaCall): string | undefined => {
      if (!call.importedModule || call.resolvedCallee === undefined) return undefined;
      const file = resolveLuaModule(call.importedModule);
      const module = file ? luaFiles.get(file)?.analysis : undefined;
      if (!module) return undefined;
      const path = call.resolvedCallee;
      const dot = path.lastIndexOf('.');
      const [prefix, symbol] = dot < 0 ? ['', path] : [path.slice(0, dot), path.slice(dot + 1)];
      if (!symbol || symbol.endsWith('()')) return undefined;
      if (module.exportedLibraries.includes(prefix)) return symbol;
      return prefix.endsWith('()') && module.exportedLoaders.includes(prefix.slice(0, -2)) ? symbol : undefined;
    };
    const edges: Edge[] = [];
    // One edge per caller and handler; every operation that reaches the handler stays on it.
    const operationEdges = new Map<string, Edge>();
    const carriers = new Map<string, Channel[]>();
    const carrierFiles = new Set<string>();
    const sitesByTarget = new Map<string, Site[]>();
    const queue: Array<{ nodeId: string; channel: Channel }> = [];
    const recordTarget = (site: Site, id: string): void => {
      const callers = sitesByTarget.get(id) ?? [];
      callers.push(site);
      sitesByTarget.set(id, callers);
    };
    // A module that hands out a library: a file that requires it may call through it.
    for (const [file, { analysis }] of luaFiles) if (analysis.exportedLibraries.length || analysis.exportedLoaders.length) carrierFiles.add(file);
    for (const site of sites) {
      if (site.call.ffiSymbol) continue;
      if (site.call.localFunctionStartIndex !== undefined) {
        const target = luaFiles.get(site.file)?.symbols.get(site.call.localFunctionStartIndex);
        if (target) recordTarget(site, target.id);
        continue;
      }
      // Ordinary Lua name resolution intentionally includes some heuristics.
      // A native operation route needs stronger evidence: one module file and
      // its actual returned table/function exporting this exact member.
      if (!site.call.importedModule) continue;
      const file = resolveLuaModule(site.call.importedModule);
      const module = file && luaFiles.get(file);
      const exported = module && module.analysis.exportedFunctions[site.call.resolvedCallee ?? ''];
      const target = typeof exported === 'number' && module ? module.symbols.get(exported) : undefined;
      if (target) recordTarget(site, target.id);
    }
    const addCarrier = (node: Node, channel: Channel): void => {
      const channels = carriers.get(node.id) ?? [];
      if (channels.some(c => c.native.id === channel.native.id && c.parameter === channel.parameter && c.routes === channel.routes)) return;
      channels.push(channel);
      carriers.set(node.id, channels);
      carrierFiles.add(node.filePath);
      queue.push({ nodeId: node.id, channel });
    };
    const link = (site: Site, native: Node, relevant: RustFfiDispatchRoute[], argumentIndex: number): void => {
      const argument = site.call.args[argumentIndex];
      if (!argument) return;
      if (argument.parameterIndex !== undefined) {
        addCarrier(site.source, { native, routes: relevant, parameter: argument.parameterIndex });
        return;
      }
      if (argument.kind !== 'string') return;
      const matching = relevant.filter(r => r.operation === argument.value);
      const targets = [...new Set(matching.map(r => r.target.id))];
      if (targets.length !== 1) return; // duplicate/ambiguous operation target
      const route = matching[0]!;
      const target = rustNode(ctx, route.target);
      if (!target) return;
      const key = `${site.source.id}>${target.id}`;
      const existing = operationEdges.get(key);
      if (existing) {
        const operations = existing.metadata!.operations as string[];
        if (!operations.includes(route.operation)) operations.push(route.operation);
        // The edge stands at its earliest call, whichever round analyzed that call first.
        if (site.call.line < existing.line! || (site.call.line === existing.line && site.call.column < existing.column!)) {
          existing.line = site.call.line;
          existing.column = site.call.column;
          existing.metadata!.sourceCall = `${site.file}:${site.call.line}:${site.call.column}`;
        }
        return;
      }
      operationEdges.set(key, { source: site.source.id, target: target.id, kind: 'calls', line: site.call.line,
        column: site.call.column, provenance: 'heuristic', metadata: {
          synthesizedBy: 'lua-rust-operation', operation: route.operation, operations: [route.operation],
          nativeExport: native.id, nativeSymbol: route.export.symbolName,
          registeredAt: `${route.dispatcher.filePath}:${route.dispatchLine}`,
          sourceCall: `${site.file}:${site.call.line}:${site.call.column}`,
          rustPath: route.callPath.map(f => `${f.filePath}:${f.line}`),
        } });
    };
    for (const site of sites) {
      const called = site.call.ffiSymbol ?? throughModule(site.call);
      const symbol = called && linkedSymbol(called);
      if (!symbol) continue;
      const matches = exportsBySymbol.get(symbol) ?? [];
      if (matches.length !== 1) continue; // identical exports in separate native libraries
      const exp = matches[0]!;
      const fn = functions.get(exp.functionId);
      const native = fn && rustNode(ctx, fn);
      if (!native) continue;
      const relevant = routesByExport.get(exp.functionId) ?? [];
      edges.push({ source: site.source.id, target: native.id,
        kind: dispatching.has(exp.functionId) ? 'references' : 'calls', line: site.call.line, column: site.call.column,
        provenance: 'heuristic', metadata: { synthesizedBy: 'lua-rust-ffi',
          nativeSymbol: exp.symbolName, registeredAt: `${exp.filePath}:${exp.line}`,
          ...(dispatching.has(exp.functionId) ? { transportOnly: true } : {}),
        } });
      for (const index of new Set(relevant.map(r => r.exportParameterIndex))) {
        link(site, native, relevant.filter(r => r.exportParameterIndex === index), index);
      }
    }
    // Each (function, parameter, native-export, route-set) channel is processed once.
    // This supports recursive/arbitrary-depth wrappers without a hop cap or
    // repeatedly scanning every call site for every forwarding level.
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const { nodeId, channel } = queue[cursor]!;
      for (const site of sitesByTarget.get(nodeId) ?? []) link(site, channel.native, channel.routes, channel.parameter);
      if ((cursor & 127) === 0) await onYield();
    }
    for (const edge of operationEdges.values()) {
      const operations = (edge.metadata!.operations as string[]).sort();
      edge.metadata!.operation = operations[0];
    }
    return { edges: [...edges, ...operationEdges.values()], carrierFiles };
  };

  // A call reaches Rust only through an FFI receiver, which only a file holding
  // the literal "ffi" proves, or through a carrier, which only a file that can
  // name the carrier's module in `require` (or defines it) calls. So the pass
  // analyzes the files holding "ffi", routes them, and then each round the
  // files that can name a module a carrier was found in, until a round finds
  // no new one; any other Lua file could add no edge.
  let pending = [...luaSources].filter(([, { source }]) => FFI_LITERAL.test(source)).map(([file]) => file);
  const named = new Set<string>();
  let routed: { edges: Edge[]; carrierFiles: Set<string> };
  for (;;) {
    for (const file of pending) {
      analyzeLuaFile(file);
      await onYield();
    }
    routed = await route();
    const tails = [...routed.carrierFiles].flatMap(moduleTails).filter(tail => !named.has(tail));
    tails.forEach(tail => named.add(tail));
    const names = tails.map(requireNamePattern);
    pending = [...luaSources]
      .filter(([file, { source }]) => !luaFiles.has(file) && names.some(name => name.test(source)))
      .map(([file]) => file);
    if (pending.length === 0) break;
  }
  pruneStoredAnalyses(ctx, live);
  if (process.env.CODEGRAPH_SYNTH_TIMINGS) {
    console.error(`[synth-timing] luaRustBridge: rust ${rustFiles.length}/${rustSources.size} files ${rustMs}ms, ` +
      `routes ${routesMs}ms, lua ${luaFiles.size}/${luaSources.size} files ${Date.now() - started - rustMs - routesMs}ms, ` +
      `${routed.edges.length} edges`);
  }
  return routed.edges;
}
