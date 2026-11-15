/**
 * Source-derived LuaJIT → Rust bridge. This pass does not relax the ordinary
 * language gate. Only a proven FFI receiver can reach a C-ABI export.
 *
 * Literal operation routes bypass shared transport functions. The physical
 * boundary is retained as a transportOnly reference: following its Rust
 * dispatcher as an ordinary call would make every operation reach every arm.
 * No project symbol, library filename or operation name is built in.
 */
import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { loadGrammarsForLanguages } from '../extraction/grammars';
import { createRustBridgeIdentity } from './rust-bridge-identity';
import type { LuaAnalysis, LuaCall } from './lua-ffi-analysis';
import { cachedLuaAnalysis, cachedRustAnalysis, pruneStoredAnalyses } from './bridge-analysis-cache';
import {
  resolveRustFfiDispatch, findRustDispatchingExports,
  type RustFunctionSummary, type RustFfiExport, type RustFfiDispatchRoute,
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

/** Only a file holding the literal `"ffi"` (quoted or long-bracketed) can prove an FFI receiver. */
const FFI_LITERAL = /(["'])ffi\1|\[(=*)\[\r?\n?ffi\]\2\]/;

/**
 * The text any `require` name resolving to `file` contains: its last path
 * segment, the directory's name for an `init.lua`.
 */
function moduleTail(file: string): string {
  const parts = file.replace(/\.lua$/, '').split('/');
  if (parts.length > 1 && parts.at(-1) === 'init') parts.pop();
  return parts.at(-1)!;
}

export async function luaRustBridgeEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  // One bounded source read per relevant file; an unchanged file reuses its stored analysis.
  await loadGrammarsForLanguages(['lua', 'rust']);
  const live = new Set<string>();
  const rustFiles = [];
  const luaSources = new Map<string, { fileNode: Node; source: string }>();
  for (const fileNode of (ctx.iterateNodesByKind?.('file') ?? ctx.getNodesByKind('file'))) {
    const file = fileNode.filePath;
    const language = fileNode.language;
    if (language !== 'lua' && language !== 'rust') continue;
    const source = ctx.readFile(file);
    if (source === null) continue;
    if (language === 'rust') {
      rustFiles.push(await cachedRustAnalysis(ctx, file, source, live));
      await onYield();
    } else {
      luaSources.set(file, { fileNode, source });
    }
  }
  const functions = new Map(rustFiles.flatMap(f => f.functions).map(f => [f.id, f]));
  const exportsBySymbol = new Map<string, RustFfiExport[]>();
  for (const exp of rustFiles.flatMap(f => f.exports)) {
    const entries = exportsBySymbol.get(exp.symbolName) ?? [];
    entries.push(exp);
    exportsBySymbol.set(exp.symbolName, entries);
  }
  const resolveOwner = createRustBridgeIdentity(ctx);
  const routes = resolveRustFfiDispatch(rustFiles, resolveOwner);
  const dispatching = findRustDispatchingExports(rustFiles, resolveOwner);
  const routesByExport = new Map<string, RustFfiDispatchRoute[]>();
  for (const route of routes) {
    const entries = routesByExport.get(route.export.functionId) ?? [];
    entries.push(route);
    routesByExport.set(route.export.functionId, entries);
  }

  const sites: Site[] = [];
  const luaFiles = new Map<string, { analysis: LuaAnalysis; symbols: Map<number, Node> }>();
  const analyzeLuaFile = (file: string): void => {
    const { fileNode, source } = luaSources.get(file)!;
    const analysis = cachedLuaAnalysis(ctx, file, source, live);
    const nodes = ctx.getNodesInFile(file);
    const symbols = new Map<number, Node>();
    const byPosition = new Map(nodes.filter(callable).map(n => [`${n.startLine}:${n.startColumn}:${n.name}`, n]));
    for (const fn of analysis.functions) {
      const node = byPosition.get(`${fn.line}:${fn.column}:${fn.name.split(/[.:]/).pop()}`);
      if (node) symbols.set(fn.startIndex, node);
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
      if (target) {
        recordTarget(site, target.id);
      }
    }
    const addCarrier = (node: Node, channel: Channel): boolean => {
      const channels = carriers.get(node.id) ?? [];
      if (channels.some(c => c.native.id === channel.native.id && c.parameter === channel.parameter && c.routes === channel.routes)) return false;
      channels.push(channel);
      carriers.set(node.id, channels);
      carrierFiles.add(node.filePath);
      queue.push({ nodeId: node.id, channel });
      return true;
    };
    const link = (site: Site, native: Node, relevant: RustFfiDispatchRoute[], argumentIndex: number): boolean => {
      const argument = site.call.args[argumentIndex];
      if (!argument) return false;
      if (argument.parameterIndex !== undefined) {
        return addCarrier(site.source, { native, routes: relevant, parameter: argument.parameterIndex });
      }
      if (argument.kind !== 'string') return false;
      const matching = relevant.filter(r => r.operation === argument.value);
      const targets = [...new Set(matching.map(r => r.target.id))];
      if (targets.length !== 1) return false; // duplicate/ambiguous operation target
      const route = matching[0]!;
      const target = rustNode(ctx, route.target);
      if (!target) return false;
      const key = `${site.source.id}>${target.id}`;
      const operations = operationEdges.get(key)?.metadata?.operations as string[] | undefined;
      if (operations) {
        if (!operations.includes(route.operation)) operations.push(route.operation);
        return false;
      }
      operationEdges.set(key, { source: site.source.id, target: target.id, kind: 'calls', line: site.call.line,
        column: site.call.column, provenance: 'heuristic', metadata: {
          synthesizedBy: 'lua-rust-operation', operation: route.operation, operations: [route.operation],
          nativeExport: native.id, nativeSymbol: route.export.symbolName,
          registeredAt: `${route.dispatcher.filePath}:${route.dispatchLine}`,
          sourceCall: `${site.file}:${site.call.line}:${site.call.column}`,
          rustPath: route.callPath.map(f => `${f.filePath}:${f.line}`),
        } });
      return false;
    };
    for (const site of sites) {
      const symbol = site.call.ffiSymbol && linkedSymbol(site.call.ffiSymbol);
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
    const getterLinks = new Set<string>();
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const { nodeId, channel } = queue[cursor]!;
      for (const site of sitesByTarget.get(nodeId) ?? []) {
        // Proven getter/member calls also need this bridge wrapper's side calls.
        // Keep this pass scoped to wrappers that actually carry an FFI channel.
        // Only a static call already at the site makes the edge redundant: the
        // synthesized edges a re-index finds are the last pass's, and deferring
        // to them made a re-index differ from a fresh index.
        const key = `${site.source.id}:${nodeId}:${site.call.line}:${site.call.column}`;
        if (site.call.importedModule && site.call.callee.includes('(') && !getterLinks.has(key)) {
          getterLinks.add(key);
          const target = ctx.getNodeById?.(nodeId);
          if (target && !queries.getOutgoingEdges(site.source.id).some(e => e.kind === 'calls' && e.provenance !== 'heuristic' &&
            e.target === nodeId && e.line === site.call.line && e.column === site.call.column)) {
            edges.push({ source: site.source.id, target: nodeId, kind: 'calls', line: site.call.line,
              column: site.call.column, provenance: 'heuristic', metadata: { synthesizedBy: 'lua-module-member',
                registeredAt: `${target.filePath}:${target.startLine}` } });
          }
        }
        link(site, channel.native, channel.routes, channel.parameter);
      }
      if ((cursor & 127) === 0) await onYield();
    }
    for (const edge of operationEdges.values()) {
      const operations = (edge.metadata!.operations as string[]).sort();
      edge.metadata!.operation = operations[0];
    }
    return { edges: [...edges, ...operationEdges.values()], carrierFiles };
  };

  // A call reaches Rust only through an FFI receiver, which only a file holding
  // the literal "ffi" proves, or through a carrier, which only a file naming
  // the carrier's module (or defining it) calls. So the pass analyzes the files
  // holding "ffi", routes them, and then each round the files that name a
  // module a carrier was found in, until a round finds no new one; any other
  // Lua file could add no edge.
  let pending = [...luaSources].filter(([, { source }]) => FFI_LITERAL.test(source)).map(([file]) => file);
  const named = new Set<string>();
  let routed: { edges: Edge[]; carrierFiles: Set<string> };
  for (;;) {
    for (const file of pending) {
      analyzeLuaFile(file);
      await onYield();
    }
    routed = await route();
    const tails = [...routed.carrierFiles].map(moduleTail).filter(tail => !named.has(tail));
    tails.forEach(tail => named.add(tail));
    pending = tails.length === 0 ? [] : [...luaSources]
      .filter(([file, { source }]) => !luaFiles.has(file) && tails.some(tail => source.includes(tail)))
      .map(([file]) => file);
    if (pending.length === 0) break;
  }
  pruneStoredAnalyses(ctx, live);
  return routed.edges;
}
